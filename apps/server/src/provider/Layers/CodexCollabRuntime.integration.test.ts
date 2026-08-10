/**
 * Runtime-level collab regression: boots the REAL CodexSessionRuntime against
 * a scripted mock app-server peer that replays the captured multi-agent wire
 * sequence (codexMultiAgentWire.json) plus the shapes the capture alone can't
 * script (receiver-turn bookkeeping via collabAgentToolCall, child terminal
 * lifecycle, approval pass-through). This is the layer the pure routing-table
 * test can't reach: ordering between the legacy receiver-turn suppressor and
 * v2 interception, registration state, and synthetic event emission.
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  CodexSettings,
  EventId,
  type ProviderEvent,
  ProviderDriverKind,
  type ProviderSession,
  RuntimeTaskId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { assert, describe } from "vite-plus/test";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import wireFixture from "../testFixtures/codexMultiAgentWire.json" with { type: "json" };
import { makeCodexAdapter } from "./CodexAdapter.ts";
import {
  type CodexSessionRuntimeOptions,
  type CodexSessionRuntimeShape,
  makeCodexSessionRuntime,
} from "./CodexSessionRuntime.ts";

const ROOT = wireFixture.rootThreadId;
const [CHILD_A, CHILD_B] = wireFixture.childThreadIds as [string, string];
const ROOT_TURN = wireFixture.responses.turnStart.turn.id;
const decodeCodexSettings = Schema.decodeSync(CodexSettings);

type WireNotification = (typeof wireFixture.notifications)[number];

function isChildTurnStarted(entry: WireNotification, child: string): boolean {
  return (
    entry.method === "turn/started" && (entry.params as { threadId?: string }).threadId === child
  );
}

function isChildTurnCompleted(entry: WireNotification, child: string): boolean {
  return (
    entry.method === "turn/completed" && (entry.params as { threadId?: string }).threadId === child
  );
}

function isChildRegistration(entry: WireNotification, child: string): boolean {
  const item = (entry.params as { item?: { type?: string; agentThreadId?: string } }).item;
  return item?.type === "subAgentActivity" && item.agentThreadId === child;
}

function isChildTokenUsage(entry: WireNotification, child: string): boolean {
  return (
    entry.method === "thread/tokenUsage/updated" &&
    (entry.params as { threadId?: string }).threadId === child
  );
}

function capturedNotification(
  predicate: (entry: WireNotification) => boolean,
  description: string,
): WireNotification {
  const entry = wireFixture.notifications.find(predicate);
  assert.isDefined(entry, `capture is missing ${description}`);
  return entry;
}

function legacyCollabNotification(
  child: string,
  id: string,
  status: "running" | "completed",
): WireNotification {
  const captured = capturedNotification(
    (entry) =>
      entry.method === "item/completed" &&
      (entry.params as { item?: { type?: string } }).item?.type === "collabAgentToolCall",
    "a completed collabAgentToolCall",
  );
  const params = captured.params as {
    item: Record<string, unknown>;
    threadId: string;
    turnId: string;
    completedAtMs: number;
  };
  return {
    ...captured,
    params: {
      ...params,
      item: {
        ...params.item,
        id,
        receiverThreadIds: [child],
        prompt: "Inspect the collaboration handoff",
        agentsStates: {
          [child]: {
            status,
            ...(status === "completed" ? { message: "legacy completion must not duplicate" } : {}),
          },
        },
      },
    },
  } as unknown as WireNotification;
}

function childItemNotification(child: string, id: string): WireNotification {
  return {
    method: "item/completed",
    params: {
      threadId: child,
      turnId: `${child}-turn-1`,
      completedAtMs: 1_785_898_349_931,
      item: {
        type: "commandExecution",
        id,
        command: "rg handoff",
        cwd: "/workspace/repo",
        processId: null,
        status: "completed",
        commandActions: [],
        aggregatedOutput: "handoff",
        exitCode: 0,
        durationMs: 10,
      },
    },
  } as unknown as WireNotification;
}

function retryableChildError(child: string): WireNotification {
  return {
    method: "error",
    params: {
      threadId: child,
      turnId: `${child}-turn-1`,
      error: { message: "retrying child transport" },
      willRetry: true,
    },
  } as unknown as WireNotification;
}

/**
 * The captured sequence, extended with the shapes the live capture didn't
 * include: a collabAgentToolCall with receiverThreadIds (feeds the legacy
 * receiver-turn map, so ordering vs. v2 interception is exercised), child
 * terminal lifecycle, and a serverRequest/resolved addressed to a child
 * (must pass through to the parent path, not vanish).
 */
