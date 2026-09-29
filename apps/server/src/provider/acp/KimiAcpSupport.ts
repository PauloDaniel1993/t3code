import { KIMI_DEFAULT_MODEL, type KimiSettings } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as AcpErrors from "effect-acp/errors";
import type * as AcpSchema from "effect-acp/compat";

import {
  isKimiModeConfigOption,
  isKimiModelConfigOption,
  kimiConfigChoices,
  normalizeKimiConfigOptions,
} from "../KimiModels.ts";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import { parseSessionModeState } from "./AcpRuntimeModel.ts";
import { makeProviderFailure } from "../../orchestration-v2/ProviderFailure.ts";
import { captureKimiAcpLogCheckpoint, readKimiAcpFailureSince } from "./KimiAcpDiagnostics.ts";
import {
  normalizeKimiPermissionRequest,
  KIMI_SUBAGENT_SUPERVISION_GUIDANCE,
} from "./KimiProtocol.ts";

export interface KimiAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "spawn" | "authMethodId" | "resumeMethod" | "authenticateEagerly"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly kimiSettings: Pick<KimiSettings, "binaryPath">;
  readonly environment: NodeJS.ProcessEnv;
  readonly supervisionGuidance?: boolean;
  readonly agentDeviceEnvironment?: Readonly<Record<string, string>>;
}

export function buildKimiAcpSpawnInput(
  settings: Pick<KimiSettings, "binaryPath">,
  cwd: string,
  environment: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return { command: settings.binaryPath || "kimi", args: ["acp"], cwd, env: environment };
}

export function isKimiAuthenticationRequired(error: AcpErrors.AcpError) {
  return error._tag === "AcpRequestError" && error.code === -32000;
}

export function isKimiAcpCompatible(initialized: AcpSchema.InitializeResponse) {
  return (
    initialized.protocolVersion === 1 &&
    (initialized.agentCapabilities?.sessionCapabilities?.resume != null ||
      initialized.agentCapabilities?.loadSession === true)
  );
}

export type KimiAcpProbeResult = AcpSchema.InitializeResponse;

/** Validate existing login without creating a native session or starting workspace MCP servers. */
export const probeKimiAcpAuthentication = Effect.fn("probeKimiAcpAuthentication")(function* (
  kimiSettings: Pick<KimiSettings, "binaryPath">,
  environment: NodeJS.ProcessEnv,
  cwd = process.cwd(),
) {
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const runtime = yield* makeKimiAcpRuntime({
        kimiSettings,
        environment,
        cwd,
        childProcessSpawner,
        clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      });
      const initialized = yield* runtime.initialize();
      yield* runtime.authenticate!("login");
      return initialized;
    }),
  );
});

export const applyKimiAcpModelSelection = Effect.fn("applyKimiAcpModelSelection")(
  function* (input: {
    readonly runtime: Pick<
      AcpSessionRuntime.AcpSessionRuntime["Service"],
      "getConfigOptions" | "setModel"
    >;
    readonly model: string;
  }) {
    const options = yield* input.runtime.getConfigOptions;
    const option = options.find(isKimiModelConfigOption);
    if (input.model === KIMI_DEFAULT_MODEL || input.model === "default") {
      return option?.type === "select" ? option.currentValue : undefined;
    }
    if (!option || !kimiConfigChoices(option).some((choice) => choice.value === input.model)) {
      return yield* AcpErrors.AcpRequestError.invalidParams(
        `Kimi model "${input.model}" is not available in this session.`,
      );
    }
    yield* input.runtime.setModel(input.model);
    return input.model;
  },
);

const AUTONOMOUS_MODES = new Set(["auto", "yolo", "bypass", "danger"]);
const PLAN_MODES = ["plan", "architect"];
const SUPERVISED_MODES = ["default", "code", "agent", "chat", "implement", "ask"];

