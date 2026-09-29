import { assert, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import * as Ref from "effect/Ref";
import * as References from "effect/References";
import * as Tracer from "effect/Tracer";
import * as TestClock from "effect/testing/TestClock";

import {
  type IdleSessionReleaseCandidate,
  makeLoggedIdleSessionRelease,
} from "./ForkProviderSessionReleaseLogging.ts";

const providerSessionId = ProviderSessionId.make("release-logging-test");
const input = { providerSessionId, generation: 1 };

function captureTelemetry() {
  const logs: Array<{ message: ReadonlyArray<unknown>; annotations: Record<string, unknown> }> = [];
  const spans: Tracer.NativeSpan[] = [];
  const logger = Logger.make(({ fiber, message }) => {
    logs.push({
      message: Array.isArray(message) ? message : [message],
      annotations: fiber.getRef(References.CurrentLogAnnotations),
    });
  });
  const tracer = Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      spans.push(span);
      return span;
    },
  });
  return { logs, spans, tracer, layer: Logger.layer([logger], { mergeWithExisting: false }) };
}

function candidate(
  overrides: Partial<IdleSessionReleaseCandidate> = {},
): IdleSessionReleaseCandidate {
  return {
    runtime: {
      instanceId: ProviderInstanceId.make("codex"),
      driver: ProviderDriverKind.make("codex"),
      providerSession: { status: "ready" },
    },
    attachedThreadIds: new Set([ThreadId.make("release-logging-thread")]),
    busyCount: 0,
    idleGeneration: 1,
    lastActivityAtMs: 0,
    pinnedSinceMs: null,
    ...overrides,
  };
}

it.effect("empty idle checks emit no logs or spans and never request a stop", () => {
  const telemetry = captureTelemetry();
  let stops = 0;
  return Effect.gen(function* () {
    const sessions = yield* Ref.make(new Map<string, IdleSessionReleaseCandidate>());
    const release = makeLoggedIdleSessionRelease({
      sessions,
      idleTimeoutMs: 1000,
      maxIdlePinMs: 4000,
      releaseEntry: () =>
        Effect.sync(() => {
          stops += 1;
        }),
    });
    for (let check = 0; check < 1000; check += 1) yield* release(input);
    assert.equal(stops, 0);
    assert.deepEqual(telemetry.logs, []);
    assert.deepEqual(telemetry.spans, []);
  }).pipe(Effect.provide(telemetry.layer), Effect.withTracer(telemetry.tracer));
});

it.effect("records a correlated candidate, decision, stop request and confirmed result", () => {
  const telemetry = captureTelemetry();
  return Effect.gen(function* () {
    const sessions = yield* Ref.make(new Map([[String(providerSessionId), candidate()]]));
    const release = makeLoggedIdleSessionRelease({
      sessions,
      idleTimeoutMs: 1000,
      maxIdlePinMs: 4000,
      releaseEntry: () => Ref.set(sessions, new Map()),
    });
    yield* release(input);
    assert.deepEqual(
      telemetry.logs.map((log) => log.message),
      [
        ["provider.session.release.candidate"],
        ["provider.session.release.decision"],
        ["provider.session.release.stop-requested"],
        ["provider.session.release.stop-completed"],
      ],
    );
    const decisionIds = new Set(telemetry.logs.map((log) => log.annotations.decisionId));
    assert.equal(decisionIds.size, 1);
    assert.equal(telemetry.logs[1]?.annotations.decision, "stop_inactive_session");
    assert.equal(telemetry.logs[3]?.annotations.result, "released");
    assert.equal(telemetry.logs[0]?.annotations.providerInstanceId, "codex");
    assert.deepEqual(telemetry.logs[0]?.annotations.threadIds, ["release-logging-thread"]);
    assert.equal(telemetry.spans.length, 1);
    assert.equal(telemetry.spans[0]?.name, "provider.session.release.idle-decision");
    assert.equal(telemetry.spans[0]?.status._tag, "Ended");
    assert.equal(telemetry.spans[0]?.attributes.get("decisionId"), [...decisionIds][0]);
  }).pipe(Effect.provide(telemetry.layer), Effect.withTracer(telemetry.tracer));
});

for (const { overrides, decision } of [
  { overrides: { busyCount: 1 }, decision: "skip_active_turn" },
  { overrides: { idleGeneration: 2 }, decision: "skip_stale_generation" },
]) {
  it.effect(`explains ${decision} without probing or stopping`, () => {
    const telemetry = captureTelemetry();
    let probes = 0;
    let stops = 0;
    return Effect.gen(function* () {
      const entry = candidate(overrides);
      const sessions = yield* Ref.make(
        new Map([
          [
            String(providerSessionId),
            {
              ...entry,
              runtime: {
                ...entry.runtime,
                hasPendingBackgroundWork: Effect.sync(() => {
                  probes += 1;
                  return false;
                }),
              },
            },
          ],
        ]),
      );
      const release = makeLoggedIdleSessionRelease({
        sessions,
        idleTimeoutMs: 1000,
        maxIdlePinMs: 4000,
        releaseEntry: () =>
          Effect.sync(() => {
            stops += 1;
          }),
      });
      yield* release(input);
      assert.equal(probes, 0);
      assert.equal(stops, 0);
      assert.equal(telemetry.logs[1]?.annotations.decision, decision);
    }).pipe(Effect.provide(telemetry.layer), Effect.withTracer(telemetry.tracer));
  });
}

