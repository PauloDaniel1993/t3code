import { TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  applyCodexCollabNotification,
  codexCollabEmissionEvent,
  collabAgentLifecycleStatus,
  settleCodexCollabAgentByThread,
  settleCodexCollabAgentsForTurn,
  applyCodexChildThreadNotification,
  type CodexCollabNotification,
  type CollabAgentRecord,
} from "./codexCollabAgents.ts";

// The fixtures below are the shape Codex's app-server actually emits for a
// three-agent fan-out: one `collabAgentToolCall` item naming all three receiver
// threads, then further collab items (`wait`) restating `agentsStates` as each
// agent progresses and settles.

const PARENT_TURN = TurnId.make("turn-parent-1");
const CHILDREN = ["child-a", "child-b", "child-c"] as const;
const EMPTY: ReadonlyMap<string, CollabAgentRecord> = new Map();

function collabNotification(options: {
  readonly method?: "item/started" | "item/completed";
  readonly tool?: "spawnAgent" | "wait" | "sendInput" | "resumeAgent" | "closeAgent";
  readonly receivers: ReadonlyArray<string>;
  readonly states?: Readonly<Record<string, { status?: string; message?: string | null }>>;
  readonly prompt?: string;
}): CodexCollabNotification {
  return {
    method: options.method ?? "item/started",
    params: {
      threadId: "thread-parent",
      turnId: PARENT_TURN,
      item: {
        id: "item-collab-1",
        type: "collabAgentToolCall",
        tool: options.tool ?? "spawnAgent",
        senderThreadId: "thread-parent",
        receiverThreadIds: options.receivers,
        agentsStates: options.states ?? {},
        status: "inProgress",
        ...(options.prompt === undefined ? {} : { prompt: options.prompt }),
      },
    },
  };
}

const runningStates = (children: ReadonlyArray<string> = CHILDREN) =>
  Object.fromEntries(children.map((child) => [child, { status: "running" }]));

/** Spawn `children` and return the resulting record set. */
function spawned(
  children: ReadonlyArray<string> = CHILDREN,
  prompt?: string,
): ReadonlyMap<string, CollabAgentRecord> {
  return applyCodexCollabNotification(
    EMPTY,
    collabNotification({
      receivers: children,
      states: runningStates(children),
      ...(prompt === undefined ? {} : { prompt }),
    }),
    PARENT_TURN,
  ).next;
}

describe("collabAgentLifecycleStatus", () => {
  it.each([
    { status: "pendingInit", expected: "running" },
    { status: "running", expected: "running" },
    { status: "completed", expected: "completed" },
    { status: "errored", expected: "failed" },
    // Terminal, but the agent stopped rather than erred — reporting these as
    // failures would be a lie about what happened.
    { status: "interrupted", expected: "stopped" },
    { status: "shutdown", expected: "stopped" },
    { status: "notFound", expected: "stopped" },
    // A newer Codex must never fabricate a terminal row through this path.
    { status: "quiescing", expected: "running" },
    { status: undefined, expected: "running" },
  ])("maps $status to $expected", ({ status, expected }) => {
    expect(collabAgentLifecycleStatus(status)).toBe(expected);
  });
});