function buildScript() {
  const captured = wireFixture.notifications;
  const childATerminal = capturedNotification(
    (entry) => isChildTurnCompleted(entry, CHILD_A),
    "child A turn/completed",
  );
  const extras = [
    // Native registration already owns A. A legacy terminal snapshot must
    // neither restart nor settle it through t3/task/*.
    legacyCollabNotification(CHILD_A, "call_native_then_legacy", "completed"),
    retryableChildError(CHILD_A),
    childItemNotification(CHILD_A, "child-a-command"),
    // Child terminal lifecycle AFTER the receiver map knows the children —
    // pre-fix, the legacy suppressor dropped these before interception saw
    // them, so no synthetic agent events were emitted.
    childATerminal,
    { method: "thread/closed", params: { threadId: CHILD_B } },
    // Parent-owned traffic addressed to a child conversation: must reach the
    // parent path (approval correlation cleanup), not be swallowed.
    { method: "serverRequest/resolved", params: { threadId: CHILD_A, requestId: "req-1" } },
  ];
  return {
    rootThreadId: ROOT,
    notifications: [
      ...captured.filter((entry) => !isChildTurnCompleted(entry, CHILD_A)),
      ...extras,
    ],
  };
}

const scriptPath = NodePath.join(import.meta.dirname, "../testFixtures/.collab-script.json");
const peerPath = NodePath.join(import.meta.dirname, "../testFixtures/codexCollabMockPeer.sh");
const peerModulePath = NodePath.join(
  import.meta.dirname,
  "../testFixtures/codexCollabMockPeer.mjs",
);
const windowsPeerPath = NodePath.join(
  import.meta.dirname,
  "../testFixtures/.codex-collab-peer.cmd",
);

function preparePeerBinary(isWindows: boolean): string {
  if (!isWindows) {
    return peerPath;
  }
  NodeFS.writeFileSync(
    windowsPeerPath,
    `@echo off\r\n"${process.execPath}" "${peerModulePath}"\r\n`,
    "utf8",
  );
  return windowsPeerPath;
}

function removePreparedPeerBinary(isWindows: boolean): void {
  if (isWindows) {
    NodeFS.rmSync(windowsPeerPath, { force: true });
  }
}

const providerSessionDirectoryTestLayer = Layer.succeed(ProviderSessionDirectory, {
  upsert: () => Effect.void,
  getProvider: () =>
    Effect.die(new Error("ProviderSessionDirectory.getProvider is not used in test")),
  getBinding: () => Effect.succeed(Option.none()),
  listThreadIds: () => Effect.succeed([]),
  listBindings: () => Effect.succeed([]),
});

function makeMappingRuntime(
  options: CodexSessionRuntimeOptions,
  eventQueue: Queue.Queue<ProviderEvent>,
) {
  const now = "2026-08-07T10:00:00.000Z";
  const session = {
    provider: ProviderDriverKind.make("codex"),
    ...(options.providerInstanceId ? { providerInstanceId: options.providerInstanceId } : {}),
    status: "ready",
    runtimeMode: options.runtimeMode,
    cwd: options.cwd,
    threadId: options.threadId,
    createdAt: now,
    updatedAt: now,
  } satisfies ProviderSession;
  const runtime: CodexSessionRuntimeShape = {
    start: () => Effect.succeed(session),
    getSession: Effect.succeed(session),
    sendTurn: () =>
      Effect.succeed({
        threadId: options.threadId,
        turnId: TurnId.make(ROOT_TURN),
      }),
    interruptTurn: () => Effect.void,
    readThread: Effect.succeed({ threadId: ROOT, turns: [] }),
    rollbackThread: () => Effect.succeed({ threadId: ROOT, turns: [] }),
    respondToRequest: () => Effect.void,
    respondToUserInput: () => Effect.void,
    events: Stream.fromQueue(eventQueue),
    close: Effect.void,
  };
  return {
    runtime,
    emit: (event: ProviderEvent) => Queue.offer(eventQueue, event).pipe(Effect.asVoid),
  };
}

