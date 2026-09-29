import * as NodePerfHooks from "node:perf_hooks";
import {
  MessageId,
  NodeId,
  ProviderDriverKind,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  RunAttemptId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ProviderAdapterEventStreamError, ProviderAdapterV2Event } from "./ProviderAdapter.ts";
import { makeProviderEventFlowStage } from "./ProviderEventFlowStage.ts";
import { makeProviderEventRoutingState, routeProviderEvent } from "./RunExecutionService.ts";
import {
  boundProviderToolResult,
  PROVIDER_TOOL_DETAIL_BYTES,
  PROVIDER_TOOL_RESULT_BYTES,
  sanitizeProviderEvent,
} from "./ProviderEventPayload.ts";

const driver = ProviderDriverKind.make("codex");
const providerSessionId = ProviderSessionId.make("session");
const NOW = DateTime.makeUnsafe("2026-09-29T00:00:00Z");
const options = { driver, providerSessionId };
const isProviderEvent = Schema.is(ProviderAdapterV2Event);

function progress(
  index: number,
  id = "tool",
  status: OrchestrationV2TurnItem["status"] = "running",
) {
  return {
    type: "turn_item.updated",
    driver,
    turnItem: {
      id: TurnItemId.make(id),
      type: "command_execution",
      threadId: ThreadId.make("thread"),
      runId: RunId.make("run"),
      nodeId: null,
      providerThreadId: ProviderThreadId.make("provider-thread"),
      providerTurnId: ProviderTurnId.make("provider-turn"),
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status,
      title: `Progress ${index}`,
      input: "run tests",
      output: `chunk ${index}: ${"x".repeat(256)}`,
      startedAt: NOW,
      completedAt: status === "completed" ? NOW : null,
      updatedAt: NOW,
    },
  } satisfies ProviderAdapterV2Event;
}

function terminal(): ProviderAdapterV2Event {
  return {
    type: "turn.terminal",
    driver,
    providerThreadId: ProviderThreadId.make("provider-thread"),
    providerTurnId: ProviderTurnId.make("provider-turn"),
    runOrdinal: 1,
    status: "completed",
    failure: null,
    threadDisposition: "reusable",
  };
}