describe("applyCodexCollabNotification", () => {
  it("starts one agent per receiver thread on the spawning item", () => {
    const { next, emissions } = applyCodexCollabNotification(
      EMPTY,
      collabNotification({
        receivers: CHILDREN,
        states: runningStates(),
        prompt: "Inspect SidebarV2.tsx",
      }),
      PARENT_TURN,
    );

    expect(emissions).toHaveLength(3);
    expect(emissions.map((emission) => emission.taskId)).toEqual([...CHILDREN]);
    for (const emission of emissions) {
      expect(emission.kind).toBe("started");
      expect(emission.turnId).toBe(PARENT_TURN);
      expect(emission).toMatchObject({ prompt: "Inspect SidebarV2.tsx" });
    }
    expect(next.size).toBe(3);
  });

  it("does not restart an agent it has already seen", () => {
    // A `wait` call addresses the same receivers and restates their state; it is
    // not three more agents.
    const wait = applyCodexCollabNotification(
      spawned(),
      collabNotification({ tool: "wait", receivers: CHILDREN, states: runningStates() }),
      PARENT_TURN,
    );

    expect(wait.emissions).toEqual([]);
    expect(wait.next.size).toBe(3);
  });

  it("emits progress only when an agent's message changes", () => {
    const withMessage = collabNotification({
      tool: "wait",
      receivers: ["child-a"],
      states: { "child-a": { status: "running", message: "reading SidebarV2.tsx" } },
    });

    const first = applyCodexCollabNotification(spawned(["child-a"]), withMessage, PARENT_TURN);
    expect(first.emissions).toMatchObject([
      { kind: "progress", taskId: "child-a", message: "reading SidebarV2.tsx" },
    ]);

    // Same message restated on the next poll: nothing new to say.
    const repeat = applyCodexCollabNotification(first.next, withMessage, PARENT_TURN);
    expect(repeat.emissions).toEqual([]);
  });

  it.each([
    { status: "completed", expected: "completed" },
    { status: "errored", expected: "failed" },
    { status: "interrupted", expected: "stopped" },
    { status: "shutdown", expected: "stopped" },
    { status: "notFound", expected: "stopped" },
  ])("settles a $status agent as $expected", ({ status, expected }) => {
    const settled = applyCodexCollabNotification(
      spawned(["child-a"]),
      collabNotification({
        method: "item/completed",
        tool: "wait",
        receivers: ["child-a"],
        states: { "child-a": { status, message: "all done" } },
      }),
      PARENT_TURN,
    );

    expect(settled.emissions).toMatchObject([
      { kind: "completed", taskId: "child-a", status: expected, message: "all done" },
    ]);
  });

  it("does not settle an agent twice", () => {
    const done = collabNotification({
      method: "item/completed",
      tool: "wait",
      receivers: ["child-a"],
      states: { "child-a": { status: "completed" } },
    });
    const first = applyCodexCollabNotification(spawned(["child-a"]), done, PARENT_TURN);
    const second = applyCodexCollabNotification(first.next, done, PARENT_TURN);

    expect(first.emissions).toHaveLength(1);
    expect(second.emissions).toEqual([]);
  });

  it("ignores an agent it cannot attribute to a turn", () => {
    const { next, emissions } = applyCodexCollabNotification(
      EMPTY,
      collabNotification({ receivers: ["child-a"], states: runningStates(["child-a"]) }),
      undefined,
    );
    expect(emissions).toEqual([]);
    expect(next.size).toBe(0);
  });

  it("admits an agent whose state Codex never reported", () => {
    // Pre-`agentsStates` Codex versions name receivers but report no states.
    const { emissions } = applyCodexCollabNotification(
      EMPTY,
      collabNotification({ receivers: ["child-a"], states: {} }),
      PARENT_TURN,
    );
    expect(emissions).toMatchObject([{ kind: "started", taskId: "child-a" }]);
  });

  it("reports no description when the item carried no prompt", () => {
    const { emissions } = applyCodexCollabNotification(
      EMPTY,
      collabNotification({ receivers: ["child-a"], states: runningStates(["child-a"]) }),
      PARENT_TURN,
    );
    expect(emissions[0]).not.toHaveProperty("description");
    expect(emissions[0]).not.toHaveProperty("prompt");
  });

  it.each([
    { method: "turn/completed", params: { threadId: "t", turn: { id: "turn-1" } } },
    { method: "item/started", params: { item: { id: "i", type: "mcpToolCall", tool: "read" } } },
    { method: "item/completed", params: { item: { id: "i", type: "commandExecution" } } },
    { method: "item/started", params: undefined },
  ])("ignores $method that is not a collab item", (notification) => {
    const { next, emissions } = applyCodexCollabNotification(
      EMPTY,
      notification as CodexCollabNotification,
      PARENT_TURN,
    );
    expect(emissions).toEqual([]);
    expect(next.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// `subAgentActivity` — how current Codex reports its in-session agents.
//
// The fixtures below are the notifications captured verbatim from a live Codex
// (gpt-5.6) run of the three-sub-agent reproduction prompt. This is the sequence
// that produced no sidebar rows at all: the runtime only understood
// `collabAgentToolCall`, which these versions never emit.
// ---------------------------------------------------------------------------

const PARENT_PROVIDER_THREAD = "019fb221-231b-7e63-9ed7-a17cd576c321";
const OBSERVED_SPAWNS = [
  { agentPath: "/root/sidebar_native_ui", agentThreadId: "019fb221-6f34-7582-a427-cc598ecb148f" },
  {
    agentPath: "/root/native_agent_transitions",
    agentThreadId: "019fb221-a418-7942-bfa6-2c0aa8a466f7",
  },
  { agentPath: "/root/contract_fields", agentThreadId: "019fb221-d81c-7d30-bf39-b8699d998359" },
] as const;

function subAgentNotification(options: {
  readonly method?: "item/started" | "item/completed";
  readonly threadId?: string;
  readonly agentPath: string;
  readonly agentThreadId: string;
  readonly kind: "started" | "interacted" | "interrupted";
}): CodexCollabNotification {
  return {
    method: options.method ?? "item/completed",
    params: {
      completedAtMs: 1_785_399_973_556,
      threadId: options.threadId ?? PARENT_PROVIDER_THREAD,
      turnId: PARENT_TURN,
      item: {
        id: "call_QXpi2klrocu5aT34Bs8HpCCy",
        type: "subAgentActivity",
        agentPath: options.agentPath,
        agentThreadId: options.agentThreadId,
        kind: options.kind,
      },
    },
  };
}

describe("applyCodexCollabNotification: subAgentActivity", () => {
  it("starts an agent named by the last segment of its agent path", () => {
    const { next, emissions } = applyCodexCollabNotification(
      EMPTY,
      subAgentNotification({ ...OBSERVED_SPAWNS[0], kind: "started" }),
      PARENT_TURN,
    );

    expect(emissions).toMatchObject([
      {
        kind: "started",
        taskId: OBSERVED_SPAWNS[0].agentThreadId,
        turnId: PARENT_TURN,
        description: "sidebar_native_ui",
      },
    ]);
    expect(next.size).toBe(1);
  });

  it("starts one agent per spawn across the observed three-agent fan-out", () => {
    let state = EMPTY;
    const started: Array<string> = [];
    for (const spawn of OBSERVED_SPAWNS) {
      const result = applyCodexCollabNotification(
        state,
        subAgentNotification({ ...spawn, kind: "started" }),
        PARENT_TURN,
      );
      state = result.next;
      for (const emission of result.emissions) {
        if (emission.kind === "started") started.push(emission.description ?? "");
      }
    }
    expect(started).toEqual(["sidebar_native_ui", "native_agent_transitions", "contract_fields"]);
    expect(state.size).toBe(3);
  });

  it("does not start a second row when the spawn is restated", () => {
    const first = applyCodexCollabNotification(
      EMPTY,
      subAgentNotification({ ...OBSERVED_SPAWNS[0], kind: "started" }),
      PARENT_TURN,
    );
    // Codex reports the spawn on `item/completed`; an `item/started` for the same
    // tool call must not double it.
    const second = applyCodexCollabNotification(
      first.next,
      subAgentNotification({
        ...OBSERVED_SPAWNS[0],
        kind: "started",
        method: "item/started",
      }),
      PARENT_TURN,
    );
    expect(second.emissions).toEqual([]);
    expect(second.next.size).toBe(1);
  });

  it("ignores a child reporting back to the parent", () => {
    // `interacted` arrives on the CHILD's thread with `agentPath: "/root"` and
    // `agentThreadId` pointing at the parent. Admitting that would create a row
    // for the conversation itself.
    const spawned = applyCodexCollabNotification(
      EMPTY,
      subAgentNotification({ ...OBSERVED_SPAWNS[1], kind: "started" }),
      PARENT_TURN,
    ).next;

    const interacted = applyCodexCollabNotification(
      spawned,
      subAgentNotification({
        method: "item/completed",
        threadId: OBSERVED_SPAWNS[1].agentThreadId,
        agentPath: "/root",
        agentThreadId: PARENT_PROVIDER_THREAD,
        kind: "interacted",
      }),
      PARENT_TURN,
    );

    expect(interacted.emissions).toEqual([]);
    expect(interacted.next.size).toBe(1);
    expect(interacted.next.has(PARENT_PROVIDER_THREAD)).toBe(false);
  });

  it("never admits a row for the conversation itself", () => {
    const { next, emissions } = applyCodexCollabNotification(
      EMPTY,
      subAgentNotification({
        agentPath: "/root",
        agentThreadId: PARENT_PROVIDER_THREAD,
        kind: "started",
      }),
      PARENT_TURN,
    );
    expect(emissions).toEqual([]);
    expect(next.size).toBe(0);
  });

  it("settles an interrupted agent as stopped", () => {
    const spawned = applyCodexCollabNotification(
      EMPTY,
      subAgentNotification({ ...OBSERVED_SPAWNS[0], kind: "started" }),
      PARENT_TURN,
    ).next;

    const interrupted = applyCodexCollabNotification(
      spawned,
      subAgentNotification({ ...OBSERVED_SPAWNS[0], kind: "interrupted" }),
      PARENT_TURN,
    );
    expect(interrupted.emissions).toMatchObject([
      { kind: "completed", taskId: OBSERVED_SPAWNS[0].agentThreadId, status: "stopped" },
    ]);
    // And not twice.
    expect(
      applyCodexCollabNotification(
        interrupted.next,
        subAgentNotification({ ...OBSERVED_SPAWNS[0], kind: "interrupted" }),
        PARENT_TURN,
      ).emissions,
    ).toEqual([]);
  });

  it("ignores an interruption for an agent it never tracked", () => {
    expect(
      applyCodexCollabNotification(
        EMPTY,
        subAgentNotification({ ...OBSERVED_SPAWNS[0], kind: "interrupted" }),
        PARENT_TURN,
      ).emissions,
    ).toEqual([]);
  });

  it("ignores a spawn it cannot attribute to a turn", () => {
    expect(
      applyCodexCollabNotification(
        EMPTY,
        subAgentNotification({ ...OBSERVED_SPAWNS[0], kind: "started" }),
        undefined,
      ).emissions,
    ).toEqual([]);
  });

  it("ignores a nested sub-sub-agent spawn", () => {
    // One level of nesting: a spawn observed on a thread that is itself one of
    // our agents does not become a second parent row.
    const spawned = applyCodexCollabNotification(
      EMPTY,
      subAgentNotification({ ...OBSERVED_SPAWNS[0], kind: "started" }),
      PARENT_TURN,
    ).next;

    const nested = applyCodexCollabNotification(
      spawned,
      subAgentNotification({
        threadId: OBSERVED_SPAWNS[0].agentThreadId,
        agentPath: "/root/sidebar_native_ui/deep",
        agentThreadId: "019fb221-nested-child",
        kind: "started",
      }),
      PARENT_TURN,
    );
    expect(nested.emissions).toEqual([]);
    expect(nested.next.size).toBe(1);
  });

  it("ignores an unrecognised activity kind from a newer Codex", () => {
    expect(
      applyCodexCollabNotification(
        EMPTY,
        subAgentNotification({ ...OBSERVED_SPAWNS[0], kind: "resumed" as "started" }),
        PARENT_TURN,
      ).emissions,
    ).toEqual([]);
  });
});

// A tracked agent's own `agentMessage` items, captured from the same live run.
// `phase` is `commentary` while it works and `final_answer` when it is done.
function childMessageNotification(options: {
  readonly threadId: string;
  readonly text: string;
  readonly phase?: "commentary" | "final_answer" | null;
  readonly method?: "item/started" | "item/completed";
  readonly type?: string;
}): CodexCollabNotification {
  return {
    method: options.method ?? "item/completed",
    params: {
      completedAtMs: 1_785_399_973_556,
      threadId: options.threadId,
      turnId: "019fb227-child-turn",
      item: {
        id: "msg_0bf73f64040e07ec016a6b0c5a31248195aba666029c373956",
        type: options.type ?? "agentMessage",
        memoryCitation: null,
        phase: options.phase === undefined ? "commentary" : options.phase,
        text: options.text,
      },
    },
  };
}

describe("applyCodexChildThreadNotification", () => {
  const CHILD = OBSERVED_SPAWNS[1].agentThreadId;
  const tracked = () =>
    applyCodexCollabNotification(
      EMPTY,
      subAgentNotification({ ...OBSERVED_SPAWNS[1], kind: "started" }),
      PARENT_TURN,
    ).next;

  it("reports the agent's commentary as progress", () => {
    const { next, emissions } = applyCodexChildThreadNotification(
      tracked(),
      childMessageNotification({
        threadId: CHILD,
        text: "I’ll trace the transition paths in `nativeAgents.ts` and report the triggers.",
      }),
    );

    expect(emissions).toMatchObject([
      {
        kind: "progress",
        taskId: CHILD,
        turnId: PARENT_TURN,
        message: "I’ll trace the transition paths in `nativeAgents.ts` and report the triggers.",
      },
    ]);
    expect(next.get(CHILD)?.settled).toBe(false);
  });

  it("does not repeat an unchanged commentary line", () => {
    const message = childMessageNotification({ threadId: CHILD, text: "Still reading." });
    const first = applyCodexChildThreadNotification(tracked(), message);
    expect(first.emissions).toHaveLength(1);
    expect(applyCodexChildThreadNotification(first.next, message).emissions).toEqual([]);
  });

  it("holds the final answer back and delivers it as the result", () => {
    // The final answer arrives before the child's turn completes, so it is
    // remembered rather than emitted as one more progress line.
    const withResult = applyCodexChildThreadNotification(
      tracked(),
      childMessageNotification({
        threadId: CHILD,
        text: "`nativeAgents.ts` state transitions: running, finished, failed.",
        phase: "final_answer",
      }),
    );
    expect(withResult.emissions).toEqual([]);

    const settled = settleCodexCollabAgentByThread(withResult.next, CHILD);
    expect(settled.emissions).toMatchObject([
      {
        kind: "completed",
        taskId: CHILD,
        status: "completed",
        message: "`nativeAgents.ts` state transitions: running, finished, failed.",
      },
    ]);
  });

  it("falls back to the last commentary when the agent gave no final answer", () => {
    const withProgress = applyCodexChildThreadNotification(
      tracked(),
      childMessageNotification({ threadId: CHILD, text: "Halfway through." }),
    );
    expect(settleCodexCollabAgentByThread(withProgress.next, CHILD).emissions).toMatchObject([
      { kind: "completed", message: "Halfway through." },
    ]);
  });

  it("reports no result when the agent said nothing", () => {
    const settled = settleCodexCollabAgentByThread(tracked(), CHILD);
    expect(settled.emissions).toHaveLength(1);
    expect(settled.emissions[0]).not.toHaveProperty("message");
  });

  it("treats an unreported phase as commentary", () => {
    // Codex does not emit `phase` consistently. Showing interim text as progress
    // is recoverable; mistaking commentary for a final answer is not.
    const { emissions } = applyCodexChildThreadNotification(
      tracked(),
      childMessageNotification({ threadId: CHILD, text: "Working.", phase: null }),
    );
    expect(emissions).toMatchObject([{ kind: "progress", message: "Working." }]);
  });

  it("ignores messages from a thread that is not a tracked agent", () => {
    const { next, emissions } = applyCodexChildThreadNotification(
      tracked(),
      childMessageNotification({ threadId: PARENT_PROVIDER_THREAD, text: "Parent talking." }),
    );
    expect(emissions).toEqual([]);
    expect(next.get(PARENT_PROVIDER_THREAD)).toBeUndefined();
  });

  it("ignores messages once the agent has settled", () => {
    const settled = settleCodexCollabAgentByThread(tracked(), CHILD).next;
    expect(
      applyCodexChildThreadNotification(
        settled,
        childMessageNotification({ threadId: CHILD, text: "Late words." }),
      ).emissions,
    ).toEqual([]);
  });

  it.each([
    { label: "empty text", options: { text: "   " } },
    { label: "a reasoning item", options: { text: "x", type: "reasoning" } },
    { label: "a command execution", options: { text: "x", type: "commandExecution" } },
    { label: "item/started", options: { text: "x", method: "item/started" as const } },
  ])("ignores $label", ({ options }) => {
    expect(
      applyCodexChildThreadNotification(
        tracked(),
        childMessageNotification({ threadId: CHILD, ...options }),
      ).emissions,
    ).toEqual([]);
  });
});

describe("settleCodexCollabAgentsForTurn", () => {
  it("stops agents left running when their parent turn ends", () => {
    const { emissions } = settleCodexCollabAgentsForTurn(spawned(), PARENT_TURN);
    expect(emissions).toHaveLength(3);
    for (const emission of emissions) {
      expect(emission).toMatchObject({ kind: "completed", status: "stopped" });
    }
  });

  it("leaves already-settled agents and other turns alone", () => {
    const settled = applyCodexCollabNotification(
      EMPTY,
      collabNotification({
        receivers: ["child-a"],
        states: { "child-a": { status: "completed" } },
      }),
      PARENT_TURN,
    ).next;

    expect(settleCodexCollabAgentsForTurn(settled, PARENT_TURN).emissions).toEqual([]);
    expect(settleCodexCollabAgentsForTurn(spawned(), TurnId.make("turn-other")).emissions).toEqual(
      [],
    );
  });
});

describe("settleCodexCollabAgentByThread", () => {
  it("settles an agent from its own child turn completing", () => {
    const { emissions } = settleCodexCollabAgentByThread(spawned(["child-a"]), "child-a");
    expect(emissions).toMatchObject([
      { kind: "completed", taskId: "child-a", status: "completed", turnId: PARENT_TURN },
    ]);
  });

  it("ignores a thread it never tracked", () => {
    expect(settleCodexCollabAgentByThread(EMPTY, "nobody").emissions).toEqual([]);
  });
});

describe("codexCollabEmissionEvent", () => {
  it("renders each emission as its t3/task notification", () => {
    expect(
      codexCollabEmissionEvent({
        kind: "started",
        taskId: "child-a",
        turnId: PARENT_TURN,
        description: "Inspect",
        prompt: "Inspect",
      }),
    ).toEqual({
      method: "t3/task/started",
      turnId: PARENT_TURN,
      payload: { taskId: "child-a", description: "Inspect", prompt: "Inspect" },
    });

    expect(
      codexCollabEmissionEvent({
        kind: "progress",
        taskId: "child-a",
        turnId: PARENT_TURN,
        message: "reading",
      }),
    ).toEqual({
      method: "t3/task/progress",
      turnId: PARENT_TURN,
      payload: { taskId: "child-a", summary: "reading" },
    });

    expect(
      codexCollabEmissionEvent({
        kind: "completed",
        taskId: "child-a",
        turnId: PARENT_TURN,
        status: "failed",
        message: "worker died",
      }),
    ).toEqual({
      method: "t3/task/completed",
      turnId: PARENT_TURN,
      payload: { taskId: "child-a", status: "failed", summary: "worker died" },
    });
  });
});

describe("the Codex three-agent sequence that produced no sidebar rows", () => {
  it("drives all three agents from spawn to terminal", () => {
    // The exact reproduction: one `spawnAgent` naming three children, a `wait`
    // that reports progress for each, and a final `wait` where all three have
    // completed. Before this change the runtime emitted only three bare
    // `t3/task/started` notifications with no agent evidence, so the sidebar
    // showed nothing at all.
    let state = EMPTY;
    const emitted: Array<{ method: string; taskId: string; status?: unknown; summary?: unknown }> =
      [];

    const step = (notification: CodexCollabNotification) => {
      const result = applyCodexCollabNotification(state, notification, PARENT_TURN);
      state = result.next;
      for (const emission of result.emissions) {
        const event = codexCollabEmissionEvent(emission);
        emitted.push({
          method: event.method,
          taskId: emission.taskId,
          ...(event.payload.status === undefined ? {} : { status: event.payload.status }),
        });
      }
    };

    step(
      collabNotification({
        receivers: CHILDREN,
        states: runningStates(),
        prompt: "Use exactly three sub-agents in parallel.",
      }),
    );
    step(
      collabNotification({
        tool: "wait",
        receivers: CHILDREN,
        states: {
          "child-a": { status: "running", message: "reading SidebarV2.tsx" },
          "child-b": { status: "running", message: "reading nativeAgents.ts" },
          "child-c": { status: "running", message: "reading orchestration.ts" },
        },
      }),
    );
    step(
      collabNotification({
        method: "item/completed",
        tool: "wait",
        receivers: CHILDREN,
        states: {
          "child-a": { status: "completed", message: "summarized the UI wiring" },
          "child-b": { status: "completed", message: "summarized the transitions" },
          "child-c": { status: "completed", message: "listed the fields" },
        },
      }),
    );

    const byMethod = (method: string) => emitted.filter((event) => event.method === method);
    expect(byMethod("t3/task/started")).toHaveLength(3);
    expect(byMethod("t3/task/progress")).toHaveLength(3);
    expect(byMethod("t3/task/completed").map((event) => event.status)).toEqual([
      "completed",
      "completed",
      "completed",
    ]);
    // And the parent turn ending leaves nothing behind to settle.
    expect(settleCodexCollabAgentsForTurn(state, PARENT_TURN).emissions).toEqual([]);
  });

  it("settles the agents when the parent turn ends first", () => {
    // The other half of the regression: an agent whose terminal state never
    // arrives must not keep a spinner in the sidebar forever.
    const { emissions } = settleCodexCollabAgentsForTurn(spawned(), PARENT_TURN);
    expect(emissions.map((emission) => emission.taskId)).toEqual([...CHILDREN]);
    for (const emission of emissions) {
      expect(emission).toMatchObject({ status: "stopped" });
    }
  });
});

describe("the verbatim Codex subAgentActivity sequence that produced no sidebar rows", () => {
  it("drives all three agents from spawn to terminal", () => {
    // Replays the notification order captured from a live Codex run, including
    // the child `turn/completed` notifications that settle each agent and the
    // parent `turn/completed` that closes the turn. The runtime settles a child
    // by thread when that child is tracked, which is what these assert.
    let state = EMPTY;
    const emitted: Array<{ method: string; taskId: string; status?: unknown; summary?: unknown }> =
      [];

    const record = (result: ReturnType<typeof applyCodexCollabNotification>) => {
      state = result.next;
      for (const emission of result.emissions) {
        const event = codexCollabEmissionEvent(emission);
        emitted.push({
          method: event.method,
          taskId: emission.taskId,
          ...(event.payload.status === undefined ? {} : { status: event.payload.status }),
          ...(event.payload.summary === undefined ? {} : { summary: event.payload.summary }),
        });
      }
    };

    // Three spawns, on the parent's thread and the parent's turn.
    for (const spawn of OBSERVED_SPAWNS) {
      record(
        applyCodexCollabNotification(
          state,
          subAgentNotification({ ...spawn, kind: "started" }),
          PARENT_TURN,
        ),
      );
    }
    expect(emitted.filter((event) => event.method === "t3/task/started")).toHaveLength(3);
    expect([...state.values()].every((agent) => !agent.settled)).toBe(true);

    // Each agent narrates on its own thread, then gives a final answer.
    for (const spawn of OBSERVED_SPAWNS) {
      record(
        applyCodexChildThreadNotification(
          state,
          childMessageNotification({
            threadId: spawn.agentThreadId,
            text: `Reading for ${spawn.agentPath}.`,
          }),
        ),
      );
      record(
        applyCodexChildThreadNotification(
          state,
          childMessageNotification({
            threadId: spawn.agentThreadId,
            text: `Summary for ${spawn.agentPath}.`,
            phase: "final_answer",
          }),
        ),
      );
    }
    expect(emitted.filter((event) => event.method === "t3/task/progress")).toHaveLength(3);

    // Each child hands back, which is not itself a lifecycle change.
    for (const spawn of OBSERVED_SPAWNS) {
      record(
        applyCodexCollabNotification(
          state,
          subAgentNotification({
            threadId: spawn.agentThreadId,
            agentPath: "/root",
            agentThreadId: PARENT_PROVIDER_THREAD,
            kind: "interacted",
          }),
          PARENT_TURN,
        ),
      );
    }
    expect(emitted.filter((event) => event.method === "t3/task/completed")).toHaveLength(0);

    // Each child's own turn completing settles it, carrying its final answer.
    for (const spawn of OBSERVED_SPAWNS) {
      record(settleCodexCollabAgentByThread(state, spawn.agentThreadId));
    }
    const completions = emitted.filter((event) => event.method === "t3/task/completed");
    expect(completions.map((event) => event.taskId)).toEqual(
      OBSERVED_SPAWNS.map((spawn) => spawn.agentThreadId),
    );
    expect(completions.every((event) => event.status === "completed")).toBe(true);
    expect(completions.map((event) => event.summary)).toEqual(
      OBSERVED_SPAWNS.map((spawn) => `Summary for ${spawn.agentPath}.`),
    );

    // The parent turn then has nothing left to settle.
    expect(settleCodexCollabAgentsForTurn(state, PARENT_TURN).emissions).toEqual([]);
  });

  it("settles agents the parent turn outlived, so none stay running", () => {
    let state = EMPTY;
    for (const spawn of OBSERVED_SPAWNS) {
      state = applyCodexCollabNotification(
        state,
        subAgentNotification({ ...spawn, kind: "started" }),
        PARENT_TURN,
      ).next;
    }
    const { next, emissions } = settleCodexCollabAgentsForTurn(state, PARENT_TURN);
    expect(emissions).toHaveLength(3);
    expect(emissions.every((emission) => emission.kind === "completed")).toBe(true);
    expect([...next.values()].every((agent) => agent.settled)).toBe(true);
  });
});
