import {
  KIMI_DEFAULT_MODEL,
  type KimiSettings,
  type ProviderOptionSelection,
} from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpClient from "effect-acp/client";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  findKimiModelConfigOption,
  getKimiConfigOptionChoices,
  isKimiModeConfigOption,
} from "../KimiModelState.ts";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const KIMI_AUTH_METHOD_ID = "login";

type KimiAcpRuntimeSettings = Pick<KimiSettings, "binaryPath">;

export interface KimiAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly kimiSettings: KimiAcpRuntimeSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

export interface KimiAcpProbeResult {
  readonly initializeResult: EffectAcpSchema.InitializeResponse;
  readonly agentCapabilities: NonNullable<EffectAcpSchema.InitializeResponse["agentCapabilities"]>;
}

export interface KimiAcpModelSelectionErrorContext {
  readonly cause: EffectAcpErrors.AcpError;
  readonly step: "set-model" | "set-config-option";
  readonly configId?: string;
}

export function buildKimiAcpSpawnInput(
  kimiSettings: KimiAcpRuntimeSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: kimiSettings?.binaryPath || "kimi",
    args: ["acp"],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

export const makeKimiAcpRuntime = (
  input: KimiAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildKimiAcpSpawnInput(input.kimiSettings, input.cwd, input.environment),
        authMethodId: KIMI_AUTH_METHOD_ID,
        resumeMethod: "resume",
        gateMcpServersByCapabilities: true,
        // Kimi Code CLI 0.29 returns no `modes` field; its execution mode lives
        // in the `mode` configuration option instead.
        deriveModeStateFromConfigOptions: true,
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

/** Initialize and authenticate Kimi ACP without creating a native session. */
export const probeKimiAcpAuthentication = Effect.fn("probeKimiAcpAuthentication")(function* (
  kimiSettings: KimiAcpRuntimeSettings | null | undefined,
  environment: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): Effect.fn.Return<
  KimiAcpProbeResult,
  EffectAcpErrors.AcpError,
  ChildProcessSpawner.ChildProcessSpawner
> {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const spawn = buildKimiAcpSpawnInput(kimiSettings, cwd, environment);
      const resolved = yield* resolveSpawnCommand(spawn.command, spawn.args, {
        env: environment,
        extendEnv: true,
      });
      const child = yield* spawner
        .spawn(
          ChildProcess.make(resolved.command, resolved.args, {
            cwd,
            env: environment,
            extendEnv: true,
            shell: resolved.shell,
          }),
        )
        .pipe(
          Effect.mapError(
            (cause) => new EffectAcpErrors.AcpSpawnError({ command: spawn.command, cause }),
          ),
        );
      const clientContext = yield* Layer.build(EffectAcpClient.layerChildProcess(child));
      const acp = yield* Effect.service(EffectAcpClient.AcpClient).pipe(
        Effect.provide(clientContext),
      );
      const initializeResult = yield* acp.agent.initialize({
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
      });
      yield* acp.agent.authenticate({ methodId: KIMI_AUTH_METHOD_ID });
      return {
        initializeResult,
        agentCapabilities: initializeResult.agentCapabilities ?? {},
      } satisfies KimiAcpProbeResult;
    }),
  );
});

export function isKimiAuthenticationRequired(error: EffectAcpErrors.AcpError): boolean {
  return error._tag === "AcpRequestError" && error.code === -32_000;
}

interface KimiSelectionRuntime {
  readonly getConfigOptions: AcpSessionRuntime.AcpSessionRuntime["Service"]["getConfigOptions"];
  readonly setConfigOption: (
    configId: string,
    value: string | boolean,
  ) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
}

function invalidKimiSelection(message: string): EffectAcpErrors.AcpError {
  return EffectAcpErrors.AcpRequestError.invalidParams(message);
}

function configOptionAllowsValue(
  option: EffectAcpSchema.SessionConfigOption,
  value: string | boolean,
): boolean {
  return option.type === "boolean"
    ? typeof value === "boolean"
    : typeof value === "string" &&
        getKimiConfigOptionChoices(option).some((choice) => choice.value === value);
}

export function applyKimiAcpModelSelection<E>(input: {
  readonly runtime: KimiSelectionRuntime;
  readonly model: string | null | undefined;
  readonly selections: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  readonly mapError: (context: KimiAcpModelSelectionErrorContext) => E;
}): Effect.Effect<void, E> {
  return Effect.gen(function* () {
    let configOptions = yield* input.runtime.getConfigOptions;
    const model = input.model?.trim();
    const modelOption = findKimiModelConfigOption(configOptions);

    if (model && model !== KIMI_DEFAULT_MODEL) {
      if (!modelOption || !configOptionAllowsValue(modelOption, model)) {
        return yield* Effect.fail(
          input.mapError({
            cause: invalidKimiSelection(`Kimi model "${model}" is not available in this session.`),
            step: "set-model",
            ...(modelOption ? { configId: modelOption.id } : {}),
          }),
        );
      }
      yield* input.runtime
        .setConfigOption(modelOption.id, model)
        .pipe(
          Effect.mapError((cause) =>
            input.mapError({ cause, step: "set-model", configId: modelOption.id }),
          ),
        );
      // Model changes can replace Kimi's thinking and mode options.
      configOptions = yield* input.runtime.getConfigOptions;
    }

    for (const selection of input.selections ?? []) {
      if (selection.id === modelOption?.id) {
        continue;
      }
      const option = configOptions.find((candidate) => candidate.id === selection.id);
      // Kimi's `mode` option is its permission policy (default/plan/auto/yolo),
      // not a model trait. It is owned by the thread's runtime and interaction
      // mode, so a stored model-option selection must never move it — that
      // would let a persisted "yolo" silently disable approval prompts.
      if (option && isKimiModeConfigOption(option)) {
        continue;
      }
      if (!option || !configOptionAllowsValue(option, selection.value)) {
        return yield* Effect.fail(
          input.mapError({
            cause: invalidKimiSelection(
              `Kimi config option "${selection.id}" does not accept the requested value.`,
            ),
            step: "set-config-option",
            configId: selection.id,
          }),
        );
      }
      yield* input.runtime
        .setConfigOption(selection.id, selection.value)
        .pipe(
          Effect.mapError((cause) =>
            input.mapError({ cause, step: "set-config-option", configId: selection.id }),
          ),
        );
    }
  });
}