describe("provider event flow stage", () => {
  it.effect("drains accepted finals before reporting a provider stream failure", () =>
    Effect.gen(function* () {
      const stage = yield* makeProviderEventFlowStage(options);
      const seen: ProviderAdapterV2Event[] = [];
      yield* stage.offer(progress(1, "tool", "completed"));
      yield* stage.offer(terminal());
      yield* stage.fail(
        Cause.fail(new ProviderAdapterEventStreamError({ ...options, cause: "transport failure" })),
      );
      const result = yield* stage.events.pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            seen.push(event);
          }),
        ),
        Effect.exit,
      );
      expect(Exit.isFailure(result)).toBe(true);
      expect(seen.map((event) => event.type)).toEqual(["turn_item.updated", "turn.terminal"]);
    }),
  );
  it.effect("measures a 10,000-update burst against the unbounded FIFO", () =>
    Effect.gen(function* () {
      const raw = Array.from({ length: 10_000 }, (_, index) => progress(index));
      const final = progress(10_000, "tool", "completed");
      const before = [...raw, final];
      const beforeBytes = before.reduce(
        (sum, event) => sum + Buffer.byteLength(testJson(event)),
        0,
      );
      const stage = yield* makeProviderEventFlowStage(options);
      const started = NodePerfHooks.performance.now();
      let peakItems = 0;
      let peakBytes = 0;
      for (const event of before) {
        yield* stage.offer(event);
        const usage = yield* stage.usage;
        peakItems = Math.max(peakItems, usage.items);
        peakBytes = Math.max(peakBytes, usage.bytes);
      }
      const offerMs = NodePerfHooks.performance.now() - started;
      yield* stage.end;
      const after = yield* stage.events.pipe(Stream.runCollect);
      const afterBytes = after.reduce((sum, event) => sum + Buffer.byteLength(testJson(event)), 0);
      expect(after).toHaveLength(2);
      expect(after[0]).toMatchObject({ turnItem: { title: "Progress 9999", status: "running" } });
      expect(after[1]).toEqual(final);
      expect(peakItems).toBe(2);
      expect(peakBytes).toBe(afterBytes);
      expect(yield* stage.usage).toEqual({ items: 0, bytes: 0 });
      process.stdout.write(
        testJson({
          measurement: "provider burst",
          beforeEvents: before.length,
          beforeBytes,
          afterEvents: after.length,
          afterBytes,
          peakItems,
          peakBytes,
          offerMs,
        }),
      );
    }),
  );

  it.effect("replaces in place and never crosses a terminal fence", () =>
    Effect.gen(function* () {
      const stage = yield* makeProviderEventFlowStage(options);
      yield* stage.offer(progress(1, "a"));
      yield* stage.offer(progress(1, "b"));
      yield* stage.offer(progress(2, "a"));
      yield* stage.offer(progress(3, "a", "completed"));
      yield* stage.offer(progress(4, "a"));
      yield* stage.offer(terminal());
      yield* stage.offer(progress(5, "a"));
      yield* stage.offer(progress(6, "a"));
      yield* stage.end;
      const events = yield* stage.events.pipe(Stream.runCollect);
      expect(
        events.map((event) =>
          event.type === "turn_item.updated" ? event.turnItem.title : event.type,
        ),
      ).toEqual([
        "Progress 2",
        "Progress 1",
        "Progress 3",
        "Progress 4",
        "turn.terminal",
        "Progress 6",
      ]);
    }),
  );

  it.effect("retains waiting, pending and settled transitions", () =>
    Effect.gen(function* () {
      const stage = yield* makeProviderEventFlowStage(options);
      const statuses = [
        "pending",
        "running",
        "waiting",
        "running",
        "failed",
        "cancelled",
        "interrupted",
        "completed",
      ] as const;
      for (const [index, status] of statuses.entries())
        yield* stage.offer(progress(index, "tool", status));
      yield* stage.end;
      const events = yield* stage.events.pipe(Stream.runCollect);
      expect(
        events.map((event) => (event.type === "turn_item.updated" ? event.turnItem.status : null)),
      ).toEqual(statuses);
    }),
  );

  it.effect("coalesces ACP node/item pairs while preserving every routing identity", () =>
    Effect.gen(function* () {
      const stage = yield* makeProviderEventFlowStage(options);
      const base = progress(0);
      const node = {
        id: NodeId.make("tool-node"),
        threadId: base.turnItem.threadId,
        runId: base.turnItem.runId,
        parentNodeId: null,
        rootNodeId: NodeId.make("root"),
        kind: "tool_call",
        status: "running",
        countsForRun: true,
        providerThreadId: base.turnItem.providerThreadId,
        providerTurnId: base.turnItem.providerTurnId,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: NOW,
        completedAt: null,
      } as const;
      const identity = {
        threadId: node.threadId,
        runId: node.runId,
        attemptId: RunAttemptId.make("attempt"),
        providerThreadId: node.providerThreadId,
      };
      let rawRouting = makeProviderEventRoutingState({
        identity,
        providerTurnId: node.providerTurnId,
      });
      for (let index = 0; index < 10_000; index++) {
        for (const event of [
          { type: "node.updated", driver, node },
          progress(index),
        ] satisfies ProviderAdapterV2Event[]) {
          rawRouting = routeProviderEvent(event, identity, rawRouting)[1];
          yield* stage.offer(event);
        }
      }
      const changed: ProviderAdapterV2Event = {
        type: "node.updated",
        driver,
        node: { ...node, providerThreadId: ProviderThreadId.make("new-provider-thread") },
      };
      rawRouting = routeProviderEvent(changed, identity, rawRouting)[1];
      yield* stage.offer(changed);
      yield* stage.offer(progress(10_000, "tool", "completed"));
      yield* stage.end;
      const events = yield* stage.events.pipe(Stream.runCollect);
      expect(events).toHaveLength(4);
      let coalescedRouting = makeProviderEventRoutingState({
        identity,
        providerTurnId: node.providerTurnId,
      });
      for (const event of events)
        coalescedRouting = routeProviderEvent(event, identity, coalescedRouting)[1];
      expect(coalescedRouting).toEqual(rawRouting);
      expect(events.map((event) => event.type)).toEqual([
        "node.updated",
        "turn_item.updated",
        "node.updated",
        "turn_item.updated",
      ]);
    }),
  );

  it.effect("does not collide across threads, turns, runs or event types", () =>
    Effect.gen(function* () {
      const stage = yield* makeProviderEventFlowStage(options);
      const base = progress(1);
      const events = [
        base,
        { ...base, turnItem: { ...base.turnItem, threadId: ThreadId.make("other") } },
        { ...base, turnItem: { ...base.turnItem, runId: RunId.make("other") } },
        { ...base, turnItem: { ...base.turnItem, providerTurnId: ProviderTurnId.make("other") } },
        {
          type: "message.updated",
          driver,
          message: {
            id: MessageId.make("tool"),
            threadId: base.turnItem.threadId,
            runId: base.turnItem.runId,
            nodeId: null,
            role: "assistant",
            text: "latest",
            attachments: [],
            streaming: true,
            createdBy: "agent",
            creationSource: "provider",
            createdAt: NOW,
            updatedAt: NOW,
          },
        },
      ] satisfies ProviderAdapterV2Event[];
      for (const event of events) yield* stage.offer(event);
      yield* stage.end;
      expect(yield* stage.events.pipe(Stream.runCollect)).toHaveLength(events.length);
    }),
  );

  it.effect("retains irreducible latest states and finals above pressure targets", () =>
    Effect.gen(function* () {
      const stage = yield* makeProviderEventFlowStage({ ...options, maxItems: 2, maxBytes: 100 });
      for (let i = 0; i < 1_100; i++) yield* stage.offer(progress(i, `tool-${i}`, "completed"));
      yield* stage.offer(terminal());
      expect((yield* stage.usage).items).toBe(1_101);
      yield* stage.end;
      const received = yield* stage.events.pipe(Stream.runCollect);
      expect(received).toHaveLength(1_101);
      expect(received.at(-1)).toEqual(terminal());
    }),
  );

  it.effect("keeps the last state of distinct entities while a consumer is held", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const stage = yield* makeProviderEventFlowStage({ ...options, maxItems: 1, maxBytes: 100 });
      const seen: ProviderAdapterV2Event[] = [];
      yield* stage.offer(progress(1));
      const consumer = yield* stage.events.pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            seen.push(event);
            if (seen.length === 1) {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
            }
          }),
        ),
        Effect.forkScoped,
      );
      yield* Deferred.await(entered);
      yield* stage.offer(progress(2, "different"));
      yield* stage.offer(progress(3, "different", "completed"));
      yield* stage.offer(terminal());
      yield* stage.end;
      expect((yield* stage.usage).items).toBe(4);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(consumer);
      expect(
        seen.map((event) =>
          event.type === "turn_item.updated" ? event.turnItem.status : event.type,
        ),
      ).toEqual(["running", "running", "completed", "turn.terminal"]);
    }).pipe(Effect.scoped),
  );

  it.effect("close clears a stalled buffer and wakes an idle consumer", () =>
    Effect.gen(function* () {
      const stage = yield* makeProviderEventFlowStage(options);
      yield* stage.offer(progress(1));
      yield* stage.close;
      yield* stage.offer(progress(2));
      expect(yield* stage.events.pipe(Stream.runCollect)).toEqual([]);
      expect(yield* stage.usage).toEqual({ items: 0, bytes: 0 });
      const idle = yield* makeProviderEventFlowStage(options);
      const consumer = yield* idle.events.pipe(Stream.runCollect, Effect.forkScoped);
      yield* idle.close;
      expect(yield* Fiber.join(consumer)).toEqual([]);
    }).pipe(Effect.scoped),
  );
});

