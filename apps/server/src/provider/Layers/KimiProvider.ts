import type { KimiSettings, ServerProvider, ServerProviderModel } from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpErrors from "effect-acp/errors";

import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  spawnAndCollect,
  type CommandResult,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import {
  buildKimiModels,
  type KimiModelStateShape,
  type KimiModelStateSnapshot,
} from "../KimiModelState.ts";
import {
  isKimiAuthenticationRequired,
  probeKimiAcpAuthentication,
  type KimiAcpProbeResult,
} from "../acp/KimiAcpSupport.ts";

const KIMI_PRESENTATION = {
  displayName: "Kimi",
  badgeLabel: "Early Access",
  // Kimi exposes a native read-only plan mode ("Read-only planning; no tool
  // execution") through its `mode` config option, so the plan/implement toggle
  // maps onto a real capability.
  showInteractionModeToggle: true,
} as const;

const VERSION_PROBE_TIMEOUT_MS = 4_000;
const ACP_PROBE_TIMEOUT_MS = 15_000;

export interface KimiProviderStatusProbeOverrides {
  readonly runVersion?: () => Effect.Effect<CommandResult, unknown>;
  readonly probeAcp?: () => Effect.Effect<KimiAcpProbeResult, EffectAcpErrors.AcpError>;
}

function kimiModelsFromState(
  settings: Pick<KimiSettings, "customModels">,
  state?: KimiModelStateSnapshot,
): ReadonlyArray<ServerProviderModel> {
  return state?.models ?? buildKimiModels(settings.customModels);
}

export function buildInitialKimiProviderSnapshot(
  kimiSettings: KimiSettings,
  modelState?: KimiModelStateSnapshot,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const models = kimiModelsFromState(kimiSettings, modelState);
    if (!kimiSettings.enabled) {
      return buildServerProvider({
        presentation: KIMI_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Kimi is disabled in T3 Code settings.",
        },
      });
    }
    return buildServerProvider({
      presentation: KIMI_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Kimi Code CLI availability...",
      },
    });
  });
}

const runKimiVersionCommand = (
  kimiSettings: Pick<KimiSettings, "binaryPath">,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const command = kimiSettings.binaryPath || "kimi";
    const spawnCommand = yield* resolveSpawnCommand(command, ["--version"], {
      env: environment,
      extendEnv: true,
    });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        extendEnv: true,
        shell: spawnCommand.shell,
      }),
    );
  });

/**
 * T3 Code needs to reattach to a native session across server restarts. Kimi
 * offers two primitives for that — `session/resume` and `session/load` — and
 * the ACP runtime picks whichever the CLI advertises, so either one is enough.
 */
export function isKimiAcpCompatible(probe: KimiAcpProbeResult): boolean {
  return (
    probe.initializeResult.protocolVersion === 1 &&
    (probe.agentCapabilities.sessionCapabilities?.resume != null ||
      probe.agentCapabilities.loadSession === true)
  );
}

function makeKimiSnapshot(input: {
  readonly settings: KimiSettings;
  readonly checkedAt: string;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly installed: boolean;
  readonly version: string | null;
  readonly status: "ready" | "warning" | "error";
  readonly auth: ServerProvider["auth"];
  readonly message?: string;
}): ServerProviderDraft {
  return buildServerProvider({
    presentation: KIMI_PRESENTATION,
    enabled: input.settings.enabled,
    checkedAt: input.checkedAt,
    models: input.models,
    probe: {
      installed: input.installed,
      version: input.version,
      status: input.status,
      auth: input.auth,
      ...(input.message ? { message: input.message } : {}),
    },
  });
}

