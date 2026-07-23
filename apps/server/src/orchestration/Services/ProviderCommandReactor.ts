/**
 * ProviderCommandReactor - Provider command reaction service interface.
 *
 * Owns background workers that react to orchestration intent events and
 * dispatch provider-side command execution.
 *
 * @module ProviderCommandReactor
 */
import {
  MessageId,
  ProviderInstanceId,
  ProviderTurnStartResult,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

export const PendingTurnStartRecoveryInput = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
});
export type PendingTurnStartRecoveryInput = typeof PendingTurnStartRecoveryInput.Type;

export const PendingTurnStartRecoveryErrorCode = Schema.Literals([
  "thread-missing",
  "message-missing",
  "provider-send-failed",
]);
export type PendingTurnStartRecoveryErrorCode = typeof PendingTurnStartRecoveryErrorCode.Type;

export class PendingTurnStartRecoveryError extends Schema.TaggedErrorClass<PendingTurnStartRecoveryError>()(
  "PendingTurnStartRecoveryError",
  {
    code: PendingTurnStartRecoveryErrorCode,
    message: Schema.String,
    providerInstanceId: Schema.optional(ProviderInstanceId),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/**
 * ProviderCommandReactorShape - Service API for provider command reactors.
 */
export interface ProviderCommandReactorShape {
  /**
   * Start reacting to provider-intent orchestration domain events.
   *
   * The returned effect must be run in a scope so all worker fibers can be
   * finalized on shutdown.
   *
   * Filters orchestration domain events to provider-intent types before
   * processing.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /**
   * Resolves when the internal processing queue is empty and idle.
   * Intended for test use to replace timing-sensitive sleeps.
   */
  readonly drain: Effect.Effect<void>;

  /**
   * Delivers one durable pending turn start during startup recovery.
   *
   * Unlike the live event path, this awaits the provider turn identifier so
   * startup can durably project delivery before opening readiness.
   */
  readonly recoverPendingTurnStart: (
    input: PendingTurnStartRecoveryInput,
  ) => Effect.Effect<ProviderTurnStartResult, PendingTurnStartRecoveryError>;
}

/**
 * ProviderCommandReactor - Service tag for provider command reaction workers.
 */
export class ProviderCommandReactor extends Context.Service<
  ProviderCommandReactor,
  ProviderCommandReactorShape
>()("t3/orchestration/Services/ProviderCommandReactor") {}
