/**
 * KimiAdapterLive — Kimi CLI (`agent acp`) via ACP.
 *
 * @module KimiAdapterLive
 */

import {
  ApprovalRequestId,
  type ChatAttachment,
  KIMI_DEFAULT_MODEL,
  type KimiSettings,
  type ProviderOptionSelection,
  EventId,
  type ProviderApprovalDecision,
  type ProviderInteractionMode,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  type UserInputQuestion,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  type RuntimeMode,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { ServerConfig } from "../../config.ts";
import { mapAcpAttachments } from "../acpAttachments.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import type * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import {
  type AcpPermissionRequest,
  type AcpSessionMode,
  type AcpSessionModeState,
  parsePermissionRequest,
} from "../acp/AcpRuntimeModel.ts";
import { captureKimiAcpLogCheckpoint, readKimiAcpFailureSince } from "../acp/KimiAcpDiagnostics.ts";
import { makeAcpNativeLoggerFactory } from "../acp/AcpNativeLogging.ts";
import { applyKimiAcpModelSelection, makeKimiAcpRuntime } from "../acp/KimiAcpSupport.ts";
import { findKimiModelConfigOption, type KimiModelStateShape } from "../KimiModelState.ts";
import { type KimiAdapterShape } from "../Services/KimiAdapter.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
const encodeUnknownJsonStringExit = Schema.encodeUnknownExit(Schema.UnknownFromJsonString);

const PROVIDER = ProviderDriverKind.make("kimi");
const KIMI_RESUME_VERSION = 1 as const;
const ACP_PLAN_MODE_ALIASES = ["plan", "architect"];
const ACP_IMPLEMENT_MODE_ALIASES = ["code", "agent", "default", "chat", "implement"];
const ACP_APPROVAL_MODE_ALIASES = ["ask"];
const KIMI_ACP_SUBAGENT_SUPERVISION_GUIDANCE = `<t3-subagent-supervision>
You may use Agent or AgentSwarm subagents. In this ACP client, autonomous background-agent replies are not visible to the user. If the current request depends on a subagent result, omit run_in_background so it runs in the foreground; independent foreground Agent calls or one AgentSwarm may run concurrently. Receive and synthesize all required delegated results before ending this turn. First report any completed background-task notifications or results already present in session context before doing unrelated status work. After tool use, always finish with a user-facing response.
</t3-subagent-supervision>`;

function encodeJsonStringForDiagnostics(input: unknown): string | undefined {
  const result = encodeUnknownJsonStringExit(input);
  return Exit.isSuccess(result) ? result.value : undefined;
}

export interface KimiAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  /**
   * Selections are honored when `modelSelection.instanceId` matches this value.
   * Defaults to the legacy built-in instance id (`kimi`).
   */
  readonly instanceId?: ProviderInstanceId;
  /** Shared per-instance model/config state populated by real ACP sessions. */
  readonly modelState?: KimiModelStateShape;
  /**
   * Optional per-session settings resolver. When provided the adapter yields
   * this effect at the start of every session and uses the result instead of
   * the `kimiSettings` captured at construction.
   *
   * Production instances bind settings to the instance scope (the hydration
   * layer rebuilds the adapter on config change) and leave this undefined.
   * Test suites that mutate `ServerSettingsService` mid-flight — e.g. to
   * swap `binaryPath` to a mock ACP wrapper — pass a resolver that reads
   * the latest snapshot so the closure isn't stale.
   */
  readonly resolveSettings?: Effect.Effect<KimiSettings>;
}

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
  readonly kind: string | "unknown";
}

interface PendingUserInput {
  readonly answers: Deferred.Deferred<ProviderUserInputAnswers | undefined>;
}

interface KimiSessionContext {
  readonly threadId: ThreadId;
  readonly acpSessionId: string;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: AcpSessionRuntime.AcpSessionRuntime["Service"];
  notificationFiber: Fiber.Fiber<void, never> | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  readonly interruptedTurnIds: Set<TurnId>;
  lastPlanFingerprint: string | undefined;
  activeTurnId: TurnId | undefined;
  readonly imagePromptSupported: boolean;
  stopped: boolean;
}

function settlePendingApprovalsAsCancelled(
  pendingApprovals: ReadonlyMap<ApprovalRequestId, PendingApproval>,
): Effect.Effect<void> {
  const pendingEntries = Array.from(pendingApprovals.values());
  return Effect.forEach(
    pendingEntries,
    (pending) => Deferred.succeed(pending.decision, "cancel").pipe(Effect.ignore),
    {
      discard: true,
    },
  );
}

function settlePendingUserInputsAsEmptyAnswers(
  pendingUserInputs: ReadonlyMap<ApprovalRequestId, PendingUserInput>,
): Effect.Effect<void> {
  const pendingEntries = Array.from(pendingUserInputs.values());
  return Effect.forEach(
    pendingEntries,
    (pending) => Deferred.succeed(pending.answers, undefined).pipe(Effect.ignore),
    {
      discard: true,
    },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseKimiResume(
  raw: unknown,
): { instanceId: ProviderInstanceId; sessionId: string } | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion !== KIMI_RESUME_VERSION) return undefined;
  if (typeof raw.instanceId !== "string" || !raw.instanceId.trim()) return undefined;
  if (typeof raw.sessionId !== "string" || !raw.sessionId.trim()) return undefined;
  return {
    instanceId: ProviderInstanceId.make(raw.instanceId.trim()),
    sessionId: raw.sessionId.trim(),
  };
}

