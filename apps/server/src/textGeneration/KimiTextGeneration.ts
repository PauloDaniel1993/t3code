import { KimiSettings, TextGenerationError } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";

import { applyKimiAcpModelSelection, makeKimiAcpRuntime } from "../provider/acp/KimiAcpSupport.ts";
import {
  makeJsonTextGeneration,
  type JsonTextGenerationRunOptions,
} from "./TextGenerationShared.ts";

const KIMI_TEXT_GENERATION_TIMEOUT_MS = 180_000;
/** Kimi's read-only mode: "Read-only planning; no tool execution." */
const KIMI_READ_ONLY_MODE_ID = "plan";
const isTextGenerationError = Schema.is(TextGenerationError);

export interface KimiTextGenerationOptions {
  readonly timeoutMs?: number;
}

/**
 * Build Kimi-backed auxiliary generation. Each attempt owns a fresh ACP
 * subprocess and native session so hidden prompts never contaminate a thread.
 * Kimi currently has no session/delete method, so the upstream native session
 * record may remain after the scoped subprocess is released.
 */
export const makeKimiTextGeneration = Effect.fn("makeKimiTextGeneration")(function* (
  kimiSettings: KimiSettings,
  environment: NodeJS.ProcessEnv = process.env,
  options: KimiTextGenerationOptions = {},
) {
  const crypto = yield* Crypto.Crypto;
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const runRaw = (
    prompt: string,
    runOptions: JsonTextGenerationRunOptions,
  ): Effect.Effect<string, TextGenerationError> =>
    Effect.gen(function* () {
      const outputRef = yield* Ref.make("");
      const runtime = yield* makeKimiAcpRuntime({
        kimiSettings,
        environment,
        childProcessSpawner,
        cwd: runOptions.cwd,
        clientInfo: { name: "t3-code-git-text", version: "0.0.0" },
      }).pipe(Effect.provideService(Crypto.Crypto, crypto));

      // Auxiliary generation is a single hidden prompt over text the caller
      // already supplied; it must never run tools. Kimi's `plan` mode is
      // read-only, and the deny-all handlers keep an unexpected request from
      // failing as `methodNotFound` or stalling until the timeout.
      yield* runtime.handleRequestPermission(() =>
        Effect.succeed({ outcome: { outcome: "cancelled" as const } }),
      );
      yield* runtime.handleElicitation(() =>
        Effect.succeed({ action: { action: "cancel" as const } }),
      );

      yield* runtime.handleSessionUpdate((notification) => {
        const update = notification.update;
        if (update.sessionUpdate !== "agent_message_chunk") {
          return Effect.void;
        }
        const content = update.content;
        if (content.type !== "text") {
          return Effect.void;
        }
        return Ref.update(outputRef, (current) => current + content.text);
      });

      const promptResult = yield* Effect.gen(function* () {
        yield* runtime.start();
        yield* Effect.ignore(runtime.setMode(KIMI_READ_ONLY_MODE_ID));
        yield* applyKimiAcpModelSelection({
          runtime,
          model: runOptions.modelSelection.model,
          selections: runOptions.modelSelection.options,
          mapError: ({ cause, configId, step }) =>
            new TextGenerationError({
              operation: runOptions.operation,
              detail:
                step === "set-model"
                  ? "Failed to select the requested Kimi model for text generation."
                  : `Failed to set Kimi ACP config option "${configId}" for text generation.`,
              cause,
            }),
        });
        return yield* runtime.prompt({ prompt: [{ type: "text", text: prompt }] });
      }).pipe(
        Effect.mapError((cause) =>
          isTextGenerationError(cause)
            ? cause
            : new TextGenerationError({
                operation: runOptions.operation,
                detail: "Kimi ACP request failed.",
                cause,
              }),
        ),
      );

      const output = (yield* Ref.get(outputRef)).trim();
      if (!output) {
        return yield* new TextGenerationError({
          operation: runOptions.operation,
          detail:
            promptResult.stopReason === "cancelled"
              ? "Kimi ACP request was cancelled."
              : "Kimi Code CLI returned empty output.",
        });
      }
      return output;
    }).pipe(
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : new TextGenerationError({
              operation: runOptions.operation,
              detail: "Kimi ACP text generation failed.",
              cause,
            }),
      ),
      Effect.scoped,
    );

  return makeJsonTextGeneration({
    providerLabel: "Kimi Code CLI",
    defaultTimeoutMs: options.timeoutMs ?? KIMI_TEXT_GENERATION_TIMEOUT_MS,
    runRaw,
  });
});
