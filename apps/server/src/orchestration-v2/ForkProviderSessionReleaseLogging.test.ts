import { assert, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as References from "effect/References";
import * as Tracer from "effect/Tracer";

import {
  type IdleSessionReleaseCandidate,
  makeIdleReleaseTracer,
} from "./ForkProviderSessionReleaseLogging.ts";

const providerSessionId = ProviderSessionId.make("release-logging-test");
const key = String(providerSessionId);
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
    ...overrides,
  };
}

const makeTracer = (sessions: Ref.Ref<Map<string, IdleSessionReleaseCandidate>>) =>
  makeIdleReleaseTracer({ sessions, idleTimeoutMs: 1000, maxIdlePinMs: 4000 });

it.effect("an idle timer that finds no session emits no logs or spans", () => {
  const telemetry = captureTelemetry();
  return Effect.gen(function* () {
    const sessions = yield* Ref.make(new Map<string, IdleSessionReleaseCandidate>());
    const tracer = makeTracer(sessions);
    for (let check = 0; check < 1000; check += 1) {
      const trace = yield* tracer.begin(key, input, undefined);
      yield* trace.stopRequested();
      yield* trace.stopFinished();
    }
    assert.deepEqual(telemetry.logs, []);
    assert.deepEqual(telemetry.spans, []);
  }).pipe(Effect.provide(telemetry.layer), Effect.withTracer(telemetry.tracer));
});

it.effect("records a correlated candidate, decision, stop request and result", () => {
  const telemetry = captureTelemetry();
  return Effect.gen(function* () {
    const entry = candidate();
    const sessions = yield* Ref.make(new Map([[key, entry]]));
    const trace = yield* makeTracer(sessions).begin(key, input, entry);
    yield* trace.stopRequested();
    yield* Ref.set(sessions, new Map());
    yield* trace.stopFinished();

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
    assert.equal(telemetry.logs[3]?.annotations.result, "entry_removed");
    assert.equal(telemetry.logs[0]?.annotations.providerInstanceId, "codex");
    assert.deepEqual(telemetry.logs[0]?.annotations.threadIds, ["release-logging-thread"]);
    assert.equal(telemetry.spans.length, 1);
    assert.equal(telemetry.spans[0]?.name, "provider.session.release.idle-decision");
    assert.equal(telemetry.spans[0]?.status._tag, "Ended");
    assert.equal(telemetry.spans[0]?.attributes.get("decisionId"), [...decisionIds][0]);
  }).pipe(Effect.provide(telemetry.layer), Effect.withTracer(telemetry.tracer));
});

it.effect("decision spans are roots even when the timer was forked inside a request span", () => {
  const telemetry = captureTelemetry();
  return Effect.gen(function* () {
    const entry = candidate({ busyCount: 1 });
    const sessions = yield* Ref.make(new Map([[key, entry]]));
    yield* makeTracer(sessions)
      .begin(key, input, entry)
      .pipe(Effect.withSpan("orchestrationV2.dispatch.steerTurn"));

    const decision = telemetry.spans.find(
      (span) => span.name === "provider.session.release.idle-decision",
    );
    assert.isDefined(decision);
    assert.isTrue(Option.isNone(decision!.parent));
  }).pipe(Effect.provide(telemetry.layer), Effect.withTracer(telemetry.tracer));
});

for (const { overrides, decision } of [
  { overrides: { busyCount: 1 }, decision: "skip_active_turn" },
  { overrides: { idleGeneration: 2 }, decision: "skip_stale_generation" },
]) {
  it.effect(`explains ${decision} and offers no stop to report`, () => {
    const telemetry = captureTelemetry();
    return Effect.gen(function* () {
      const entry = candidate(overrides);
      const sessions = yield* Ref.make(new Map([[key, entry]]));
      const trace = yield* makeTracer(sessions).begin(key, input, entry);
      yield* trace.stopRequested();
      yield* trace.stopFinished();
      assert.deepEqual(
        telemetry.logs.map((log) => log.message[0]),
        ["provider.session.release.candidate", "provider.session.release.decision"],
      );
      assert.equal(telemetry.logs[1]?.annotations.decision, decision);
    }).pipe(Effect.provide(telemetry.layer), Effect.withTracer(telemetry.tracer));
  });
}

it.effect("ends each background-work decision span before the timer waits again", () => {
  const telemetry = captureTelemetry();
  return Effect.gen(function* () {
    const entry = candidate();
    const sessions = yield* Ref.make(new Map([[key, entry]]));
    const trace = yield* makeTracer(sessions).begin(key, input, entry);
    yield* trace.deferredForBackgroundWork(250);
    assert.equal(telemetry.logs[1]?.annotations.decision, "skip_background_work");
    assert.equal(telemetry.logs[1]?.annotations.pinnedForMs, 250);
    assert.equal(telemetry.spans.length, 1);
    assert.equal(telemetry.spans[0]?.status._tag, "Ended");
  }).pipe(Effect.provide(telemetry.layer), Effect.withTracer(telemetry.tracer));
});

it.effect("names an expired background pin in the stop decision", () => {
  const telemetry = captureTelemetry();
  return Effect.gen(function* () {
    const entry = candidate();
    const sessions = yield* Ref.make(new Map([[key, entry]]));
    const trace = yield* makeTracer(sessions).begin(key, input, entry);
    yield* trace.pinExpired(4000);
    yield* trace.stopRequested();
    const decisions = telemetry.logs.filter(
      (log) => log.message[0] === "provider.session.release.decision",
    );
    assert.deepEqual(
      decisions.map((log) => log.annotations.decision),
      ["stop_expired_background_pin"],
    );
    assert.equal(decisions[0]?.annotations.pinnedForMs, 4000);
    assert.equal(decisions[0]?.annotations.reason, "idle_timeout");
  }).pipe(Effect.provide(telemetry.layer), Effect.withTracer(telemetry.tracer));
});

it.effect("explains a change during the background probe", () => {
  const telemetry = captureTelemetry();
  return Effect.gen(function* () {
    const entry = candidate();
    const sessions = yield* Ref.make(new Map([[key, entry]]));
    const trace = yield* makeTracer(sessions).begin(key, input, entry);
    yield* trace.changedDuringBackgroundProbe();
    assert.equal(
      telemetry.logs.at(-1)?.annotations.decision,
      "skip_changed_during_background_probe",
    );
  }).pipe(Effect.provide(telemetry.layer), Effect.withTracer(telemetry.tracer));
});

it.effect("does not report a guarded no-op release as the entry being removed", () => {
  const telemetry = captureTelemetry();
  return Effect.gen(function* () {
    const entry = candidate();
    const sessions = yield* Ref.make(new Map([[key, entry]]));
    const trace = yield* makeTracer(sessions).begin(key, input, entry);
    yield* trace.stopRequested();
    // The manager's atomic guard left the entry in place: a turn started.
    yield* Ref.set(sessions, new Map([[key, { ...entry, busyCount: 1, idleGeneration: 2 }]]));
    yield* trace.stopFinished();
    assert.equal(telemetry.logs.at(-1)?.annotations.result, "entry_still_resident");
    assert.equal(telemetry.logs.at(-1)?.annotations.currentBusyCount, 1);
    assert.equal(telemetry.logs.at(-1)?.annotations.currentGeneration, 2);
  }).pipe(Effect.provide(telemetry.layer), Effect.withTracer(telemetry.tracer));
});
