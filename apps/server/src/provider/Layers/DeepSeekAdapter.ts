import {
  DEFAULT_DEEPSEEK_MODEL,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeItemId,
  type ApprovalRequestId,
  type DeepSeekSettings,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  type ThreadId,
  type TurnId,
  TurnId as TurnIdSchema,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";

import { type DeepSeekChatMessage, streamDeepSeekChatCompletion } from "../deepseek/DeepSeekApi.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import type { DeepSeekAdapterShape } from "../Services/DeepSeekAdapter.ts";
import {
  deepseekModelsFromSettings,
  readDeepSeekApiKey,
  readDeepSeekBaseUrl,
} from "./DeepSeekProvider.ts";

const PROVIDER = ProviderDriverKind.make("deepseek");
const DEEPSEEK_RESUME_VERSION = 1 as const;
const DEEPSEEK_STREAM_TIMEOUT_MS = 180_000;

const DeepSeekResumeCursor = Schema.Struct({
  schemaVersion: Schema.Literal(DEEPSEEK_RESUME_VERSION),
  model: Schema.String,
  messages: Schema.Array(
    Schema.Struct({
      role: Schema.Literals(["system", "user", "assistant"]),
      content: Schema.String,
    }),
  ),
});
type DeepSeekResumeCursor = typeof DeepSeekResumeCursor.Type;

export interface DeepSeekAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly instanceId?: ProviderInstanceId;
}

interface DeepSeekSessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  messages: Array<DeepSeekChatMessage>;
  turns: Array<{ id: TurnId; items: Array<unknown> }>;
  activeTurnId: TurnId | undefined;
  currentModel: string;
  stopped: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeResumeCursor(raw: unknown): DeepSeekResumeCursor | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion !== DEEPSEEK_RESUME_VERSION) return undefined;
  if (typeof raw.model !== "string" || raw.model.trim().length === 0) return undefined;
  if (!Array.isArray(raw.messages)) return undefined;

  const messages: Array<DeepSeekChatMessage> = [];
  for (const message of raw.messages) {
    if (!isRecord(message)) return undefined;
    if (message.role !== "system" && message.role !== "user" && message.role !== "assistant") {
      return undefined;
    }
    if (typeof message.content !== "string") return undefined;
    messages.push({ role: message.role, content: message.content });
  }

  return {
    schemaVersion: DEEPSEEK_RESUME_VERSION,
    model: raw.model.trim(),
    messages,
  };
}

function makeResumeCursor(input: {
  readonly model: string;
  readonly messages: ReadonlyArray<DeepSeekChatMessage>;
}): DeepSeekResumeCursor {
  return {
    schemaVersion: DEEPSEEK_RESUME_VERSION,
    model: input.model,
    messages: [...input.messages],
  };
}