function elicitationOptions(
  property: EffectAcpSchema.ElicitationPropertySchema,
): ReadonlyArray<{ readonly label: string; readonly description: string }> {
  if (property.type === "string") {
    if (property.oneOf) {
      return property.oneOf.map((option) => ({
        label: option.title?.trim() || option.const,
        description: option.title?.trim() || option.const,
      }));
    }
    return (property.enum ?? []).map((value) => ({ label: value, description: value }));
  }
  if (property.type === "array") {
    const values =
      "enum" in property.items
        ? property.items.enum.map((value) => ({ value, title: value }))
        : property.items.anyOf.map((value) => ({ value: value.const, title: value.title }));
    return values.map((value) => ({
      label: value.title?.trim() || value.value,
      description: value.title?.trim() || value.value,
    }));
  }
  if (property.type === "boolean") {
    return [
      { label: "Yes", description: "Yes" },
      { label: "No", description: "No" },
    ];
  }
  return [];
}

export function kimiElicitationQuestions(
  request: EffectAcpSchema.ElicitationRequest,
): ReadonlyArray<UserInputQuestion> {
  if (request.mode === "url") {
    return [
      {
        id: request.elicitationId,
        header: "Kimi",
        question: request.message,
        options: [{ label: request.url, description: request.url }],
        multiSelect: false,
      },
    ];
  }
  const properties = request.requestedSchema.properties ?? {};
  return Object.entries(properties).map(([id, property]) => ({
    id,
    header: property.title?.trim() || request.requestedSchema.title?.trim() || "Kimi",
    question: property.description?.trim() || request.message,
    options: elicitationOptions(property),
    multiSelect: property.type === "array",
  }));
}

function isElicitationContentValue(
  value: unknown,
): value is string | number | boolean | ReadonlyArray<string> {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    (Array.isArray(value) && value.every((item) => typeof item === "string"))
  );
}

function kimiElicitationContent(
  answers: ProviderUserInputAnswers,
): Record<string, string | number | boolean | ReadonlyArray<string>> {
  return Object.fromEntries(
    Object.entries(answers).filter(
      (entry): entry is [string, string | number | boolean | string[]] =>
        isElicitationContentValue(entry[1]),
    ),
  );
}

