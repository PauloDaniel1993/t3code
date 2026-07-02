import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import {
  DEFAULT_DEEPSEEK_MODEL,
  DeepSeekSettings,
  ProviderDriverKind,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";

import { ProviderAdapterRequestError, ProviderAdapterValidationError } from "../Errors.ts";
import { makeDeepSeekAdapter } from "./DeepSeekAdapter.ts";
import { buildDeepSeekProviderSnapshot } from "./DeepSeekProvider.ts";

const decodeDeepSeekSettings = Schema.decodeSync(DeepSeekSettings);

const PROVIDER = ProviderDriverKind.make("deepseek");
const THREAD_ID = ThreadId.make("thread-deepseek-1");

// A ready DeepSeek environment: API key + base URL come from the environment,
// the rest of the readiness comes from settings (enabled + positive context
// limit + at least one model).
const READY_ENV: NodeJS.ProcessEnv = {
  DEEPSEEK_API_KEY: "ds-test-key",
  DEEPSEEK_BASE_URL: "https://api.deepseek.example/v1",
};

const readySettings = () => decodeDeepSeekSettings({ enabled: true });

// Build a fake HttpClient that responds with a fixed Web Response. The DeepSeek
// streaming path filters on status OK then reads `response.stream`, so an
// `text/event-stream` body of SSE frames exercises the real SSE parser.
function sseHttpClientLayer(body: string, status = 200) {
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(body, {
            status,
            headers: { "content-type": "text/event-stream" },
          }),
        ),
      ),
    ),
  );
}

// An HttpClient whose execute always fails the HTTP request itself. We model
// this with a non-OK status so `filterStatusOk` rejects it, which is the
// request-failure path the adapter maps to a runtime error.
function failingHttpClientLayer() {
  return sseHttpClientLayer("upstream is down", 500);
}

