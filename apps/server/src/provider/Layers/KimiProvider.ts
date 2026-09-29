import type { KimiSettings, ServerProvider, ServerProviderModel } from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

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
import { buildKimiModels } from "../KimiModels.ts";
import type * as AcpSchema from "effect-acp/compat";
import * as Crypto from "effect/Crypto";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import {
  isKimiAuthenticationRequired,
  probeKimiAcpAuthentication,
  type KimiAcpProbeResult,
} from "../acp/KimiAcpSupport.ts";

const KIMI_PRESENTATION = {
  displayName: "Kimi Code (supported)",
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
  configOptions: ReadonlyArray<AcpSchema.SessionConfigOption> = [],
): ReadonlyArray<ServerProviderModel> {
  return buildKimiModels(settings.customModels, configOptions);
}

export function buildInitialKimiProviderSnapshot(
  kimiSettings: KimiSettings,
  configOptions: ReadonlyArray<AcpSchema.SessionConfigOption> = [],
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const models = kimiModelsFromState(kimiSettings, configOptions);
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
  configOptions: Effect.Effect<ReadonlyArray<AcpSchema.SessionConfigOption>> = Effect.succeed([]),
  overrides?: KimiProviderStatusProbeOverrides,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | FileSystem.FileSystem | Path.Path
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const currentModelState = yield* configOptions;
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