function normalizeModeSearchText(mode: AcpSessionMode): string {
  return [mode.id, mode.name, mode.description]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function findModeByAliases(
  modes: ReadonlyArray<AcpSessionMode>,
  aliases: ReadonlyArray<string>,
): AcpSessionMode | undefined {
  const normalizedAliases = aliases.map((alias) => alias.toLowerCase());
  for (const alias of normalizedAliases) {
    const exact = modes.find((mode) => {
      const id = mode.id.toLowerCase();
      const name = mode.name.toLowerCase();
      return id === alias || name === alias;
    });
    if (exact) {
      return exact;
    }
  }
  for (const alias of normalizedAliases) {
    const partial = modes.find((mode) => normalizeModeSearchText(mode).includes(alias));
    if (partial) {
      return partial;
    }
  }
  return undefined;
}

function isPlanMode(mode: AcpSessionMode): boolean {
  return findModeByAliases([mode], ACP_PLAN_MODE_ALIASES) !== undefined;
}

function resolveRequestedModeId(input: {
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly runtimeMode: RuntimeMode;
  readonly modeState: AcpSessionModeState | undefined;
}): string | undefined {
  const modeState = input.modeState;
  if (!modeState) {
    return undefined;
  }

  if (input.interactionMode === "plan") {
    return findModeByAliases(modeState.availableModes, ACP_PLAN_MODE_ALIASES)?.id;
  }

  if (input.runtimeMode === "approval-required") {
    return (
      findModeByAliases(modeState.availableModes, ACP_APPROVAL_MODE_ALIASES)?.id ??
      findModeByAliases(modeState.availableModes, ACP_IMPLEMENT_MODE_ALIASES)?.id ??
      modeState.availableModes.find((mode) => !isPlanMode(mode))?.id ??
      modeState.currentModeId
    );
  }

  return (
    findModeByAliases(modeState.availableModes, ACP_IMPLEMENT_MODE_ALIASES)?.id ??
    findModeByAliases(modeState.availableModes, ACP_APPROVAL_MODE_ALIASES)?.id ??
    modeState.availableModes.find((mode) => !isPlanMode(mode))?.id ??
    modeState.currentModeId
  );
}

function applyRequestedSessionConfiguration<E>(input: {
  readonly runtime: AcpSessionRuntime.AcpSessionRuntime["Service"];
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly modelSelection:
    | {
        readonly model: string;
        readonly options?: ReadonlyArray<ProviderOptionSelection> | null | undefined;
      }
    | undefined;
  readonly mapError: (context: {
    readonly cause: import("effect-acp/errors").AcpError;
    readonly method: "session/set_config_option" | "session/set_mode";
  }) => E;
}): Effect.Effect<void, E> {
  return Effect.gen(function* () {
    if (input.modelSelection) {
      yield* applyKimiAcpModelSelection({
        runtime: input.runtime,
        model: input.modelSelection.model,
        selections: input.modelSelection.options,
        mapError: ({ cause }) =>
          input.mapError({
            cause,
            method: "session/set_config_option",
          }),
      });
    }

    const requestedModeId = resolveRequestedModeId({
      interactionMode: input.interactionMode,
      runtimeMode: input.runtimeMode,
      modeState: yield* input.runtime.getModeState,
    });
    if (!requestedModeId) {
      return;
    }

    yield* input.runtime.setMode(requestedModeId).pipe(
      Effect.mapError((cause) =>
        input.mapError({
          cause,
          method: "session/set_mode",
        }),
      ),
    );
  });
}

function selectAutoApprovedPermissionOption(
  request: EffectAcpSchema.RequestPermissionRequest,
): string | undefined {
  const allowAlwaysOption = request.options.find((option) => option.kind === "allow_always");
  if (typeof allowAlwaysOption?.optionId === "string" && allowAlwaysOption.optionId.trim()) {
    return allowAlwaysOption.optionId.trim();
  }

  const allowOnceOption = request.options.find((option) => option.kind === "allow_once");
  if (typeof allowOnceOption?.optionId === "string" && allowOnceOption.optionId.trim()) {
    return allowOnceOption.optionId.trim();
  }

  return undefined;
}

function selectPermissionOptionForDecision(
  request: EffectAcpSchema.RequestPermissionRequest,
  decision: ProviderApprovalDecision,
): string | undefined {
  const preferredKinds =
    decision === "acceptForSession"
      ? (["allow_always", "allow_once"] as const)
      : decision === "accept"
        ? (["allow_once", "allow_always"] as const)
        : (["reject_once", "reject_always"] as const);
  for (const kind of preferredKinds) {
    const option = request.options.find((candidate) => candidate.kind === kind);
    if (option?.optionId.trim()) {
      return option.optionId.trim();
    }
  }
  return undefined;
}

function kimiPermissionContentText(
  request: EffectAcpSchema.RequestPermissionRequest,
): string | undefined {
  const text = request.toolCall.content
    ?.filter((entry) => entry.type === "content" && entry.content.type === "text")
    .map((entry) =>
      entry.type === "content" && entry.content.type === "text" ? entry.content.text : "",
    )
    .join("\n")
    .trim();
  return text || undefined;
}

/**
 * Kimi 0.28 omits `toolCall.kind` from permission requests even though its
 * later tool updates identify Bash calls as `execute`. Preserve the shared
 * ACP parser for complete requests, but infer command approvals from Kimi's
 * stable tool title so supervised clients render actionable approval UI.
 */
export function parseKimiPermissionRequest(
  request: EffectAcpSchema.RequestPermissionRequest,
): AcpPermissionRequest {
  const parsed = parsePermissionRequest(request);
  const title = request.toolCall.title?.trim().toLowerCase();
  const kind =
    parsed.kind === "unknown" &&
    (title === "bash" || title === "shell" || title === "terminal" || title === "command")
      ? "execute"
      : parsed.kind;
  const detail = kimiPermissionContentText(request) ?? parsed.detail;
  return {
    ...parsed,
    kind,
    ...(detail ? { detail } : {}),
  };
}

export function isKimiStructuredUserInputPermission(
  request: EffectAcpSchema.RequestPermissionRequest,
): boolean {
  return request.toolCall.title?.trim().toLowerCase() === "askuserquestion";
}

function kimiPermissionQuestion(
  request: EffectAcpSchema.RequestPermissionRequest,
): UserInputQuestion {
  const questionText = request.toolCall.content?.find(
    (entry) => entry.type === "content" && entry.content.type === "text",
  );
  return {
    id: request.toolCall.toolCallId,
    header: "Question",
    question:
      questionText?.type === "content" && questionText.content.type === "text"
        ? questionText.content.text.trim() || "Kimi needs your input."
        : "Kimi needs your input.",
    options: request.options
      .filter((option) => option.kind === "allow_once")
      .map((option) => ({ label: option.name, description: option.name })),
    multiSelect: false,
  };
}

function selectKimiUserInputPermissionOption(
  request: EffectAcpSchema.RequestPermissionRequest,
  answers: ProviderUserInputAnswers,
): string | undefined {
  const answer = answers[request.toolCall.toolCallId] ?? Object.values(answers)[0];
  const selected = Array.isArray(answer) ? answer[0] : answer;
  if (typeof selected !== "string") {
    return undefined;
  }
  const normalized = selected.trim().toLowerCase();
  return request.options.find(
    (option) =>
      option.kind === "allow_once" &&
      (option.name.trim().toLowerCase() === normalized || option.optionId === selected),
  )?.optionId;
}

export function prepareKimiAcpPromptParts(input: {
  readonly text: string | undefined;
  readonly attachmentsDir: string;
  readonly threadId: ThreadId;
  readonly attachments: ReadonlyArray<ChatAttachment> | undefined;
  readonly fileSystem: FileSystem.FileSystem;
  readonly imageSupported?: boolean;
}) {
  if (
    input.attachments?.some((attachment) => attachment.type === "image") &&
    !input.imageSupported
  ) {
    return Effect.fail(
      new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "session/prompt",
        detail: "This Kimi ACP version did not advertise image prompt support.",
      }),
    );
  }
  return mapAcpAttachments(input).pipe(
    Effect.map((attachmentParts) => {
      const userText = input.text?.trim() || undefined;
      const hasUserContent = userText !== undefined || attachmentParts.length > 0;
      return [
        ...(hasUserContent
          ? [
              {
                type: "text" as const,
                text:
                  userText === undefined
                    ? KIMI_ACP_SUBAGENT_SUPERVISION_GUIDANCE
                    : `${KIMI_ACP_SUBAGENT_SUPERVISION_GUIDANCE}\n\nUser request:\n${userText}`,
              },
            ]
          : []),
        ...attachmentParts,
      ];
    }),
    Effect.mapError(
      (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session/prompt",
          detail: cause.message,
          cause,
        }),
    ),
  );
}