it.effect("ends each background-work decision span before waiting for the next idle window", () => {
  const telemetry = captureTelemetry();
  return Effect.gen(function* () {
    const pending = yield* Ref.make(true);
    const entry = candidate();
    const sessions = yield* Ref.make(
      new Map([
        [
          String(providerSessionId),
          {
            ...entry,
            runtime: { ...entry.runtime, hasPendingBackgroundWork: Ref.get(pending) },
          },
        ],
      ]),
    );
    const release = makeLoggedIdleSessionRelease({
      sessions,
      idleTimeoutMs: 1000,
      maxIdlePinMs: 4000,
      releaseEntry: () => Ref.set(sessions, new Map()),
    });
    const fiber = yield* Effect.forkChild(release(input));
    yield* TestClock.adjust(0);
    assert.equal(telemetry.logs[1]?.annotations.decision, "skip_background_work");
    assert.equal(telemetry.spans.length, 1);
    assert.equal(telemetry.spans[0]?.status._tag, "Ended");
    yield* Ref.set(pending, false);
    yield* TestClock.adjust(1000);
    yield* Fiber.join(fiber);
    assert.equal(telemetry.spans.length, 2);
    assert.equal(telemetry.logs.at(-1)?.annotations.result, "released");
  }).pipe(Effect.provide(telemetry.layer), Effect.withTracer(telemetry.tracer));
});

it.effect("explains pin-cap expiry and retains V2's failed-probe fallback", () => {
  const telemetry = captureTelemetry();
  return Effect.gen(function* () {
    for (const probe of [Effect.succeed(true), Effect.die("probe failed")]) {
      const entry = candidate();
      const sessions = yield* Ref.make(
        new Map([
          [
            String(providerSessionId),
            {
              ...entry,
              runtime: { ...entry.runtime, hasPendingBackgroundWork: probe },
            },
          ],
        ]),
      );
      const release = makeLoggedIdleSessionRelease({
        sessions,
        idleTimeoutMs: 1000,
        maxIdlePinMs: 0,
        releaseEntry: () => Ref.set(sessions, new Map()),
      });
      yield* release(input);
      assert.equal((yield* Ref.get(sessions)).size, 0);
    }
    const decisions = telemetry.logs.filter(
      (log) => log.message[0] === "provider.session.release.decision",
    );
    assert.deepEqual(
      decisions.map((log) => log.annotations.decision),
      ["stop_expired_background_pin", "stop_inactive_session"],
    );
    assert.equal(
      telemetry.logs.some(
        (log) => log.message[0] === "provider.session.release.pending-work-check-failed",
      ),
      true,
    );
  }).pipe(Effect.provide(telemetry.layer), Effect.withTracer(telemetry.tracer));
});

it.effect("explains a runtime replacement during the background probe without pinning it", () => {
  const telemetry = captureTelemetry();
  let stops = 0;
  return Effect.gen(function* () {
    const original = candidate();
    const replacement = candidate();
    const sessions = yield* Ref.make(new Map<string, IdleSessionReleaseCandidate>());
    yield* Ref.set(
      sessions,
      new Map([
        [
          String(providerSessionId),
          {
            ...original,
            runtime: {
              ...original.runtime,
              hasPendingBackgroundWork: Ref.set(
                sessions,
                new Map([[String(providerSessionId), replacement]]),
              ).pipe(Effect.as(true)),
            },
          },
        ],
      ]),
    );
    const release = makeLoggedIdleSessionRelease({
      sessions,
      idleTimeoutMs: 1000,
      maxIdlePinMs: 4000,
      releaseEntry: () =>
        Effect.sync(() => {
          stops += 1;
        }),
    });
    yield* release(input);
    assert.equal(stops, 0);
    assert.equal(
      telemetry.logs.at(-1)?.annotations.decision,
      "skip_changed_during_background_probe",
    );
    assert.strictEqual((yield* Ref.get(sessions)).get(String(providerSessionId)), replacement);
    assert.isNull(replacement.pinnedSinceMs);
  }).pipe(Effect.provide(telemetry.layer), Effect.withTracer(telemetry.tracer));
});

it.effect("does not report an atomic guarded no-op as a released session", () => {
  const telemetry = captureTelemetry();
  return Effect.gen(function* () {
    const sessions = yield* Ref.make(new Map([[String(providerSessionId), candidate()]]));
    const release = makeLoggedIdleSessionRelease({
      sessions,
      idleTimeoutMs: 1000,
      maxIdlePinMs: 4000,
      releaseEntry: () =>
        Ref.update(sessions, (latest) => {
          const entry = latest.get(String(providerSessionId))!;
          return new Map([
            [String(providerSessionId), { ...entry, busyCount: 1, idleGeneration: 2 }],
          ]);
        }),
    });
    yield* release(input);
    assert.equal(telemetry.logs.at(-1)?.annotations.result, "skipped_changed_session");
    assert.equal(telemetry.logs.at(-1)?.annotations.currentBusyCount, 1);
    assert.equal(telemetry.logs.at(-1)?.annotations.currentGeneration, 2);
  }).pipe(Effect.provide(telemetry.layer), Effect.withTracer(telemetry.tracer));
});

it.effect("records stop failure with the decision identity and preserves the warning", () => {
  const telemetry = captureTelemetry();
  return Effect.gen(function* () {
    const sessions = yield* Ref.make(new Map([[String(providerSessionId), candidate()]]));
    const release = makeLoggedIdleSessionRelease({
      sessions,
      idleTimeoutMs: 1000,
      maxIdlePinMs: 4000,
      releaseEntry: () => Effect.fail("stop failed"),
    });
    yield* release(input);
    assert.equal(
      telemetry.logs.at(-1)?.message[0],
      "orchestration-v2.driver-session.idle-release-failed",
    );
    assert.equal(telemetry.logs.at(-1)?.annotations.result, "failed");
    assert.equal(
      telemetry.logs.at(-1)?.annotations.decisionId,
      telemetry.logs[0]?.annotations.decisionId,
    );
  }).pipe(Effect.provide(telemetry.layer), Effect.withTracer(telemetry.tracer));
});