export function makeDeepSeekAdapter(
  deepSeekSettings: DeepSeekSettings,
  options?: DeepSeekAdapterLiveOptions,
) {
  return Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const crypto = yield* Crypto.Crypto;
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("deepseek");
    const environment = options?.environment ?? process.env;
    const sessions = new Map<ThreadId, DeepSeekSessionContext>();
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate DeepSeek runtime identifier.",
            cause,
          }),
      ),
    );
    const nextEventId = Effect.map(randomUUIDv4, (id) => EventId.make(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });
    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<DeepSeekSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      if (!ctx || ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }
      return Effect.succeed(ctx);
    };

    const resolveReadyConfig = (method: string) =>
      Effect.gen(function* () {
        if (!deepSeekSettings.enabled) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method,
            detail: "DeepSeek is disabled in T3 Code settings.",
          });
        }
        const apiKey = readDeepSeekApiKey(environment);
        const baseUrl = readDeepSeekBaseUrl(deepSeekSettings, environment);
        if (!apiKey) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method,
            detail:
              "DeepSeek API key is missing. Set DEEPSEEK_API_KEY in the provider environment.",
          });
        }
        if (!baseUrl) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method,
            detail:
              "DeepSeek base URL is missing. Configure providers.deepseek.baseUrl or DEEPSEEK_BASE_URL.",
          });
        }
        if (
          !Number.isInteger(deepSeekSettings.contextLimit) ||
          deepSeekSettings.contextLimit <= 0
        ) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method,
            detail: "DeepSeek context limit must be a positive integer.",
          });
        }
        if (deepseekModelsFromSettings(deepSeekSettings.customModels).length === 0) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method,
            detail: "DeepSeek has no configured models.",
          });
        }
        return { apiKey, baseUrl };
      });

    const stopSessionInternal = (ctx: DeepSeekSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        sessions.delete(ctx.threadId);
        const updatedAt = yield* nowIso;
        ctx.session = { ...ctx.session, status: "closed", updatedAt };
        yield* offerRuntimeEvent({
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: ctx.threadId,
          payload: { exitKind: "graceful" },
        });
      });

    const startSession: DeepSeekAdapterShape["startSession"] = (input) =>
      Effect.gen(function* () {
        if (input.provider !== undefined && input.provider !== PROVIDER) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
          });
        }
        if (
          input.providerInstanceId !== undefined &&
          input.providerInstanceId !== boundInstanceId
        ) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider instance '${boundInstanceId}' but received '${input.providerInstanceId}'.`,
          });
        }
        yield* resolveReadyConfig("session.start");

        const existing = sessions.get(input.threadId);
        if (existing && !existing.stopped) {
          yield* stopSessionInternal(existing);
        }

        const requestedModel = input.modelSelection?.model?.trim() || DEFAULT_DEEPSEEK_MODEL;
        const resumeCursor =
          input.resumeCursor === undefined ? undefined : normalizeResumeCursor(input.resumeCursor);
        if (input.resumeCursor !== undefined && resumeCursor === undefined) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "DeepSeek resume cursor is missing, corrupt, or from an unsupported version.",
          });
        }
        const currentModel = resumeCursor?.model ?? requestedModel;
        const messages = resumeCursor ? [...resumeCursor.messages] : [];
        const createdAt = yield* nowIso;
        const session: ProviderSession = {
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          status: "ready",
          runtimeMode: input.runtimeMode,
          threadId: input.threadId,
          createdAt,
          updatedAt: createdAt,
          model: currentModel,
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(resumeCursor !== undefined ? { resumeCursor } : {}),
        };
        const ctx: DeepSeekSessionContext = {
          threadId: input.threadId,
          session,
          messages,
          turns: [],
          activeTurnId: undefined,
          currentModel,
          stopped: false,
        };
        sessions.set(input.threadId, ctx);

        yield* offerRuntimeEvent({
          type: "session.started",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: input.threadId,
          payload: resumeCursor ? { resume: resumeCursor } : {},
        });
        yield* offerRuntimeEvent({
          type: "session.state.changed",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: input.threadId,
          payload: { state: "ready", reason: "DeepSeek session ready" },
        });
        yield* offerRuntimeEvent({
          type: "thread.started",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: input.threadId,
          payload: {},
        });

        return { ...session };
      });

    const sendTurn: DeepSeekAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        const { apiKey, baseUrl } = yield* resolveReadyConfig("chat.completions");
        if (ctx.activeTurnId !== undefined || ctx.session.status === "running") {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "chat.completions",
            detail: "DeepSeek already has a turn in progress for this thread.",
          });
        }
        if ((input.attachments ?? []).length > 0) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "chat.completions",
            detail: "DeepSeek adapter currently supports text-only turns.",
          });
        }
        const text = input.input?.trim();
        if (!text) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Turn requires non-empty text.",
          });
        }
        const requestedModel = input.modelSelection?.model?.trim();
        if (requestedModel && requestedModel !== ctx.currentModel && ctx.messages.length > 0) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "chat.completions",
            detail: "DeepSeek model changes require a new thread.",
          });
        }

        const model = requestedModel || ctx.currentModel || DEFAULT_DEEPSEEK_MODEL;
        const turnId = TurnIdSchema.make(yield* randomUUIDv4);
        const itemId = RuntimeItemId.make(`deepseek:${turnId}:assistant`);
        const startedAt = yield* nowIso;
        ctx.activeTurnId = turnId;
        ctx.currentModel = model;
        ctx.session = {
          ...ctx.session,
          status: "running",
          activeTurnId: turnId,
          model,
          updatedAt: startedAt,
        };
        yield* offerRuntimeEvent({
          type: "session.state.changed",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: input.threadId,
          turnId,
          payload: { state: "running", reason: "DeepSeek completion started" },
        });
        yield* offerRuntimeEvent({
          type: "turn.started",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: input.threadId,
          turnId,
          payload: { model },
        });
        yield* offerRuntimeEvent({
          type: "item.started",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: input.threadId,
          turnId,
          itemId,
          payload: {
            itemType: "assistant_message",
            status: "inProgress",
            title: "DeepSeek response",
          },
        });

        const messages = [...ctx.messages, { role: "user" as const, content: text }];
        let deltaSequence = 0;
        const assistant = yield* streamDeepSeekChatCompletion({
          httpClient,
          apiKey,
          baseUrl,
          model,
          messages,
          timeoutMs: DEEPSEEK_STREAM_TIMEOUT_MS,
          onDelta: (delta) => {
            deltaSequence += 1;
            return offerRuntimeEvent({
              type: "content.delta",
              eventId: EventId.make(`deepseek:${turnId}:delta:${deltaSequence}`),
              createdAt: startedAt,
              provider: PROVIDER,
              providerInstanceId: boundInstanceId,
              threadId: input.threadId,
              turnId,
              itemId,
              payload: {
                streamKind: "assistant_text",
                delta,
              },
            });
          },
        }).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "chat.completions",
                detail: cause.message,
                cause,
              }),
          ),
          Effect.tapError((cause) =>
            Effect.gen(function* () {
              const failedAt = yield* nowIso;
              const { activeTurnId: _activeTurnId, ...sessionWithoutTurn } = ctx.session;
              ctx.activeTurnId = undefined;
              ctx.session = {
                ...sessionWithoutTurn,
                status: "ready",
                updatedAt: failedAt,
                lastError: cause.message,
              };
              yield* offerRuntimeEvent({
                type: "runtime.error",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                providerInstanceId: boundInstanceId,
                threadId: input.threadId,
                turnId,
                payload: {
                  message: cause.message,
                  class: "provider_error",
                },
              });
              yield* offerRuntimeEvent({
                type: "turn.completed",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                providerInstanceId: boundInstanceId,
                threadId: input.threadId,
                turnId,
                payload: {
                  state: "failed",
                  errorMessage: cause.message,
                },
              });
              yield* offerRuntimeEvent({
                type: "session.state.changed",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                providerInstanceId: boundInstanceId,
                threadId: input.threadId,
                payload: { state: "ready", reason: "DeepSeek completion failed" },
              });
            }),
          ),
        );

        const completedMessages = [
          ...messages,
          { role: "assistant" as const, content: assistant.text },
        ];
        const resumeCursor = makeResumeCursor({ model, messages: completedMessages });
        const completedAt = yield* nowIso;
        const { activeTurnId: _activeTurnId, ...sessionWithoutTurn } = ctx.session;
        ctx.messages = completedMessages;
        ctx.turns = [
          ...ctx.turns,
          {
            id: turnId,
            items: [{ input: text, output: assistant.text, model }],
          },
        ];
        ctx.activeTurnId = undefined;
        ctx.session = {
          ...sessionWithoutTurn,
          status: "ready",
          model,
          resumeCursor,
          updatedAt: completedAt,
        };
        yield* offerRuntimeEvent({
          type: "item.completed",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: input.threadId,
          turnId,
          itemId,
          payload: {
            itemType: "assistant_message",
            status: "completed",
            title: "DeepSeek response",
          },
        });
        yield* offerRuntimeEvent({
          type: "turn.completed",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: input.threadId,
          turnId,
          payload: {
            state: "completed",
            stopReason: "stop",
          },
        });
        yield* offerRuntimeEvent({
          type: "session.state.changed",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: input.threadId,
          payload: { state: "ready", reason: "DeepSeek completion finished" },
        });

        return {
          threadId: input.threadId,
          turnId,
          resumeCursor,
        };
      });

    const interruptTurn: DeepSeekAdapterShape["interruptTurn"] = (threadId, turnId) =>
      Effect.gen(function* () {
        const ctx = sessions.get(threadId);
        if (!ctx || ctx.stopped) return;
        const activeTurnId = ctx.activeTurnId ?? ctx.session.activeTurnId;
        if (turnId !== undefined && activeTurnId !== undefined && activeTurnId !== turnId) {
          return;
        }
        if (!activeTurnId) return;
        const updatedAt = yield* nowIso;
        const { activeTurnId: _activeTurnId, ...sessionWithoutTurn } = ctx.session;
        ctx.activeTurnId = undefined;
        ctx.session = {
          ...sessionWithoutTurn,
          status: "ready",
          updatedAt,
        };
        yield* offerRuntimeEvent({
          type: "turn.completed",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId,
          turnId: activeTurnId,
          payload: { state: "interrupted", stopReason: "interrupted" },
        });
        yield* offerRuntimeEvent({
          type: "session.state.changed",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId,
          payload: { state: "ready", reason: "DeepSeek turn interrupted" },
        });
      });

    const unsupportedRequest = (method: string) =>
      new ProviderAdapterRequestError({
        provider: PROVIDER,
        method,
        detail: "DeepSeek adapter does not support provider-side tools, approvals, or user input.",
      });

    const respondToRequest: DeepSeekAdapterShape["respondToRequest"] = (
      _threadId: ThreadId,
      _requestId: ApprovalRequestId,
      _decision: ProviderApprovalDecision,
    ) => Effect.fail(unsupportedRequest("approval.respond"));

    const respondToUserInput: DeepSeekAdapterShape["respondToUserInput"] = (
      _threadId: ThreadId,
      _requestId: ApprovalRequestId,
      _answers: ProviderUserInputAnswers,
    ) => Effect.fail(unsupportedRequest("user-input.respond"));

    const readThread: DeepSeekAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        return { threadId, turns: ctx.turns };
      });

    const rollbackThread: DeepSeekAdapterShape["rollbackThread"] = (_threadId, numTurns) =>
      Effect.gen(function* () {
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "thread.rollback",
          detail: "DeepSeek adapter does not support provider-side rollback.",
        });
      });

    const stopSession: DeepSeekAdapterShape["stopSession"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        yield* stopSessionInternal(ctx);
      });

    const listSessions: DeepSeekAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (ctx) => ({ ...ctx.session })));

    const hasSession: DeepSeekAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const ctx = sessions.get(threadId);
        return ctx !== undefined && !ctx.stopped;
      });

    const stopAll: DeepSeekAdapterShape["stopAll"] = () =>
      Effect.forEach(Array.from(sessions.values()), stopSessionInternal, { discard: true });

    yield* Effect.addFinalizer(() =>
      Effect.ignore(stopAll()).pipe(Effect.tap(() => PubSub.shutdown(runtimeEventPubSub))),
    );

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "unsupported" },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      readThread,
      rollbackThread,
      stopAll,
      streamEvents: Stream.fromPubSub(runtimeEventPubSub),
    } satisfies DeepSeekAdapterShape;
  });
}