describe("provider tool payloads", () => {
  it("removes intermediate data and caps final output in UTF-8 bytes without mutating adapter state", () => {
    const base = progress(1);
    const input = {
      ...base,
      turnItem: {
        ...base.turnItem,
        title: "界".repeat(10_000),
        output: "界\u0000".repeat(100_000),
      },
    };
    const running = sanitizeProviderEvent(input);
    const final = sanitizeProviderEvent({
      ...input,
      turnItem: { ...input.turnItem, status: "completed" },
    });
    expect(running).toMatchObject({ turnItem: { status: "running" } });
    if (
      running.type !== "turn_item.updated" ||
      final.type !== "turn_item.updated" ||
      final.turnItem.type !== "command_execution"
    )
      throw new Error("Unexpected event");
    expect("output" in running.turnItem).toBe(false);
    expect(Buffer.byteLength(running.turnItem.title!)).toBeLessThanOrEqual(
      PROVIDER_TOOL_DETAIL_BYTES,
    );
    expect(Buffer.byteLength(testJson(final.turnItem.output))).toBeLessThanOrEqual(
      PROVIDER_TOOL_RESULT_BYTES,
    );
    expect(final.turnItem.output).not.toContain("\uFFFD");
    expect(input.turnItem.output.length).toBe(200_000);
    expect(isProviderEvent(final)).toBe(true);
  });

  it("redacts nested fields and credentials embedded in JSON tool strings", () => {
    const base = progress(1);
    const tool = {
      ...base,
      turnItem: {
        ...base.turnItem,
        type: "dynamic_tool",
        toolName: "test",
        status: "completed",
        input: { password: "hidden-input", api_key: "hidden-key" },
        output: {
          authorization: "hidden-auth",
          nested: [{ refresh_token: "hidden-refresh" }],
          rawOutput: '{"secret":"hidden-secret"}\nAuthorization: Bearer hidden-bearer',
        },
      },
    } satisfies ProviderAdapterV2Event;
    const sanitized = sanitizeProviderEvent(tool);
    const json = testJson(sanitized);
    expect(json).not.toContain("hidden-");
    expect(json).toContain("[REDACTED]");
    expect(isProviderEvent(sanitized)).toBe(true);
    const running = sanitizeProviderEvent({
      ...tool,
      turnItem: { ...tool.turnItem, status: "running" },
    });
    expect(running).toMatchObject({
      turnItem: { input: { password: "[REDACTED]", api_key: "[REDACTED]" } },
    });
    if (running.type !== "turn_item.updated") throw new Error("Unexpected event");
    expect("output" in running.turnItem).toBe(false);
  });

  it("bounds large, deep and circular result structures including escaped characters", () => {
    const circular: Record<string, unknown> = {
      authorization: "secret",
      big: "\u0000界".repeat(100_000),
    };
    circular.self = circular;
    for (const value of [
      circular,
      Array.from({ length: 20_000 }, () => ({ password: "secret", data: "x".repeat(256) })),
      { rows: Array.from({ length: 1_000 }, () => ["x".repeat(1_000)]) },
    ]) {
      const output = testJson(boundProviderToolResult(value));
      expect(Buffer.byteLength(output)).toBeLessThanOrEqual(PROVIDER_TOOL_RESULT_BYTES);
      expect(output).not.toContain("secret");
    }
  });

  it("keeps typed file and search results decodable at the limit", () => {
    const base = progress(1).turnItem;
    const items = [
      {
        ...base,
        type: "file_change",
        fileName: "file.ts",
        status: "completed",
        diffStr: "界".repeat(100_000),
        oldStr: "old",
        newStr: "new",
        changes: [{ operation: "modify", path: "file.ts" }],
      },
      {
        ...base,
        type: "file_search",
        status: "completed",
        results: Array.from({ length: 1_000 }, () => ({
          fileName: "file.ts",
          preview: "x".repeat(1_000),
        })),
      },
      {
        ...base,
        type: "web_search",
        status: "completed",
        results: Array.from({ length: 1_000 }, () => ({
          url: "https://example.com",
          snippet: "x".repeat(1_000),
        })),
      },
    ] satisfies OrchestrationV2TurnItem[];
    for (const turnItem of items) {
      const sanitized = sanitizeProviderEvent({ type: "turn_item.updated", driver, turnItem });
      expect(isProviderEvent(sanitized)).toBe(true);
    }
  });
});

function testJson(value: unknown): string {
  return JSON.stringify(value);
}
