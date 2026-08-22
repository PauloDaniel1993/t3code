import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Ref from "effect/Ref";

import { ProviderSessionStartupRecoveryError } from "./provider/Services/ProviderSessionStartupRecovery.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";

const report = {
  reconciledSessions: 0,
  interruptedTurns: 0,
  replayedPendingRequests: 0,
  failedRecoveries: 0,
} as const;

it.effect("runs one provider session recovery pass", () =>
  Effect.gen(function* () {
    const runs = yield* Ref.make(0);

    yield* ServerRuntimeStartup.runProviderSessionRecoveryDegraded(
      Ref.update(runs, (count) => count + 1).pipe(Effect.as(report)),
    );

    assert.strictEqual(yield* Ref.get(runs), 1);
  }),
);

it.effect("degrades typed recovery failures without swallowing interruption", () =>
  Effect.gen(function* () {
    yield* ServerRuntimeStartup.runProviderSessionRecoveryDegraded(
      Effect.fail(
        new ProviderSessionStartupRecoveryError({
          operation: "list-active",
          cause: new Error("corrupt recovery row"),
        }),
      ),
    );

    const interrupted = yield* Effect.exit(
      ServerRuntimeStartup.runProviderSessionRecoveryDegraded(Effect.interrupt),
    );
    assert.isTrue(Exit.isFailure(interrupted));
    if (Exit.isFailure(interrupted)) {
      assert.isTrue(Cause.hasInterrupts(interrupted.cause));
    }
  }),
);
