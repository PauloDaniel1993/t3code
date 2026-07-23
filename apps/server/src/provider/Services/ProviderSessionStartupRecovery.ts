import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const ProviderSessionStartupRecoveryReport = Schema.Struct({
  reconciledSessions: Schema.Number,
  interruptedTurns: Schema.Number,
  replayedPendingRequests: Schema.Number,
  failedRecoveries: Schema.Number,
});
export type ProviderSessionStartupRecoveryReport = typeof ProviderSessionStartupRecoveryReport.Type;

export class ProviderSessionStartupRecoveryError extends Schema.TaggedErrorClass<ProviderSessionStartupRecoveryError>()(
  "ProviderSessionStartupRecoveryError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Provider session startup recovery failed during ${this.operation}.`;
  }
}

export interface ProviderSessionStartupRecoveryShape {
  readonly run: Effect.Effect<
    ProviderSessionStartupRecoveryReport,
    ProviderSessionStartupRecoveryError
  >;
}

export class ProviderSessionStartupRecovery extends Context.Service<
  ProviderSessionStartupRecovery,
  ProviderSessionStartupRecoveryShape
>()("t3/provider/Services/ProviderSessionStartupRecovery") {}