export const checkKimiProviderStatus = Effect.fn("checkKimiProviderStatus")(function* (
  kimiSettings: KimiSettings,
  environment: NodeJS.ProcessEnv = process.env,
  modelState?: KimiModelStateShape,
  overrides?: KimiProviderStatusProbeOverrides,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const currentModelState = modelState ? yield* modelState.getSnapshot : undefined;
  const models = kimiModelsFromState(kimiSettings, currentModelState);
  if (!kimiSettings.enabled) {
    return yield* buildInitialKimiProviderSnapshot(kimiSettings, currentModelState);
  }

  const versionResult = yield* (
    overrides?.runVersion?.() ?? runKimiVersionCommand(kimiSettings, environment)
  ).pipe(Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS), Effect.result);
  if (Result.isFailure(versionResult)) {
    const cause = versionResult.failure;
    yield* Effect.logWarning("Kimi Code CLI version probe failed", {
      errorTag:
        typeof cause === "object" && cause !== null && "_tag" in cause
          ? String(cause._tag)
          : "UnknownError",
    });
    return makeKimiSnapshot({
      settings: kimiSettings,
      checkedAt,
      models,
      installed: !isCommandMissingCause(cause),
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: isCommandMissingCause(cause)
        ? "Kimi Code CLI (`kimi`) is not installed or not on PATH. Install `@moonshot-ai/kimi-code` and refresh."
        : "Failed to execute the Kimi Code CLI version check.",
    });
  }
  if (Option.isNone(versionResult.success)) {
    return makeKimiSnapshot({
      settings: kimiSettings,
      checkedAt,
      models,
      installed: true,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: "Kimi Code CLI timed out while running `kimi --version`.",
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("Kimi Code CLI version probe exited with a non-zero status", {
      exitCode: versionOutput.code,
      stdoutLength: versionOutput.stdout.length,
      stderrLength: versionOutput.stderr.length,
    });
    return makeKimiSnapshot({
      settings: kimiSettings,
      checkedAt,
      models,
      installed: true,
      version,
      status: "error",
      auth: { status: "unknown" },
      message: "Kimi Code CLI is installed but failed to run.",
    });
  }

  const acpResult = yield* (
    overrides?.probeAcp?.() ?? probeKimiAcpAuthentication(kimiSettings, environment)
  ).pipe(Effect.timeoutOption(ACP_PROBE_TIMEOUT_MS), Effect.exit);
  if (Exit.isFailure(acpResult)) {
    const failure = Option.getOrUndefined(Exit.findErrorOption(acpResult));
    if (failure && isKimiAuthenticationRequired(failure)) {
      return makeKimiSnapshot({
        settings: kimiSettings,
        checkedAt,
        models,
        installed: true,
        version,
        status: "error",
        auth: { status: "unauthenticated" },
        message:
          "Kimi Code CLI is not authenticated. Run `kimi login` with the same `KIMI_CODE_HOME`, then refresh.",
      });
    }
    yield* Effect.logWarning("Kimi ACP compatibility probe failed", {
      errorTag: causeErrorTag(acpResult.cause),
    });
    return makeKimiSnapshot({
      settings: kimiSettings,
      checkedAt,
      models,
      installed: true,
      version,
      status: "error",
      auth: { status: "unknown" },
      message: "Kimi Code CLI is installed but its ACP runtime is incompatible or unavailable.",
    });
  }
  if (Option.isNone(acpResult.value)) {
    return makeKimiSnapshot({
      settings: kimiSettings,
      checkedAt,
      models,
      installed: true,
      version,
      status: "error",
      auth: { status: "unknown" },
      message: `Kimi ACP authentication timed out after ${ACP_PROBE_TIMEOUT_MS}ms.`,
    });
  }
  if (!isKimiAcpCompatible(acpResult.value.value)) {
    return makeKimiSnapshot({
      settings: kimiSettings,
      checkedAt,
      models,
      installed: true,
      version,
      status: "error",
      auth: { status: "authenticated" },
      message:
        "Kimi Code CLI authenticated, but this version does not advertise native ACP session resume.",
    });
  }

  return makeKimiSnapshot({
    settings: kimiSettings,
    checkedAt,
    models,
    installed: true,
    version,
    status: "ready",
    auth: { status: "authenticated" },
  });
});

export const enrichKimiSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly modelState: KimiModelStateShape;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly getSnapshot: Effect.Effect<ServerProvider>;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly stampIdentity?: (snapshot: ServerProvider) => ServerProvider;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> => {
  const stampIdentity = input.stampIdentity ?? ((snapshot) => snapshot);
  if (!input.snapshot.enabled) {
    return Effect.void;
  }

  const enrichVersion = enrichProviderSnapshotWithVersionAdvisory(
    input.snapshot,
    input.maintenanceCapabilities,
    { enableProviderUpdateChecks: input.enableProviderUpdateChecks },
  ).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((snapshot) => input.publishSnapshot(stampIdentity(snapshot))),
    Effect.catchCause((cause) =>
      Effect.logWarning("Kimi version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
  );

  const publishModelChanges = input.modelState.streamChanges.pipe(
    Stream.runForEach((state) =>
      input.getSnapshot.pipe(
        Effect.flatMap((current) =>
          current.status === "ready"
            ? input.publishSnapshot(stampIdentity({ ...current, models: state.models }))
            : Effect.void,
        ),
      ),
    ),
  );

  return Effect.all([enrichVersion, publishModelChanges], {
    concurrency: "unbounded",
    discard: true,
  });
};
