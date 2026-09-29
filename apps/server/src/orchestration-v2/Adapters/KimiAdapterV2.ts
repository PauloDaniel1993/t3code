import { ProviderDriverKind, type ModelSelection } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as AcpErrors from "effect-acp/errors";

import { applyKimiAcpModelSelection } from "../../provider/acp/KimiAcpSupport.ts";
import { extractKimiPermissionQuestion } from "../../provider/acp/KimiProtocol.ts";
import { makeProviderFailure } from "../ProviderFailure.ts";
import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2Flavor,
} from "./AcpAdapterV2.ts";

const KIMI = ProviderDriverKind.make("kimi");
const loggedFailure = Schema.Struct({
  kimiFailure: Schema.Struct({
    message: Schema.String,
    code: Schema.optionalKey(Schema.String),
    retryable: Schema.optionalKey(Schema.Boolean),
  }),
});
const isLoggedFailure = Schema.is(loggedFailure);
const isRequestError = Schema.is(AcpErrors.AcpRequestError);

export interface KimiAdapterV2Options extends Omit<
  Parameters<typeof makeAcpAdapterV2>[0],
  "flavor"
> {
  readonly makeRuntime: AcpAdapterV2Flavor["makeRuntime"];
  readonly onSessionConfigurationUpdate?: AcpAdapterV2Flavor["onSessionConfigurationUpdate"];
  readonly onSessionEvent?: AcpAdapterV2Flavor["onSessionEvent"];
}

export function kimiPromptFailure(cause: unknown) {
  if (isRequestError(cause) && isLoggedFailure(cause.data)) {
    return makeProviderFailure({ ...cause.data.kimiFailure, class: "provider_error" });
  }
  return makeProviderFailure({ cause, class: "provider_error" });
}

export function makeKimiAcpAdapterFlavor(options: KimiAdapterV2Options): AcpAdapterV2Flavor {
  return {
    driver: KIMI,
    runtimeHarness: "Kimi Code",
    capabilities: AcpProviderCapabilitiesV2,
    makeRuntime: options.makeRuntime,
    applyModelSelection: ({ runtime, modelSelection }) =>
      applyKimiAcpModelSelection({
        runtime,
        model: modelSelection.model,
      }),
    // The common adapter applies plan after saving the supervised build mode,
    // then restores it on leaving plan. T3 owns automatic approvals in all modes.
    sessionModeForPolicy: (policy) =>
      policy.runtimeMode === "approval-required" ? "ask" : "default",
    extractPermissionQuestion: extractKimiPermissionQuestion,
    promptFailure: kimiPromptFailure,
    ...(options.onSessionConfigurationUpdate
      ? { onSessionConfigurationUpdate: options.onSessionConfigurationUpdate }
      : {}),
    ...(options.onSessionEvent ? { onSessionEvent: options.onSessionEvent } : {}),
  };
}

export function makeKimiAdapterV2(options: KimiAdapterV2Options) {
  const adapter = makeAcpAdapterV2({ ...options, flavor: makeKimiAcpAdapterFlavor(options) });
  // This synthetic option belonged to the generic ACP mode picker. Kimi's
  // mode comes exclusively from the turn policy, including entering plan.
  const selection = (value: ModelSelection): ModelSelection => ({
    ...value,
    ...(value.options
      ? { options: value.options.filter((option) => option.id !== "_t3/session-mode") }
      : {}),
  });
  return {
    ...adapter,
    openSession: (input: Parameters<typeof adapter.openSession>[0]) =>
      adapter.openSession({ ...input, modelSelection: selection(input.modelSelection) }).pipe(
        Effect.map((session) => ({
          ...session,
          ensureThread: (input: Parameters<typeof session.ensureThread>[0]) =>
            session.ensureThread({ ...input, modelSelection: selection(input.modelSelection) }),
          resumeThread: (input: Parameters<typeof session.resumeThread>[0]) =>
            session.resumeThread({
              ...input,
              ...(input.modelSelection ? { modelSelection: selection(input.modelSelection) } : {}),
            }),
          startTurn: (input: Parameters<typeof session.startTurn>[0]) =>
            session.startTurn({ ...input, modelSelection: selection(input.modelSelection) }),
          ...(session.compactThread
            ? {
                compactThread: (input: Parameters<NonNullable<typeof session.compactThread>>[0]) =>
                  session.compactThread!({
                    ...input,
                    modelSelection: selection(input.modelSelection),
                  }),
              }
            : {}),
          forkThread: (input: Parameters<typeof session.forkThread>[0]) =>
            session.forkThread({
              ...input,
              ...(input.modelSelection ? { modelSelection: selection(input.modelSelection) } : {}),
            }),
        })),
      ),
  };
}