const sseFrame = (delta: string) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`;

const adapterLayer = (httpLayer: Layer.Layer<HttpClient.HttpClient>) =>
  httpLayer.pipe(Layer.provideMerge(NodeServices.layer));

const collectEventsUntil = (
  adapter: { readonly streamEvents: Stream.Stream<ProviderRuntimeEvent> },
  predicate: (event: ProviderRuntimeEvent) => boolean,
) =>
  // `streamEvents` is backed by `Stream.fromPubSub` over an unbounded PubSub,
  // which only delivers to subscribers that are already attached. The mock
  // HttpClient resolves synchronously, so without letting the forked collector
  // attach its subscription first it would miss `turn.completed` and the
  // `takeUntil` would hang. Yield a few scheduler hops after forking so the
  // subscription is live before the turn publishes events. `yieldNow` (rather
  // than a wall-clock sleep) keeps this deterministic under both `it.live` and
  // the `it.effect` TestClock.
  Stream.takeUntil(adapter.streamEvents, predicate).pipe(
    Stream.runCollect,
    Effect.forkChild,
    Effect.tap(() =>
      Effect.all([Effect.yieldNow, Effect.yieldNow, Effect.yieldNow, Effect.yieldNow]),
    ),
  );

describe("buildDeepSeekProviderSnapshot (provider readiness)", () => {
  it.effect("reports a disabled provider when DeepSeek is turned off", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildDeepSeekProviderSnapshot({
        settings: decodeDeepSeekSettings({ enabled: false }),
        environment: READY_ENV,
      });

      assert.equal(snapshot.enabled, false);
      assert.equal(snapshot.status, "disabled");
      assert.equal(snapshot.installed, false);
      assert.match(snapshot.message ?? "", /disabled/u);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("warns when required configuration is missing", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildDeepSeekProviderSnapshot({
        settings: decodeDeepSeekSettings({ enabled: true }),
        // No API key / base URL in the environment.
        environment: {},
      });

      assert.equal(snapshot.enabled, true);
      assert.equal(snapshot.status, "warning");
      assert.equal(snapshot.auth.status, "unauthenticated");
      assert.match(snapshot.message ?? "", /DEEPSEEK_API_KEY/u);
      assert.match(snapshot.message ?? "", /base URL/u);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reports ready when enabled with API key, base URL, models, and context limit", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildDeepSeekProviderSnapshot({
        settings: readySettings(),
        environment: READY_ENV,
      });

      assert.equal(snapshot.enabled, true);
      assert.equal(snapshot.status, "ready");
      assert.equal(snapshot.installed, true);
      assert.equal(snapshot.auth.status, "authenticated");
      assert.isTrue(snapshot.models.some((model) => model.slug === DEFAULT_DEEPSEEK_MODEL));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("DeepSeekAdapter", () => {
  // it.live: the streaming path reads a real Web ReadableStream and races it
  // against a wall-clock timeout, so it must run on the live runtime/clock
  // rather than the default TestClock.
  it.live("streams a successful turn into canonical runtime events", () =>
    Effect.gen(function* () {
      const adapter = yield* makeDeepSeekAdapter(readySettings(), { environment: READY_ENV });

      const eventsFiber = yield* collectEventsUntil(
        adapter,
        (event) => event.type === "turn.completed",
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: PROVIDER,
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "hello",
        attachments: [],
      });

      const events = Array.from(yield* Fiber.join(eventsFiber));
      const types = events.map((event) => event.type);

      assert.include(types, "turn.started");
      assert.include(types, "content.delta");
      assert.include(types, "item.completed");

      const deltas = events
        .filter((event) => event.type === "content.delta")
        .map((event) => (event.type === "content.delta" ? event.payload.delta : ""));
      assert.equal(deltas.join(""), "Hello world");

      const completed = events.find((event) => event.type === "turn.completed");
      assert.equal(completed?.type, "turn.completed");
      if (completed?.type === "turn.completed") {
        assert.equal(completed.payload.state, "completed");
        assert.equal(String(completed.turnId), String(turn.turnId));
      }

      // A completed turn persists chat history into the resume cursor.
      assert.isDefined(turn.resumeCursor);
    }).pipe(
      Effect.provide(
        adapterLayer(
          sseHttpClientLayer(`${sseFrame("Hello")}${sseFrame(" world")}data: [DONE]\n\n`),
        ),
      ),
    ),
  );

  it.live("emits runtime.error and a failed turn when the streaming request fails", () =>
    Effect.gen(function* () {
      const adapter = yield* makeDeepSeekAdapter(readySettings(), { environment: READY_ENV });

      const eventsFiber = yield* collectEventsUntil(
        adapter,
        (event) => event.type === "turn.completed",
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: PROVIDER,
        runtimeMode: "full-access",
      });

      const result = yield* adapter
        .sendTurn({ threadId: THREAD_ID, input: "hello", attachments: [] })
        .pipe(Effect.result);

      // The failing HTTP request surfaces as a request error to the caller.
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.instanceOf(result.failure, ProviderAdapterRequestError);
      }

      const events = Array.from(yield* Fiber.join(eventsFiber));
      const runtimeError = events.find((event) => event.type === "runtime.error");
      assert.equal(runtimeError?.type, "runtime.error");

      const completed = events.find((event) => event.type === "turn.completed");
      assert.equal(completed?.type, "turn.completed");
      if (completed?.type === "turn.completed") {
        assert.equal(completed.payload.state, "failed");
      }
    }).pipe(Effect.provide(adapterLayer(failingHttpClientLayer()))),
  );

  it.effect("fails sendTurn with a request error when DeepSeek is disabled", () =>
    Effect.gen(function* () {
      // Readiness is also enforced on the adapter request path: a disabled
      // provider rejects turns before any HTTP call is made.
      const adapter = yield* makeDeepSeekAdapter(decodeDeepSeekSettings({ enabled: false }), {
        environment: READY_ENV,
      });

      const result = yield* adapter
        .startSession({ threadId: THREAD_ID, provider: PROVIDER, runtimeMode: "full-access" })
        .pipe(Effect.result);

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.instanceOf(result.failure, ProviderAdapterRequestError);
        assert.match(result.failure.message, /disabled/u);
      }
    }).pipe(Effect.provide(adapterLayer(sseHttpClientLayer("")))),
  );

  it.effect("marks an active turn as interrupted via interruptTurn", () =>
    Effect.gen(function* () {
      const adapter = yield* makeDeepSeekAdapter(readySettings(), { environment: READY_ENV });

      const eventsFiber = yield* collectEventsUntil(
        adapter,
        (event) => event.type === "turn.completed" && event.payload.state === "interrupted",
      );

      yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: PROVIDER,
        runtimeMode: "full-access",
      });

      // Drive interruptTurn directly: the streaming HTTP response is held open
      // by `Effect.never`, so the turn is genuinely "active" when we interrupt.
      // We fork sendTurn so its (never-resolving) stream does not block us, then
      // interrupt the live turn out-of-band.
      const turnFiber = yield* adapter
        .sendTurn({ threadId: THREAD_ID, input: "long running", attachments: [] })
        .pipe(Effect.forkChild);

      // Let the forked turn run far enough to register as "running" and emit
      // turn.started before it blocks on the (never-resolving) stream.
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;

      yield* adapter.interruptTurn(THREAD_ID);

      const events = Array.from(yield* Fiber.join(eventsFiber));
      const completed = events.find(
        (event) => event.type === "turn.completed" && event.payload.state === "interrupted",
      );
      assert.equal(completed?.type, "turn.completed");
      if (completed?.type === "turn.completed") {
        assert.equal(completed.payload.state, "interrupted");
        assert.equal(completed.payload.stopReason, "interrupted");
      }

      yield* Fiber.interrupt(turnFiber);
    }).pipe(
      Effect.provide(
        adapterLayer(
          // Hold the streaming response open so interruptTurn races a live turn.
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make(() => Effect.never),
          ).pipe(Layer.provideMerge(NodeServices.layer)),
        ),
      ),
    ),
  );

  it.effect("rejects a corrupt resume cursor on startSession", () =>
    Effect.gen(function* () {
      const adapter = yield* makeDeepSeekAdapter(readySettings(), { environment: READY_ENV });

      const result = yield* adapter
        .startSession({
          threadId: THREAD_ID,
          provider: PROVIDER,
          runtimeMode: "full-access",
          // Wrong schema version / shape => normalizeResumeCursor returns undefined.
          resumeCursor: { schemaVersion: 999, model: "x", messages: [] },
        })
        .pipe(Effect.result);

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.instanceOf(result.failure, ProviderAdapterValidationError);
        assert.match(result.failure.message, /corrupt|unsupported|missing/u);
      }
    }).pipe(Effect.provide(adapterLayer(sseHttpClientLayer("")))),
  );

  it.effect("resumes prior chat history from a valid resume cursor", () =>
    Effect.gen(function* () {
      const adapter = yield* makeDeepSeekAdapter(readySettings(), { environment: READY_ENV });

      const session = yield* adapter.startSession({
        threadId: THREAD_ID,
        provider: PROVIDER,
        runtimeMode: "full-access",
        resumeCursor: {
          schemaVersion: 1,
          model: DEFAULT_DEEPSEEK_MODEL,
          messages: [
            { role: "user", content: "earlier question" },
            { role: "assistant", content: "earlier answer" },
          ],
        },
      });

      assert.equal(session.model, DEFAULT_DEEPSEEK_MODEL);
      assert.isDefined(session.resumeCursor);
    }).pipe(Effect.provide(adapterLayer(sseHttpClientLayer("")))),
  );
});
