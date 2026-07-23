import { describe, expect, it } from "vite-plus/test";

import type { AcpParsedSessionEvent, AcpToolCallState } from "./AcpRuntimeModel.ts";
import {
  coalesceAcpToolProgress,
  emptyAcpToolProgressCoalescerState,
  flushAllAcpToolProgress,
  flushDueAcpToolProgress,
} from "./AcpToolProgressCoalescer.ts";

type ToolCallUpdatedEvent = Extract<AcpParsedSessionEvent, { readonly _tag: "ToolCallUpdated" }>;

const update = (
  toolCallId: string,
  detail: string,
  status: AcpToolCallState["status"] = "inProgress",
): ToolCallUpdatedEvent => ({
  _tag: "ToolCallUpdated",
  toolCall: {
    toolCallId,
    title: `Tool ${toolCallId}`,
    detail,
    status,
    data: {
      rawOutput: detail,
    },
  },
  rawPayload: {
    sessionId: "session-1",
    update: {
      rawOutput: detail,
    },
  },
});

describe("AcpToolProgressCoalescer", () => {
  it("emits first, periodic latest, and terminal states", () => {
    const initial = coalesceAcpToolProgress(
      emptyAcpToolProgressCoalescerState(),
      update("tool-1", "first"),
      0,
      100,
    );
    const pending = coalesceAcpToolProgress(initial.state, update("tool-1", "latest"), 20, 100);
    const due = flushDueAcpToolProgress(pending.state, 100, 100);
    const terminal = coalesceAcpToolProgress(
      due.state,
      update("tool-1", "done", "completed"),
      101,
      100,
    );

    expect(initial.events.map((event) => event.toolCall.detail)).toEqual(["first"]);
    expect(pending.events).toEqual([]);
    expect(due.events.map((event) => event.toolCall.detail)).toEqual(["latest"]);
    expect(terminal.events.map((event) => event.toolCall.status)).toEqual(["completed"]);
    expect(terminal.state.entries.size).toBe(1);
    expect(terminal.events[0]?.rawPayload).toBeUndefined();
  });

  it("drops stale progress observed after a terminal state for the same tool", () => {
    const terminal = coalesceAcpToolProgress(
      emptyAcpToolProgressCoalescerState(),
      update("tool-1", "done", "completed"),
      100,
      100,
    );
    const stale = coalesceAcpToolProgress(
      terminal.state,
      update("tool-1", "late progress"),
      101,
      100,
    );

    expect(stale.events).toEqual([]);
    expect(stale.state.coalescedCount).toBe(1);
  });

  it("keeps interleaved tools independent and flushes pending state on shutdown", () => {
    const toolOne = coalesceAcpToolProgress(
      emptyAcpToolProgressCoalescerState(),
      update("tool-1", "one"),
      0,
      100,
    );
    const toolTwo = coalesceAcpToolProgress(toolOne.state, update("tool-2", "two"), 10, 100);
    const pendingOne = coalesceAcpToolProgress(
      toolTwo.state,
      update("tool-1", "one-latest"),
      20,
      100,
    );
    const pendingTwo = coalesceAcpToolProgress(
      pendingOne.state,
      update("tool-2", "two-latest"),
      30,
      100,
    );
    const shutdown = flushAllAcpToolProgress(pendingTwo.state);

    expect(toolOne.events).toHaveLength(1);
    expect(toolTwo.events).toHaveLength(1);
    expect(shutdown.events.map((event) => event.toolCall.detail).sort()).toEqual([
      "one-latest",
      "two-latest",
    ]);
  });

  it("keeps a failed terminal event and replaces pending cumulative output", () => {
    const first = coalesceAcpToolProgress(
      emptyAcpToolProgressCoalescerState(),
      update("tool-1", "chunk-1"),
      0,
      100,
    );
    const pending = coalesceAcpToolProgress(
      first.state,
      update("tool-1", "chunk-1 chunk-2"),
      1,
      100,
    );
    const failed = coalesceAcpToolProgress(
      pending.state,
      update("tool-1", "failed output", "failed"),
      2,
      100,
    );

    expect(failed.events).toHaveLength(1);
    expect(failed.events[0]?.toolCall).toMatchObject({
      status: "failed",
      detail: "failed output",
    });
  });

  it("bounds canonical events during a synthetic fifty-thousand-update flood", () => {
    let state = emptyAcpToolProgressCoalescerState();
    const emitted: Array<ToolCallUpdatedEvent> = [];
    for (let index = 0; index < 50_000; index += 1) {
      const transition = coalesceAcpToolProgress(
        state,
        update("tool-1", `cumulative-${index}`),
        Math.floor(index / 10),
        100,
      );
      state = transition.state;
      emitted.push(...transition.events);
    }
    const terminal = coalesceAcpToolProgress(
      state,
      update("tool-1", "final", "completed"),
      5_000,
      100,
    );
    emitted.push(...terminal.events);

    expect(emitted.length).toBeLessThanOrEqual(52);
    expect(emitted.at(-1)?.toolCall).toMatchObject({
      status: "completed",
      detail: "final",
    });
    expect(terminal.state.coalescedCount).toBeGreaterThan(49_000);
  });
});