/** Runtime policy owns mode; even full access keeps permission callbacks visible to T3. */
export const setKimiSupervisedMode = Effect.fn("setKimiSupervisedMode")(function* (
  runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "getModeState" | "setMode">,
  requested: string,
) {
  const state = yield* runtime.getModeState;
  if (!state) return {};
  const plan = PLAN_MODES.includes(requested);
  const safe = state.availableModes.filter(
    (mode) =>
      !AUTONOMOUS_MODES.has(mode.id.toLowerCase()) &&
      !AUTONOMOUS_MODES.has(mode.name.toLowerCase()) &&
      (plan || !PLAN_MODES.includes(mode.id.toLowerCase())),
  );
  const aliases = plan
    ? PLAN_MODES
    : requested === "ask"
      ? ["ask", ...SUPERVISED_MODES]
      : SUPERVISED_MODES;
  const mode =
    aliases.flatMap((alias) =>
      safe.filter((mode) => mode.id.toLowerCase() === alias || mode.name.toLowerCase() === alias),
    )[0] ?? (!plan ? safe[0] : undefined);
  if (!mode)
    return yield* AcpErrors.AcpRequestError.invalidParams(
      "Kimi does not advertise a supervised mode for this request.",
    );
  return yield* runtime.setMode(mode.id);
});

const normalizeStarted = (started: AcpSessionRuntime.AcpSessionRuntimeStartResult) => ({
  ...started,
  sessionSetupResult: {
    ...started.sessionSetupResult,
    configOptions: normalizeKimiConfigOptions(started.sessionSetupResult.configOptions ?? []),
  },
});