describe("CodexAdapter native collab mapping", () => {
  it.effect("maps child start, token/item routing, and completed-idle linkage exactly", () => {
    let mappingRuntime: ReturnType<typeof makeMappingRuntime> | undefined;
    return Effect.gen(function* () {
      const adapter = yield* makeCodexAdapter(decodeCodexSettings({}), {
        makeRuntime: (options) =>
          Effect.gen(function* () {
            const eventQueue = yield* Queue.unbounded<ProviderEvent>();
            mappingRuntime = makeMappingRuntime(options, eventQueue);
            return mappingRuntime.runtime;
          }),
      });
      const threadId = ThreadId.make("thread-collab-mapping");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId,
        runtimeMode: "full-access",
      });
      assert.isDefined(mappingRuntime);

      const runtimeEventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) =>
            event.type === "task.started" ||
            event.type === "task.progress" ||
            event.type === "task.updated",
        ),
        Stream.take(4),
        Stream.runCollect,
        Effect.forkScoped,
      );
      let eventIndex = 0;
      const emitNative = (method: string, payload: Record<string, unknown>) =>
        mappingRuntime?.emit({
          id: EventId.make(`native-collab-${eventIndex++}`),
          kind: "notification",
          provider: ProviderDriverKind.make("codex"),
          createdAt: "2026-08-07T10:00:00.000Z",
          threadId,
          turnId: TurnId.make(ROOT_TURN),
          method,
          payload,
        } satisfies ProviderEvent) ?? Effect.die("mapping runtime was not initialized");
      const childIdentity = {
        agentThreadId: CHILD_A,
        nickname: "alpha",
        role: "explorer",
        agentPath: "/root/alpha",
      };

      yield* emitNative("collabAgent/activity", {
        ...childIdentity,
        activityKind: "started",
      });
      yield* emitNative("collabAgent/tokenUsage", {
        ...childIdentity,
        tokenUsage: {
          total: {
            totalTokens: 144,
            inputTokens: 100,
            cachedInputTokens: 40,
            outputTokens: 44,
            reasoningOutputTokens: 12,
          },
          last: { totalTokens: 1 },
        },
      });
      yield* emitNative("collabAgent/item", {
        ...childIdentity,
        item: { type: "commandExecution", command: "rg handoff" },
      });
      yield* emitNative("collabAgent/turnCompleted", {
        ...childIdentity,
        turn: { id: `${CHILD_A}-turn-1`, status: "completed", items: [] },
      });

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepEqual(
        runtimeEvents.map((event) => event.type),
        ["task.started", "task.progress", "task.progress", "task.updated"],
      );
      assert.deepEqual(runtimeEvents[0]?.payload, {
        taskId: RuntimeTaskId.make(CHILD_A),
        taskType: "subagent",
        nativeAgent: true,
        description: "alpha",
        title: "alpha",
        role: "explorer",
        agentPath: "/root/alpha",
        timelineBypass: true,
      });
      assert.deepEqual(runtimeEvents[1]?.payload, {
        taskId: RuntimeTaskId.make(CHILD_A),
        taskType: "subagent",
        nativeAgent: true,
        description: "alpha",
        title: "alpha",
        typedUsage: {
          totalTokens: 144,
          inputTokens: 100,
          cachedInputTokens: 40,
          outputTokens: 44,
          reasoningOutputTokens: 12,
        },
        timelineBypass: true,
      });
      assert.deepEqual(runtimeEvents[2]?.payload, {
        taskId: RuntimeTaskId.make(CHILD_A),
        taskType: "subagent",
        nativeAgent: true,
        description: "alpha",
        title: "alpha",
        summary: "rg handoff",
        timelineBypass: true,
      });
      assert.deepEqual(runtimeEvents[3]?.payload, {
        taskId: RuntimeTaskId.make(CHILD_A),
        status: "idle",
        taskType: "subagent",
        nativeAgent: true,
        role: "explorer",
        title: "alpha",
        agentPath: "/root/alpha",
        timelineBypass: true,
      });
      assert.deepEqual(
        runtimeEvents.map((event) => String(event.turnId)),
        [ROOT_TURN, ROOT_TURN, ROOT_TURN, ROOT_TURN],
      );

      yield* adapter.stopSession(threadId);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          ServerConfig.layerTest(process.cwd(), process.cwd()),
          ServerSettingsService.layerTest(),
          providerSessionDirectoryTestLayer,
        ).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
    );
  });
});

