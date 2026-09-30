import { TextGenerationError, type ModelSelection } from "@t3tools/contracts";
import { formatGeneratedBranchName, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as AcpErrors from "effect-acp/errors";

import { applyKimiAcpModelSelection } from "../provider/acp/KimiAcpSupport.ts";
import type { AcpSessionRuntime } from "../provider/acp/AcpSessionRuntime.ts";
import type * as TextGeneration from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";

export interface KimiTextGenerationOptions {
  readonly makeRuntime: (
    cwd: string,
  ) => Effect.Effect<AcpSessionRuntime["Service"], AcpErrors.AcpError, Scope.Scope>;
}

const isTextGenerationError = Schema.is(TextGenerationError);
const MAX_OUTPUT_CHARS = 128_000;

/** Fresh read-only sessions keep auxiliary prompts and tool work out of user threads. */
export const makeKimiTextGeneration = Effect.fn("makeKimiTextGeneration")(function* (
  options: KimiTextGenerationOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const runJson = Effect.fn("KimiTextGeneration.runJson")(
    function* <S extends Schema.Top>(input: {
      readonly operation: keyof TextGeneration.TextGeneration["Service"];
      readonly prompt: string;
      readonly outputSchema: S;
      readonly modelSelection: ModelSelection;
    }) {
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-kimi-text-" });
      const runtime = yield* options.makeRuntime(cwd);
      yield* runtime.getEvents().pipe(
        Stream.runForEach((event) =>
          event._tag === "EventStreamBarrier"
            ? Deferred.succeed(event.acknowledge, undefined).pipe(Effect.asVoid)
            : Effect.void,
        ),
        Effect.forkScoped,
      );
      const output = yield* Ref.make("");
      const rejected = yield* Deferred.make<never, TextGenerationError>();
      const reject = (detail: string) =>
        Deferred.fail(
          rejected,
          new TextGenerationError({ operation: input.operation, detail }),
        ).pipe(Effect.asVoid);
      const rejectTool = () =>
        reject("Kimi text generation requested a tool or user input.").pipe(
          Effect.andThen(
            Effect.fail(
              AcpErrors.AcpRequestError.methodNotFound("Tools are disabled for text generation."),
            ),
          ),
        );
      yield* runtime.handleRequestPermission(() =>
        reject("Kimi text generation requested permission.").pipe(
          Effect.as({ outcome: { outcome: "cancelled" as const } }),
        ),
      );
      yield* runtime.handleElicitation(() =>
        reject("Kimi text generation requested user input.").pipe(
          Effect.as({ action: "decline" as const }),
        ),
      );
      yield* runtime.handleReadTextFile(rejectTool);
      yield* runtime.handleWriteTextFile(rejectTool);
      yield* runtime.handleCreateTerminal(rejectTool);
      yield* runtime.handleTerminalOutput(rejectTool);
      yield* runtime.handleTerminalWaitForExit(rejectTool);
      yield* runtime.handleTerminalKill(rejectTool);
      yield* runtime.handleTerminalRelease(rejectTool);
      yield* runtime.handleUnknownExtRequest(rejectTool);
      yield* runtime.handleMcpConnect(rejectTool);
      yield* runtime.handleMcpMessage(rejectTool);
      yield* runtime.handleMcpDisconnect(rejectTool);
      let sessionId: string | undefined;
      yield* runtime.handleSessionUpdate((notification) =>
        Effect.gen(function* () {
          if (notification.sessionId !== sessionId) return;
          const update = notification.update;
          if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
            return yield* reject("Kimi attempted tool work during text generation.");
          }
          if (update.sessionUpdate !== "agent_message_chunk" || update.content.type !== "text")
            return;
          const text = update.content.text;
          const exceeded = yield* Ref.modify(output, (current) =>
            current.length + text.length > MAX_OUTPUT_CHARS
              ? [true, current]
              : [false, current + text],
          );
          if (exceeded) yield* reject("Kimi text generation exceeded the output limit.");
        }),
      );
      const result = yield* Effect.gen(function* () {
        sessionId = (yield* runtime.start()).sessionId;
        yield* applyKimiAcpModelSelection({ runtime, model: input.modelSelection.model });
        for (const option of input.modelSelection.options ?? []) {
          yield* runtime.setConfigOption(option.id, option.value);
        }
        // Model configuration can replace modes. Fail closed if read-only mode
        // is unavailable; the fork used to ignore a rejected plan-mode write.
        yield* runtime.setMode("plan");
        const mode = (yield* runtime.getModeState)?.currentModeId;
        if (mode !== "plan" && mode !== "architect") {
          return yield* new TextGenerationError({
            operation: input.operation,
            detail: "Kimi text generation requires a native read-only plan mode.",
          });
        }
        const response = yield* runtime.prompt({
          prompt: [
            {
              type: "text",
              text: [
                "Use only the input below. Do not use tools, read or write files, run commands, or ask questions.",
                "Return only the requested JSON object.",
                "",
                input.prompt,
              ].join("\n"),
            },
          ],
        });
        yield* runtime.drainEvents;
        if (yield* Deferred.isDone(rejected)) return yield* Deferred.await(rejected);
        if (response.stopReason === "cancelled")
          return yield* new TextGenerationError({
            operation: input.operation,
            detail: "Kimi text generation was cancelled.",
          });
        return yield* Ref.get(output);
      }).pipe(
        Effect.raceFirst(Deferred.await(rejected)),
        Effect.onInterrupt(() => runtime.cancel.pipe(Effect.timeoutOption(2_000), Effect.ignore)),
      );
      if ((yield* fs.readDirectory(cwd)).length > 0)
        return yield* new TextGenerationError({
          operation: input.operation,
          detail: "Kimi wrote files during text generation.",
        });
      if (!result.trim())
        return yield* new TextGenerationError({
          operation: input.operation,
          detail: "Kimi Code CLI returned empty output.",
        });
      // oxlint-disable-next-line t3code/no-inline-schema-compile -- The prompt builder supplies a different schema per operation.
      return yield* Schema.decodeEffect(Schema.fromJsonString(input.outputSchema))(
        extractJsonObject(result),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: input.operation,
              detail: "Kimi Code CLI returned invalid structured output.",
              cause,
            }),
        ),
      );
    },
    (effect, input) =>
      effect.pipe(
        Effect.scoped,
        Effect.timeoutOption("180 seconds"),
        Effect.flatMap(
          Option.match({
            onSome: Effect.succeed,
            onNone: () =>
              Effect.fail(
                new TextGenerationError({
                  operation: input.operation,
                  detail: "Kimi text generation timed out.",
                }),
              ),
          }),
        ),
        Effect.mapError((cause) =>
          isTextGenerationError(cause)
            ? cause
            : new TextGenerationError({
                operation: input.operation,
                detail: "Kimi ACP text generation failed.",
                cause,
              }),
        ),
      ),
  );

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("KimiTextGeneration.generateCommitMessage")(function* (input) {
      const generated = yield* runJson({
        operation: "generateCommitMessage",
        ...buildCommitMessagePrompt({
          branch: input.branch,
          stagedSummary: input.stagedSummary,
          stagedPatch: input.stagedPatch,
          includeBranch: input.includeBranch === true,
          policy: input.policy,
        }),
        modelSelection: input.modelSelection,
      });
      return {
        subject: sanitizeCommitSubject(generated.subject),
        body: generated.body.trim(),
        ...("branch" in generated && typeof generated.branch === "string"
          ? { branch: sanitizeFeatureBranchName(generated.branch) }
          : {}),
      };
    });
  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] =
    Effect.fn("KimiTextGeneration.generatePrContent")(function* (input) {
      const generated = yield* runJson({
        operation: "generatePrContent",
        ...buildPrContentPrompt({
          baseBranch: input.baseBranch,
          headBranch: input.headBranch,
          commitSummary: input.commitSummary,
          diffSummary: input.diffSummary,
          diffPatch: input.diffPatch,
          policy: input.policy,
          changeRequestTemplate: input.changeRequestTemplate,
        }),
        modelSelection: input.modelSelection,
      });
      return { title: sanitizePrTitle(generated.title), body: generated.body.trim() };
    });
  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn("KimiTextGeneration.generateBranchName")(function* (input) {
      const generated = yield* runJson({
        operation: "generateBranchName",
        ...buildBranchNamePrompt({
          message: input.message,
          attachments: input.attachments,
          naming: input.naming,
        }),
        modelSelection: input.modelSelection,
      });
      return { branch: formatGeneratedBranchName(generated.branch, input.naming) };
    });
  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("KimiTextGeneration.generateThreadTitle")(function* (input) {
      const generated = yield* runJson({
        operation: "generateThreadTitle",
        ...buildThreadTitlePrompt({
          message: input.message,
          previousTitle: input.previousTitle,
          linkedContext: input.linkedContext,
          attachments: input.attachments,
        }),
        modelSelection: input.modelSelection,
      });
      return {
        title: sanitizeThreadTitle(generated.title),
        ...(generated.needsRefinement ? { needsRefinement: true } : {}),
      };
    });
  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGeneration.TextGeneration["Service"];
});