/** Wrap only Kimi's protocol quirks; V2 retains queues, callbacks and subprocess ownership. */
export const makeKimiAcpRuntime = Effect.fn("makeKimiAcpRuntime")(function* (
  input: KimiAcpRuntimeInput,
): Effect.fn.Return<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  AcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope | FileSystem.FileSystem | Path.Path
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runtimeOptions = {
    ...input,
    spawn: buildKimiAcpSpawnInput(input.kimiSettings, input.cwd, input.environment),
    authMethodId: "login",
    authenticateEagerly: true,
    resumeMethod: "resume" as "load" | "resume",
    onInitialized: (initialized: AcpSchema.InitializeResponse) =>
      Effect.gen(function* () {
        if (!isKimiAcpCompatible(initialized)) {
          // initialize observers cannot fail; start validates compatibility below.
          return;
        }
        // V2's startup reads this after initialize. Prefer resume, falling back
        // to load for Kimi versions that advertise only loadSession.
        runtimeOptions.resumeMethod =
          initialized.agentCapabilities?.sessionCapabilities?.resume != null ? "resume" : "load";
        yield* input.onInitialized?.(initialized) ?? Effect.void;
      }),
    transformSessionUpdate: (notification: AcpSchema.SessionNotification) => {
      const transformed = input.transformSessionUpdate?.(notification) ?? notification;
      return transformed.update.sessionUpdate === "config_option_update"
        ? {
            ...transformed,
            update: {
              ...transformed.update,
              configOptions: normalizeKimiConfigOptions(transformed.update.configOptions),
            },
          }
        : transformed;
    },
  } satisfies AcpSessionRuntime.AcpSessionRuntimeOptions;
  const context = yield* Layer.build(
    AcpSessionRuntime.layer(runtimeOptions).pipe(
      Layer.provide(
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
      ),
    ),
  );
  const runtime = yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
    Effect.provide(context),
  );
  const initialize = Effect.fn("KimiAcpRuntime.initialize")(function* () {
    const initialized = yield* runtime.initialize();
    if (!isKimiAcpCompatible(initialized))
      return yield* AcpErrors.AcpRequestError.invalidParams(
        "Kimi Code requires ACP protocol 1 and native session resume or load support.",
      );
    return initialized;
  });
  const getConfigOptions = runtime.getConfigOptions.pipe(Effect.map(normalizeKimiConfigOptions));
  const getModeState = Effect.gen(function* () {
    return (
      parseSessionModeState({ configOptions: yield* getConfigOptions }) ??
      (yield* runtime.getModeState)
    );
  });
  const policyRuntime = {
    getModeState,
    setMode: (modeId: string) =>
      Effect.gen(function* () {
        const modeConfig = (yield* getConfigOptions).find(isKimiModeConfigOption);
        if (modeConfig) {
          yield* runtime.setConfigOption(modeConfig.id, modeId);
          return {};
        }
        return yield* runtime.setMode(modeId);
      }),
  };
  return {
    ...runtime,
    initialize,
    start: () => initialize().pipe(Effect.andThen(runtime.start()), Effect.map(normalizeStarted)),
    loadSession: (sessionId, options) =>
      initialize().pipe(
        // V2 also calls loadSession when switching an already-open thread.
        // Kimi must retain native resume semantics on that path too.
        Effect.flatMap((initialized) =>
          initialized.agentCapabilities?.sessionCapabilities?.resume != null
            ? runtime.resumeSession(sessionId, options)
            : runtime.loadSession(sessionId, options),
        ),
        Effect.map(normalizeStarted),
      ),
    resumeSession: (sessionId, options) =>
      initialize().pipe(
        Effect.andThen(runtime.resumeSession(sessionId, options)),
        Effect.map(normalizeStarted),
      ),
    getConfigOptions,
    getModeState,
    setModel: (model) =>
      Effect.gen(function* () {
        const option = (yield* getConfigOptions).find(isKimiModelConfigOption);
        if (!option || !kimiConfigChoices(option).some((choice) => choice.value === model)) {
          return yield* AcpErrors.AcpRequestError.invalidParams(
            `Kimi model "${model}" is not available in this session.`,
          );
        }
        yield* runtime.setConfigOption(option.id, model);
      }),
    // Stored model options cannot turn on autonomous approval, including the
    // generic adapter's synthetic session-mode option. setMode owns policy.
    setConfigOption: (id, value) =>
      Effect.gen(function* () {
        const options = yield* runtime.getConfigOptions;
        const option = options.find((option) => option.id === id);
        if (
          id === "mode" ||
          id === "_t3/session-mode" ||
          (option && (isKimiModeConfigOption(option) || isKimiModelConfigOption(option)))
        )
          return { configOptions: options };
        return yield* runtime.setConfigOption(id, value);
      }),
    setMode: (requested) =>
      AUTONOMOUS_MODES.has(requested.toLowerCase())
        ? Effect.succeed({})
        : setKimiSupervisedMode(policyRuntime, requested),
    handleRequestPermission: (handler) =>
      runtime.handleRequestPermission((request, context) =>
        handler(normalizeKimiPermissionRequest(request), context),
      ),
    prompt: (payload, options) =>
      Effect.gen(function* () {
        const started = yield* runtime.start();
        const checkpoint = yield* captureKimiAcpLogCheckpoint({
          sessionId: started.sessionId,
          environment: input.environment,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        );
        const prompt =
          input.supervisionGuidance === false
            ? payload.prompt
            : [
                { type: "text" as const, text: KIMI_SUBAGENT_SUPERVISION_GUIDANCE },
                ...payload.prompt,
              ];
        const result = yield* runtime.prompt({ ...payload, prompt }, options).pipe(Effect.exit);
        const failure =
          Exit.isSuccess(result) && result.value.stopReason === "cancelled"
            ? undefined
            : yield* readKimiAcpFailureSince(checkpoint).pipe(
                Effect.provideService(FileSystem.FileSystem, fileSystem),
              );
        if (failure) {
          const safe = makeProviderFailure({ ...failure, class: "provider_error" });
          return yield* new AcpErrors.AcpRequestError({
            code: -32603,
            errorMessage: safe.message,
            data: {
              kimiFailure: {
                message: safe.message,
                ...(safe.code === null ? {} : { code: safe.code }),
                ...(safe.retryable === null ? {} : { retryable: safe.retryable }),
              },
            },
          });
        }
        return yield* result;
      }),
  } satisfies AcpSessionRuntime.AcpSessionRuntime["Service"];
});