describe("CodexSessionRuntime collab integration", () => {
  it.effect("replays the captured fan-out into synthetic agent events without child leaks", () =>
    Effect.gen(function* () {
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      NodeFS.writeFileSync(scriptPath, JSON.stringify(buildScript()), "utf8");
      const isWindows = (yield* HostProcessPlatform) === "win32";
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          NodeFS.rmSync(scriptPath, { force: true });
          removePreparedPeerBinary(isWindows);
        }),
      );

      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("thread-collab-integration"),
        binaryPath: preparePeerBinary(isWindows),
        cwd: "/tmp",
        runtimeMode: "full-access",
        environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
      });

      const eventsFiber = yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.method === "turn/completed"),
        Stream.runCollect,
        Effect.forkScoped,
      );

      yield* runtime.start();
      yield* runtime.sendTurn({ input: "fan out" });

      const events = Array.from(yield* Fiber.join(eventsFiber));
      const methods = events.map((event) => event.method);

      // Native-first handoff: later legacy agentsStates snapshots are fully
      // claimed by the native registry. One child identity gets one start and
      // one terminal lifecycle, never a parallel t3/task row.
      const legacyChildEvents = events.filter((event) => {
        const payload = event.payload as { taskId?: string } | undefined;
        return event.method.startsWith("t3/task/") && payload?.taskId === CHILD_A;
      });
      assert.deepEqual(legacyChildEvents, []);

      const childAStarts = events.filter((event) => {
        const payload = event.payload as
          | { agentThreadId?: string; activityKind?: string }
          | undefined;
        return (
          payload?.agentThreadId === CHILD_A &&
          (event.method === "collabAgent/started" ||
            (event.method === "collabAgent/activity" && payload.activityKind === "started"))
        );
      });
      assert.equal(childAStarts.length, 1, "native-first handoff must emit one start");

      const childATurnStarts = events.filter(
        (event) =>
          event.method === "collabAgent/turnStarted" &&
          (event.payload as { agentThreadId?: string }).agentThreadId === CHILD_A,
      );
      assert.equal(childATurnStarts.length, 1, "child A must have one active lifecycle");

      const childATerminals = events.filter(
        (event) =>
          event.method === "collabAgent/turnCompleted" &&
          (event.payload as { agentThreadId?: string }).agentThreadId === CHILD_A,
      );
      assert.equal(childATerminals.length, 1, "child A must settle exactly once");

      const childAOwnedEvents = events.filter(
        (event) =>
          (event.payload as { agentThreadId?: string } | undefined)?.agentThreadId === CHILD_A,
      );
      assert.deepEqual(
        Array.from(new Set(childAOwnedEvents.map((event) => String(event.threadId)))),
        ["thread-collab-integration"],
        "all native child lifecycle belongs to the canonical parent session",
      );

      assert.isAbove(
        events.filter(
          (event) =>
            event.method === "collabAgent/tokenUsage" &&
            (event.payload as { agentThreadId?: string }).agentThreadId === CHILD_A,
        ).length,
        0,
        "child token usage must stay on the child agent path",
      );
      assert.equal(
        events.filter(
          (event) =>
            event.method === "collabAgent/item" &&
            (event.payload as { agentThreadId?: string }).agentThreadId === CHILD_A,
        ).length,
        1,
        "child items must stay on the child agent path",
      );
      assert.equal(
        events.filter((event) => {
          const payload = event.payload as {
            agentThreadId?: string;
            status?: { type?: string };
          };
          return (
            event.method === "collabAgent/statusChanged" &&
            payload.agentThreadId === CHILD_A &&
            payload.status?.type === "systemError"
          );
        }).length,
        0,
        "a retryable child error must not settle the still-live child",
      );

      // Children registered from subAgentActivity become synthetic agent
      // lifecycle — including terminal rows that arrive AFTER the receiver
      // map knows them (the ordering this test exists to pin).
      assert.include(methods, "collabAgent/activity");
      assert.include(methods, "collabAgent/turnCompleted");
      assert.include(methods, "collabAgent/closed");

      const childTurnCompleted = events.find(
        (event) =>
          event.method === "collabAgent/turnCompleted" &&
          (event.payload as { agentThreadId?: string }).agentThreadId === CHILD_A,
      );
      assert.isDefined(childTurnCompleted, "child A's turn completion becomes an agent event");
      assert.deepEqual(childTurnCompleted?.payload, {
        agentThreadId: CHILD_A,
        nickname: "alpha",
        agentPath: "/root/alpha",
        turn: (
          capturedNotification(
            (entry) => isChildTurnCompleted(entry, CHILD_A),
            "child A turn/completed",
          ).params as { turn: unknown }
        ).turn,
      });

      const childClosed = events.find(
        (event) =>
          event.method === "collabAgent/closed" &&
          (event.payload as { agentThreadId?: string }).agentThreadId === CHILD_B,
      );
      assert.isDefined(childClosed, "child B's close becomes an agent event");

      // Parent-owned resolution passes through — not swallowed, not
      // re-labelled as an agent event.
      assert.include(methods, "serverRequest/resolved");

      // The root's own subAgentActivity about "/root" must NOT register the
      // root as a child: the parent turn completion still flows.
      assert.include(methods, "turn/completed");

      // No raw child conversation methods leak onto the parent stream.
      const leaked = events.filter((event) => {
        const payload = event.payload as { threadId?: string } | undefined;
        const addressedToChild = payload?.threadId === CHILD_A || payload?.threadId === CHILD_B;
        return addressedToChild && (event.method?.startsWith("thread/") ?? false);
      });
      assert.deepEqual(
        leaked.map((event) => event.method),
        [],
        "child thread/* lifecycle must not appear as parent events",
      );

      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("hands a legacy task start to later native registration without duplication", () =>
    Effect.gen(function* () {
      const registration = capturedNotification(
        (entry) => isChildRegistration(entry, CHILD_A),
        "child A registration",
      );
      const turnStarted = capturedNotification(
        (entry) => isChildTurnStarted(entry, CHILD_A),
        "child A turn/started",
      );
      const tokenUsage = capturedNotification(
        (entry) => isChildTokenUsage(entry, CHILD_A),
        "child A token usage",
      );
      const turnCompleted = capturedNotification(
        (entry) => isChildTurnCompleted(entry, CHILD_A),
        "child A turn/completed",
      );
      const script = {
        rootThreadId: ROOT,
        notifications: [
          legacyCollabNotification(CHILD_A, "call_legacy_then_native_start", "running"),
          registration,
          turnStarted,
          retryableChildError(CHILD_A),
          tokenUsage,
          childItemNotification(CHILD_A, "legacy-first-child-command"),
          turnCompleted,
          legacyCollabNotification(CHILD_A, "call_legacy_then_native_done", "completed"),
        ],
      };

      // @effect-diagnostics-next-line preferSchemaOverJson:off
      NodeFS.writeFileSync(scriptPath, JSON.stringify(script), "utf8");
      const isWindows = (yield* HostProcessPlatform) === "win32";
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          NodeFS.rmSync(scriptPath, { force: true });
          removePreparedPeerBinary(isWindows);
        }),
      );

      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("thread-collab-legacy-first"),
        binaryPath: preparePeerBinary(isWindows),
        cwd: "/tmp",
        runtimeMode: "full-access",
        environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
      });
      const eventsFiber = yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.method === "turn/completed"),
        Stream.runCollect,
        Effect.forkScoped,
      );

      yield* runtime.start();
      yield* runtime.sendTurn({ input: "legacy then native" });

      const events = Array.from(yield* Fiber.join(eventsFiber));
      const childStarts = events.filter((event) => {
        const payload = event.payload as
          | {
              taskId?: string;
              agentThreadId?: string;
              activityKind?: string;
            }
          | undefined;
        return (
          (event.method === "t3/task/started" && payload?.taskId === CHILD_A) ||
          (payload?.agentThreadId === CHILD_A &&
            (event.method === "collabAgent/started" ||
              (event.method === "collabAgent/activity" && payload.activityKind === "started")))
        );
      });
      assert.equal(childStarts.length, 1, "handoff must preserve exactly one start");
      assert.equal(childStarts[0]?.method, "t3/task/started");
      assert.equal(String(childStarts[0]?.turnId), ROOT_TURN);
      assert.deepEqual(childStarts[0]?.payload, {
        taskId: CHILD_A,
        description: "Inspect the collaboration handoff",
        prompt: "Inspect the collaboration handoff",
      });

      const legacyTerminals = events.filter(
        (event) =>
          event.method === "t3/task/completed" &&
          (event.payload as { taskId?: string }).taskId === CHILD_A,
      );
      assert.deepEqual(legacyTerminals, [], "native ownership suppresses legacy settlement");

      const nativeTerminals = events.filter(
        (event) =>
          event.method === "collabAgent/turnCompleted" &&
          (event.payload as { agentThreadId?: string }).agentThreadId === CHILD_A,
      );
      assert.equal(nativeTerminals.length, 1, "the native child settles exactly once");
      assert.equal(String(nativeTerminals[0]?.threadId), "thread-collab-legacy-first");
      assert.deepEqual(nativeTerminals[0]?.payload, {
        agentThreadId: CHILD_A,
        nickname: "alpha",
        agentPath: "/root/alpha",
        turn: (turnCompleted.params as { turn: unknown }).turn,
      });

      const routedMethods = events
        .filter(
          (event) =>
            (event.payload as { agentThreadId?: string } | undefined)?.agentThreadId === CHILD_A,
        )
        .map((event) => event.method);
      assert.include(routedMethods, "collabAgent/turnStarted");
      assert.include(routedMethods, "collabAgent/tokenUsage");
      assert.include(routedMethods, "collabAgent/item");
      assert.deepEqual(
        Array.from(
          new Set(
            events
              .filter(
                (event) =>
                  (event.payload as { agentThreadId?: string } | undefined)?.agentThreadId ===
                  CHILD_A,
              )
              .map((event) => String(event.threadId)),
          ),
        ),
        ["thread-collab-legacy-first"],
        "native lifecycle stays owned by the canonical parent session",
      );
      assert.equal(
        events.filter((event) => {
          const payload = event.payload as {
            agentThreadId?: string;
            status?: { type?: string };
          };
          return (
            event.method === "collabAgent/statusChanged" &&
            payload.agentThreadId === CHILD_A &&
            payload.status?.type === "systemError"
          );
        }).length,
        0,
        "retryable errors keep the native child live until turn completion",
      );

      assert.include(
        events.map((event) => event.method),
        "turn/completed",
        "the root turn must remain visible after child handoff",
      );
      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  // it.live: the runtime talks to a real child process; under it.effect's
  // TestClock the internal timers freeze and the join never completes.
  it.live("Stop interrupts every live child regardless of registration timing", () =>
    Effect.gen(function* () {
      // Ordering + liveness torture for stop-everything: child A's
      // turn/started arrives BEFORE anything registers it (foreign
      // suppression path must record the live turn); child B's arrives after
      // registration; child A's interrupt HANGS (RPC never settles — worse
      // than rejecting) and the bounded deadline must still deliver B's and
      // the parent's interrupts. The turn stays open so children are live
      // when Stop fires.
      // Build from REAL captured rows (hand-written shapes fail notification
      // schema validation and are silently dropped): reorder so child A's
      // turn/started precedes its registration, and drop terminal rows so
      // children stay live when Stop fires.
      const byIndex = wireFixture.notifications;
      const isTurnStarted = (entry: (typeof byIndex)[number], child: string) =>
        entry.method === "turn/started" &&
        (entry.params as { threadId?: string }).threadId === child;
      const isRegistration = (entry: (typeof byIndex)[number], child: string) => {
        const item = (entry.params as { item?: { type?: string; agentThreadId?: string } }).item;
        return item?.type === "subAgentActivity" && item.agentThreadId === child;
      };
      const turnStartedA = byIndex.find((entry) => isTurnStarted(entry, CHILD_A));
      const turnStartedB = byIndex.find((entry) => isTurnStarted(entry, CHILD_B));
      const registrationA = byIndex.find((entry) => isRegistration(entry, CHILD_A));
      const registrationB = byIndex.find((entry) => isRegistration(entry, CHILD_B));
      assert.isDefined(turnStartedA);
      assert.isDefined(turnStartedB);
      assert.isDefined(registrationA);
      assert.isDefined(registrationB);
      const script = {
        rootThreadId: ROOT,
        holdTurnOpen: true,
        hangInterruptFor: CHILD_A,
        notifications: [turnStartedA, registrationA, registrationB, turnStartedB],
      };
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      NodeFS.writeFileSync(scriptPath, JSON.stringify(script), "utf8");
      const isWindows = (yield* HostProcessPlatform) === "win32";
      const interruptsPath = `${scriptPath}.interrupts`;
      NodeFS.rmSync(interruptsPath, { force: true });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          NodeFS.rmSync(scriptPath, { force: true });
          NodeFS.rmSync(interruptsPath, { force: true });
          removePreparedPeerBinary(isWindows);
        }),
      );

      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("thread-collab-stop"),
        binaryPath: preparePeerBinary(isWindows),
        cwd: "/tmp",
        runtimeMode: "full-access",
        environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
      });

      // Wait for both children's turnStarted signals to be processed before
      // stopping (B via the registered-child path; A only produces live-turn
      // bookkeeping, so key on B's synthetic event).
      const childBStartedFiber = yield* runtime.events.pipe(
        Stream.filter(
          (event) =>
            event.method === "collabAgent/turnStarted" &&
            (event.payload as { agentThreadId?: string }).agentThreadId === CHILD_B,
        ),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped,
      );

      yield* runtime.start();
      yield* runtime.sendTurn({ input: "fan out and hang" });
      const childBStarted = yield* Fiber.join(childBStartedFiber).pipe(
        Effect.timeoutOption("15 seconds"),
      );
      assert.isTrue(childBStarted._tag === "Some", "child B turnStarted never arrived");

      // Stop everything. A's interrupt hangs forever — the bounded child
      // deadline must expire and the parent interrupt must still be sent.
      yield* runtime.interruptTurn();

      const parseInterruptLine = (line: string) => JSON.parse(line) as { threadId?: string };
      const interrupted = NodeFS.readFileSync(interruptsPath, "utf8")
        .trim()
        .split("\n")
        .filter((line) => line.length > 0)
        .map(parseInterruptLine);
      const interruptedThreads = new Set(interrupted.map((entry) => entry.threadId));
      assert.isTrue(
        interruptedThreads.has(CHILD_A),
        "pre-registration child A must still receive the interrupt RPC",
      );
      assert.isTrue(interruptedThreads.has(CHILD_B), "registered child B must be interrupted");
      assert.isTrue(interruptedThreads.has(ROOT), "parent turn must be interrupted last");

      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("Stop targets the active turn when Codex has accepted a queued follow-up", () =>
    Effect.gen(function* () {
      const activeTurnId = "019fe3e8-f908-7f31-8d51-283f4a47897a";
      const queuedTurnId = "019fe3eb-8faf-7de3-a85b-ac64c7f9c8c3";
      const script = {
        rootThreadId: ROOT,
        holdTurnOpen: true,
        onlyFirstTurnStarts: true,
        turnIds: [activeTurnId, queuedTurnId],
        expectedActiveTurnId: activeTurnId,
        notifications: [],
      };
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      NodeFS.writeFileSync(scriptPath, JSON.stringify(script), "utf8");
      const interruptsPath = `${scriptPath}.interrupts`;
      NodeFS.rmSync(interruptsPath, { force: true });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          NodeFS.rmSync(scriptPath, { force: true });
          NodeFS.rmSync(interruptsPath, { force: true });
        }),
      );

      const runtime = yield* makeCodexSessionRuntime({
        threadId: ThreadId.make("thread-codex-queued-stop"),
        binaryPath: peerPath,
        cwd: "/tmp",
        runtimeMode: "full-access",
        environment: { ...process.env, T3_CODEX_COLLAB_SCRIPT: scriptPath },
      });

      yield* runtime.start();
      yield* runtime.sendTurn({ input: "keep working" });
      yield* runtime.sendTurn({ input: "queued follow-up" });
      yield* runtime.interruptTurn();

      const interrupts = NodeFS.readFileSync(interruptsPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { threadId?: string; turnId?: string });
      assert.deepEqual(interrupts.at(-1), {
        threadId: ROOT,
        turnId: activeTurnId,
      });

      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