export function makeKimiAdapter(kimiSettings: KimiSettings, options?: KimiAdapterLiveOptions) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("kimi");
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* Effect.service(ServerConfig);
    const crypto = yield* Crypto.Crypto;
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
            stream: "native",
          })
        : undefined);
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;
    const makeAcpNativeLoggers = yield* makeAcpNativeLoggerFactory();

    const sessions = new Map<ThreadId, KimiSessionContext>();
    const sendsInFlight = new Map<ThreadId, number>();
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate Kimi runtime identifier.",
            cause,
          }),
      ),
    );
    const nextEventId = Effect.map(randomUUIDv4, (id) => EventId.make(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });
    const mapClientHandlerFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new EffectAcpErrors.AcpTransportError({
              detail: "Failed to process a Kimi ACP client request.",
              cause,
            }),
        ),
      );

    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

    const getThreadSemaphore = (threadId: string) =>
      SynchronizedRef.modifyEffect(threadLocksRef, (current) => {
        const existing: Option.Option<Semaphore.Semaphore> = Option.fromNullishOr(
          current.get(threadId),
        );
        return Option.match(existing, {
          onNone: () =>
            Semaphore.make(1).pipe(
              Effect.map((semaphore) => {
                const next = new Map(current);
                next.set(threadId, semaphore);
                return [semaphore, next] as const;
              }),
            ),
          onSome: (semaphore) => Effect.succeed([semaphore, current] as const),
        });
      });

    const withThreadLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(getThreadSemaphore(threadId), (semaphore) => semaphore.withPermit(effect));

    const logNative = (
      threadId: ThreadId,
      method: string,
      payload: unknown,
      _source: "acp.jsonrpc" | "acp.kimi.extension",
    ) =>
      Effect.gen(function* () {
        if (!nativeEventLogger) return;
        const observedAt = yield* nowIso;
        yield* nativeEventLogger.write(
          {
            observedAt,
            event: {
              id: yield* randomUUIDv4,
              kind: "notification",
              provider: PROVIDER,
              createdAt: observedAt,
              method,
              threadId,
              payload,
            },
          },
          threadId,
        );
      });

    const emitPlanUpdate = (
      ctx: KimiSessionContext,
      payload: {
        readonly explanation?: string | null;
        readonly plan: ReadonlyArray<{
          readonly step: string;
          readonly status: "pending" | "inProgress" | "completed";
        }>;
      },
      rawPayload: unknown,
      source: "acp.jsonrpc" | "acp.kimi.extension",
      method: string,
    ) =>
      Effect.gen(function* () {
        const fingerprint = `${ctx.activeTurnId ?? "no-turn"}:${encodeJsonStringForDiagnostics(payload) ?? "[unserializable payload]"}`;
        if (ctx.lastPlanFingerprint === fingerprint) {
          return;
        }
        ctx.lastPlanFingerprint = fingerprint;
        yield* offerRuntimeEvent(
          makeAcpPlanUpdatedEvent({
            stamp: yield* makeEventStamp(),
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId: ctx.activeTurnId,
            payload,
            source,
            method,
            rawPayload,
          }),
        );
      });

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<KimiSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }
      return Effect.succeed(ctx);
    };

    const cancelActiveTurn = (ctx: KimiSessionContext, turnId: TurnId) =>
      Effect.gen(function* () {
        ctx.interruptedTurnIds.add(turnId);
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* settlePendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
        yield* Effect.ignore(
          ctx.acp.cancelAndWait.pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, ctx.threadId, "session/cancel", error),
            ),
          ),
        );
      });

    const stopSessionInternal = (ctx: KimiSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* settlePendingUserInputsAsEmptyAnswers(ctx.pendingUserInputs);
        if (ctx.notificationFiber) {
          yield* Fiber.interrupt(ctx.notificationFiber);
        }
        yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
        sessions.delete(ctx.threadId);
        yield* offerRuntimeEvent({
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload: { exitKind: "graceful" },
        });
      });

    const startSession: KimiAdapterShape["startSession"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          if (input.provider !== undefined && input.provider !== PROVIDER) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
            });
          }
          if (!input.cwd?.trim()) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "cwd is required and must be non-empty.",
            });
          }

          const cwd = path.resolve(input.cwd.trim());
          const kimiModelSelection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) {
            yield* stopSessionInternal(existing);
          }

          const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
          const pendingUserInputs = new Map<ApprovalRequestId, PendingUserInput>();
          const sessionScope = yield* Scope.make("sequential");
          let sessionScopeTransferred = false;
          yield* Effect.addFinalizer(() =>
            sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
          );
          let ctx!: KimiSessionContext;

          const parsedResume = parseKimiResume(input.resumeCursor);
          if (input.resumeCursor !== undefined && parsedResume === undefined) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "Malformed Kimi resume cursor.",
            });
          }
          if (parsedResume && parsedResume.instanceId !== boundInstanceId) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Kimi resume cursor belongs to instance '${parsedResume.instanceId}', not '${boundInstanceId}'.`,
            });
          }
          const resumeSessionId = parsedResume?.sessionId;
          const acpNativeLoggers = makeAcpNativeLoggers({
            nativeEventLogger,
            provider: PROVIDER,
            threadId: input.threadId,
          });

          // Resolve the KimiSettings used to spawn the ACP child. Production
          // leaves `options.resolveSettings` undefined so we use the value
          // captured at adapter construction — per-instance isolation is
          // enforced by the hydration layer rebuilding this adapter whenever
          // its config changes. Tests set `resolveSettings` to pull the latest
          // snapshot from `ServerSettingsService` so that mid-suite
          // `updateSettings({ providers: { kimi: { binaryPath } } })` calls
          // actually take effect when the next session spawns.
          const effectiveKimiSettings = options?.resolveSettings
            ? yield* options.resolveSettings
            : kimiSettings;

          const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
          const acp = yield* makeKimiAcpRuntime({
            kimiSettings: effectiveKimiSettings,
            ...(options?.environment ? { environment: options.environment } : {}),
            childProcessSpawner,
            cwd,
            ...(resumeSessionId ? { resumeSessionId } : {}),
            clientCapabilities: { elicitation: { form: {} } },
            clientInfo: { name: "t3-code", version: "0.0.0" },
            ...(mcpSession
              ? {
                  mcpServers: [
                    {
                      type: "http" as const,
                      name: "t3-code",
                      url: mcpSession.endpoint,
                      headers: [
                        {
                          name: "Authorization",
                          value: mcpSession.authorizationHeader,
                        },
                      ],
                    },
                  ],
                }
              : {}),
            ...acpNativeLoggers,
          }).pipe(
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: cause.message,
                  cause,
                }),
            ),
          );
          const started = yield* Effect.gen(function* () {
            yield* acp.handleElicitation((params) =>
              mapClientHandlerFailure(
                Effect.gen(function* () {
                  yield* logNative(input.threadId, "session/elicitation", params, "acp.jsonrpc");
                  const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
                  const runtimeRequestId = RuntimeRequestId.make(requestId);
                  const answers = yield* Deferred.make<ProviderUserInputAnswers | undefined>();
                  pendingUserInputs.set(requestId, { answers });
                  yield* offerRuntimeEvent({
                    type: "user-input.requested",
                    ...(yield* makeEventStamp()),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId: ctx?.activeTurnId,
                    requestId: runtimeRequestId,
                    payload: { questions: kimiElicitationQuestions(params) },
                    raw: {
                      source: "acp.jsonrpc",
                      method: "session/elicitation",
                      payload: params,
                    },
                  });
                  const resolved = yield* Deferred.await(answers);
                  pendingUserInputs.delete(requestId);
                  if (resolved === undefined) {
                    return { action: { action: "cancel" as const } };
                  }
                  yield* offerRuntimeEvent({
                    type: "user-input.resolved",
                    ...(yield* makeEventStamp()),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId: ctx?.activeTurnId,
                    requestId: runtimeRequestId,
                    payload: { answers: resolved },
                  });
                  return {
                    action: {
                      action: "accept" as const,
                      content: kimiElicitationContent(resolved),
                    },
                  };
                }),
              ),
            );
            yield* acp.handleRequestPermission((params) =>
              mapClientHandlerFailure(
                Effect.gen(function* () {
                  yield* logNative(
                    input.threadId,
                    "session/request_permission",
                    params,
                    "acp.jsonrpc",
                  );
                  if (isKimiStructuredUserInputPermission(params)) {
                    const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
                    const runtimeRequestId = RuntimeRequestId.make(requestId);
                    const answers = yield* Deferred.make<ProviderUserInputAnswers | undefined>();
                    pendingUserInputs.set(requestId, { answers });
                    yield* offerRuntimeEvent({
                      type: "user-input.requested",
                      ...(yield* makeEventStamp()),
                      provider: PROVIDER,
                      threadId: input.threadId,
                      turnId: ctx?.activeTurnId,
                      requestId: runtimeRequestId,
                      payload: { questions: [kimiPermissionQuestion(params)] },
                      raw: {
                        source: "acp.jsonrpc",
                        method: "session/request_permission",
                        payload: params,
                      },
                    });
                    const resolved = yield* Deferred.await(answers);
                    pendingUserInputs.delete(requestId);
                    if (resolved === undefined) {
                      return { outcome: { outcome: "cancelled" as const } };
                    }
                    yield* offerRuntimeEvent({
                      type: "user-input.resolved",
                      ...(yield* makeEventStamp()),
                      provider: PROVIDER,
                      threadId: input.threadId,
                      turnId: ctx?.activeTurnId,
                      requestId: runtimeRequestId,
                      payload: { answers: resolved },
                    });
                    const selectedOptionId = selectKimiUserInputPermissionOption(params, resolved);
                    return {
                      outcome: selectedOptionId
                        ? { outcome: "selected" as const, optionId: selectedOptionId }
                        : { outcome: "cancelled" as const },
                    };
                  }
                  if (input.runtimeMode === "full-access") {
                    const autoApprovedOptionId = selectAutoApprovedPermissionOption(params);
                    if (autoApprovedOptionId !== undefined) {
                      return {
                        outcome: {
                          outcome: "selected" as const,
                          optionId: autoApprovedOptionId,
                        },
                      };
                    }
                  }
                  const permissionRequest = parseKimiPermissionRequest(params);
                  const requestId = ApprovalRequestId.make(yield* randomUUIDv4);
                  const runtimeRequestId = RuntimeRequestId.make(requestId);
                  const decision = yield* Deferred.make<ProviderApprovalDecision>();
                  pendingApprovals.set(requestId, {
                    decision,
                    kind: permissionRequest.kind,
                  });
                  yield* offerRuntimeEvent(
                    makeAcpRequestOpenedEvent({
                      stamp: yield* makeEventStamp(),
                      provider: PROVIDER,
                      threadId: input.threadId,
                      turnId: ctx?.activeTurnId,
                      requestId: runtimeRequestId,
                      permissionRequest,
                      detail:
                        permissionRequest.detail ??
                        encodeJsonStringForDiagnostics(params)?.slice(0, 2000) ??
                        "[unserializable params]",
                      args: params,
                      source: "acp.jsonrpc",
                      method: "session/request_permission",
                      rawPayload: params,
                    }),
                  );
                  const resolved = yield* Deferred.await(decision);
                  pendingApprovals.delete(requestId);
                  yield* offerRuntimeEvent(
                    makeAcpRequestResolvedEvent({
                      stamp: yield* makeEventStamp(),
                      provider: PROVIDER,
                      threadId: input.threadId,
                      turnId: ctx?.activeTurnId,
                      requestId: runtimeRequestId,
                      permissionRequest,
                      decision: resolved,
                    }),
                  );
                  const selectedOptionId = selectPermissionOptionForDecision(params, resolved);
                  return {
                    outcome:
                      resolved === "cancel"
                        ? ({ outcome: "cancelled" } as const)
                        : selectedOptionId
                          ? {
                              outcome: "selected" as const,
                              optionId: selectedOptionId,
                            }
                          : ({ outcome: "cancelled" } as const),
                  };
                }),
              ),
            );
            return yield* acp.start();
          }).pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", error),
            ),
          );

          if (options?.modelState) {
            yield* options.modelState.publishConfigOptions(
              started.sessionSetupResult.configOptions ?? [],
            );
          }

          yield* applyRequestedSessionConfiguration({
            runtime: acp,
            runtimeMode: input.runtimeMode,
            interactionMode: undefined,
            modelSelection:
              resumeSessionId !== undefined &&
              findKimiModelConfigOption(started.sessionSetupResult.configOptions ?? []) ===
                undefined
                ? undefined
                : kimiModelSelection,
            mapError: ({ cause, method }) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, method, cause),
          });

          const now = yield* nowIso;
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            model: kimiModelSelection?.model ?? KIMI_DEFAULT_MODEL,
            threadId: input.threadId,
            resumeCursor: {
              schemaVersion: KIMI_RESUME_VERSION,
              instanceId: boundInstanceId,
              sessionId: started.sessionId,
            },
            createdAt: now,
            updatedAt: now,
          };

          ctx = {
            threadId: input.threadId,
            acpSessionId: started.sessionId,
            session,
            scope: sessionScope,
            acp,
            notificationFiber: undefined,
            pendingApprovals,
            pendingUserInputs,
            turns: [],
            interruptedTurnIds: new Set(),
            lastPlanFingerprint: undefined,
            activeTurnId: undefined,
            imagePromptSupported:
              started.initializeResult.agentCapabilities?.promptCapabilities?.image === true,
            stopped: false,
          };

          const nf = yield* Stream.runDrain(
            Stream.mapEffect(acp.getEvents(), (event) =>
              Effect.gen(function* () {
                if (
                  ctx.activeTurnId === undefined &&
                  event._tag !== "EventStreamBarrier" &&
                  event._tag !== "ModeChanged"
                ) {
                  if ("rawPayload" in event) {
                    yield* logNative(
                      ctx.threadId,
                      "session/update",
                      event.rawPayload,
                      "acp.jsonrpc",
                    );
                  }
                  return;
                }
                switch (event._tag) {
                  case "EventStreamBarrier":
                    yield* Deferred.succeed(event.acknowledge, undefined);
                    return;
                  case "ModeChanged":
                    return;
                  case "AssistantItemStarted":
                    yield* offerRuntimeEvent(
                      makeAcpAssistantItemEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        itemId: event.itemId,
                        lifecycle: "item.started",
                      }),
                    );
                    return;
                  case "AssistantItemCompleted":
                    yield* offerRuntimeEvent(
                      makeAcpAssistantItemEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        itemId: event.itemId,
                        lifecycle: "item.completed",
                      }),
                    );
                    return;
                  case "PlanUpdated":
                    yield* logNative(
                      ctx.threadId,
                      "session/update",
                      event.rawPayload,
                      "acp.jsonrpc",
                    );
                    yield* emitPlanUpdate(
                      ctx,
                      event.payload,
                      event.rawPayload,
                      "acp.jsonrpc",
                      "session/update",
                    );
                    return;
                  case "ToolCallUpdated":
                    yield* logNative(
                      ctx.threadId,
                      "session/update",
                      event.rawPayload,
                      "acp.jsonrpc",
                    );
                    yield* offerRuntimeEvent(
                      makeAcpToolCallEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        toolCall: event.toolCall,
                      }),
                    );
                    return;
                  case "ContentDelta":
                    yield* logNative(
                      ctx.threadId,
                      "session/update",
                      event.rawPayload,
                      "acp.jsonrpc",
                    );
                    yield* offerRuntimeEvent(
                      makeAcpContentDeltaEvent({
                        stamp: yield* makeEventStamp(),
                        provider: PROVIDER,
                        threadId: ctx.threadId,
                        turnId: ctx.activeTurnId,
                        ...(event.itemId ? { itemId: event.itemId } : {}),
                        text: event.text,
                        rawPayload: event.rawPayload,
                      }),
                    );
                    return;
                }
              }),
            ),
          ).pipe(
            Effect.catch((cause) =>
              Effect.logError("Failed to process Kimi runtime notification.", { cause }),
            ),
            Effect.forkChild,
          );

          ctx.notificationFiber = nf;
          sessions.set(input.threadId, ctx);
          sessionScopeTransferred = true;

          yield* offerRuntimeEvent({
            type: "session.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { resume: started.initializeResult },
          });
          yield* offerRuntimeEvent({
            type: "session.state.changed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { state: "ready", reason: "Kimi ACP session ready" },
          });
          yield* offerRuntimeEvent({
            type: "thread.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { providerThreadId: started.sessionId },
          });

          return session;
        }).pipe(Effect.scoped),
      );

    const sendTurn: KimiAdapterShape["sendTurn"] = (input) =>
      Effect.suspend(() => {
        const priorSendsInFlight = sendsInFlight.get(input.threadId) ?? 0;
        sendsInFlight.set(input.threadId, priorSendsInFlight + 1);
        return Effect.gen(function* () {
          if (priorSendsInFlight > 0) {
            const steeringContext = yield* requireSession(input.threadId);
            const steeringTurnId =
              steeringContext.activeTurnId ?? steeringContext.session.activeTurnId;
            if (steeringTurnId !== undefined) {
              yield* cancelActiveTurn(steeringContext, steeringTurnId);
            }
          }

          return yield* withThreadLock(
            input.threadId,
            Effect.gen(function* () {
              const ctx = yield* requireSession(input.threadId);
              const promptParts = yield* prepareKimiAcpPromptParts({
                text: input.input,
                attachmentsDir: serverConfig.attachmentsDir,
                threadId: input.threadId,
                attachments: input.attachments,
                fileSystem,
                imageSupported: ctx.imagePromptSupported,
              });
              if (promptParts.length === 0) {
                return yield* new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "sendTurn",
                  issue: "Turn requires non-empty text or attachments.",
                });
              }

              const turnId = TurnId.make(yield* randomUUIDv4);
              const turnModelSelection =
                input.modelSelection?.instanceId === boundInstanceId
                  ? input.modelSelection
                  : undefined;
              const model = turnModelSelection?.model ?? ctx.session.model;
              const resolvedModel = model ?? KIMI_DEFAULT_MODEL;
              yield* applyRequestedSessionConfiguration({
                runtime: ctx.acp,
                runtimeMode: ctx.session.runtimeMode,
                interactionMode: input.interactionMode,
                modelSelection:
                  model === undefined
                    ? undefined
                    : {
                        model,
                        options: turnModelSelection?.options,
                      },
                mapError: ({ cause, method }) =>
                  mapAcpToAdapterError(PROVIDER, input.threadId, method, cause),
              });
              ctx.activeTurnId = turnId;
              ctx.lastPlanFingerprint = undefined;
              ctx.session = {
                ...ctx.session,
                activeTurnId: turnId,
                updatedAt: yield* nowIso,
              };
              yield* offerRuntimeEvent({
                type: "turn.started",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId,
                payload: { model: resolvedModel },
              });
              const kimiLogCheckpoint = yield* captureKimiAcpLogCheckpoint({
                sessionId: ctx.acpSessionId,
                ...(options?.environment ? { environment: options.environment } : {}),
              }).pipe(
                Effect.provideService(FileSystem.FileSystem, fileSystem),
                Effect.provideService(Path.Path, path),
              );

              const cancelledResponse = {
                stopReason: "cancelled",
              } satisfies EffectAcpSchema.PromptResponse;
              const promptExit = yield* Effect.gen(function* () {
                if (ctx.interruptedTurnIds.has(turnId)) {
                  return cancelledResponse;
                }
                const promptFiber = yield* ctx.acp
                  .prompt({
                    prompt: promptParts,
                  })
                  .pipe(Effect.forkChild);
                if (ctx.interruptedTurnIds.has(turnId)) {
                  yield* Effect.yieldNow;
                  yield* ctx.acp.cancel.pipe(Effect.ignore);
                }
                return yield* Fiber.join(promptFiber).pipe(
                  Effect.catchCause((cause) =>
                    Cause.hasInterruptsOnly(cause)
                      ? Effect.succeed(cancelledResponse)
                      : Effect.failCause(cause),
                  ),
                );
              }).pipe(
                Effect.mapError((error) =>
                  mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", error),
                ),
                Effect.exit,
              );

              if (Exit.isFailure(promptExit)) {
                const loggedFailure = yield* readKimiAcpFailureSince(kimiLogCheckpoint).pipe(
                  Effect.provideService(FileSystem.FileSystem, fileSystem),
                );
                const errorMessage =
                  loggedFailure?.message ??
                  "Kimi could not complete the turn because its ACP session failed.";
                const failedAt = yield* nowIso;
                ctx.activeTurnId = undefined;
                const { activeTurnId: _activeTurnId, ...failedSession } = ctx.session;
                ctx.session = {
                  ...failedSession,
                  status: "error",
                  updatedAt: failedAt,
                  lastError: errorMessage,
                };
                ctx.interruptedTurnIds.delete(turnId);
                yield* offerRuntimeEvent({
                  type: "turn.completed",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId,
                  payload: {
                    state: "failed",
                    errorMessage,
                  },
                });
                return yield* Effect.failCause(promptExit.cause);
              }
              const result = promptExit.value;
              yield* ctx.acp.drainEvents.pipe(
                Effect.mapError((error) =>
                  mapAcpToAdapterError(PROVIDER, input.threadId, "session/drain", error),
                ),
              );
              const loggedFailure =
                result.stopReason === "cancelled"
                  ? undefined
                  : yield* readKimiAcpFailureSince(kimiLogCheckpoint).pipe(
                      Effect.provideService(FileSystem.FileSystem, fileSystem),
                    );
              if (loggedFailure) {
                const failedAt = yield* nowIso;
                ctx.activeTurnId = undefined;
                const { activeTurnId: _activeTurnId, ...failedSession } = ctx.session;
                ctx.session = {
                  ...failedSession,
                  status: "error",
                  updatedAt: failedAt,
                  lastError: loggedFailure.message,
                };
                ctx.interruptedTurnIds.delete(turnId);
                yield* offerRuntimeEvent({
                  type: "turn.completed",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId,
                  payload: {
                    state: "failed",
                    stopReason: result.stopReason ?? null,
                    errorMessage: loggedFailure.message,
                  },
                });
                return {
                  threadId: input.threadId,
                  turnId,
                  ...(ctx.session.resumeCursor !== undefined
                    ? { resumeCursor: ctx.session.resumeCursor }
                    : {}),
                };
              }

              ctx.turns.push({ id: turnId, items: [{ prompt: promptParts, result }] });
              ctx.activeTurnId = undefined;
              const { activeTurnId: _activeTurnId, ...completedSession } = ctx.session;
              ctx.session = {
                ...completedSession,
                status: "ready",
                updatedAt: yield* nowIso,
                model: resolvedModel,
              };
              ctx.interruptedTurnIds.delete(turnId);
              yield* offerRuntimeEvent({
                type: "turn.completed",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId,
                payload: {
                  state: result.stopReason === "cancelled" ? "cancelled" : "completed",
                  stopReason: result.stopReason ?? null,
                },
              });

              return {
                threadId: input.threadId,
                turnId,
                resumeCursor: ctx.session.resumeCursor,
              };
            }),
          );
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              const remaining = (sendsInFlight.get(input.threadId) ?? 1) - 1;
              if (remaining > 0) {
                sendsInFlight.set(input.threadId, remaining);
              } else {
                sendsInFlight.delete(input.threadId);
              }
            }),
          ),
        );
      });

    const interruptTurn: KimiAdapterShape["interruptTurn"] = (threadId, turnId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const activeTurnId = ctx.activeTurnId ?? ctx.session.activeTurnId;
        if (turnId !== undefined && activeTurnId !== undefined && turnId !== activeTurnId) {
          return;
        }
        const interruptedTurnId = turnId ?? activeTurnId;
        if (interruptedTurnId === undefined) {
          return;
        }
        yield* cancelActiveTurn(ctx, interruptedTurnId);
      });

    const respondToRequest: KimiAdapterShape["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingApprovals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/request_permission",
            detail: `Unknown pending approval request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.decision, decision);
      });

    const respondToUserInput: KimiAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingUserInputs.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/elicitation",
            detail: `Unknown pending user-input request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.answers, answers);
      });

    const readThread: KimiAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return { threadId, turns: ctx.turns };
      });

    const rollbackThread: KimiAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        const nextLength = Math.max(0, ctx.turns.length - numTurns);
        ctx.turns.splice(nextLength);
        return { threadId, turns: ctx.turns };
      });

    const stopSession: KimiAdapterShape["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          yield* stopSessionInternal(ctx);
        }),
      );

    const listSessions: KimiAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (c) => ({ ...c.session })));

    const hasSession: KimiAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const c = sessions.get(threadId);
        return c !== undefined && !c.stopped;
      });

    const stopAll: KimiAdapterShape["stopAll"] = () =>
      Effect.forEach(sessions.values(), stopSessionInternal, { discard: true });

    yield* Effect.addFinalizer(() =>
      Effect.forEach(sessions.values(), stopSessionInternal, { discard: true }).pipe(
        Effect.catch((cause) =>
          Effect.logError("Failed to emit Kimi session shutdown event.", { cause }),
        ),
        Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
        Effect.tap(() => managedNativeEventLogger?.close() ?? Effect.void),
      ),
    );

    const streamEvents = Stream.fromPubSub(runtimeEventPubSub);

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "in-session" },
      startSession,
      sendTurn,
      interruptTurn,
      readThread,
      rollbackThread,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      stopAll,
      streamEvents,
    } satisfies KimiAdapterShape;
  });
}
