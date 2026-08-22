import { EventId, MessageId, TurnId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { deriveTimelineEntries, deriveWorkLogEntries } from "../../session-logic";
import {
  computeStableMessagesTimelineRows,
  computeMessageDurationStart,
  deriveMessagesTimelineRows,
  deriveTaskCardMetricParts,
  formatTaskTokenCount,
  formatTaskToolUseCount,
  messageEntryIsTranscriptVisible,
  normalizeCompactToolLabel,
  resolveAssistantMessageCopyState,
  resolveTaskCardExpansionA11y,
  resolveTimelineIsAtEnd,
  shouldPreserveAssistantLineBreaks,
  TIMELINE_FOLLOW_REARM_THRESHOLD_PX,
  workEntryIsTranscriptVisible,
  workLogEntryIsTaskLike,
  type MessagesTimelineRow,
  type StableMessagesTimelineRowsState,
} from "./MessagesTimeline.logic";

describe("shouldPreserveAssistantLineBreaks", () => {
  it("preserves Claude insight formatting without changing regular markdown", () => {
    expect(
      shouldPreserveAssistantLineBreaks(
        "★ Insight ─────────────────\\nFirst observation\\nSecond observation\\n─────────────────",
      ),
    ).toBe(true);
    expect(shouldPreserveAssistantLineBreaks("A normal\\nmarkdown paragraph")).toBe(false);
  });
});

describe("timeline live edge", () => {
  it("re-arms inside the strict pixel band but not in LegendList's near-end region", () => {
    const contentLength = 2_000;
    const scrollLength = 800;

    expect(
      resolveTimelineIsAtEnd({
        isAtEnd: false,
        contentLength,
        scroll: contentLength - scrollLength - TIMELINE_FOLLOW_REARM_THRESHOLD_PX,
        scrollLength,
      }),
    ).toBe(true);
    expect(
      resolveTimelineIsAtEnd({
        isAtEnd: false,
        contentLength,
        scroll: contentLength - scrollLength - TIMELINE_FOLLOW_REARM_THRESHOLD_PX - 1,
        scrollLength,
      }),
    ).toBe(false);
    expect(
      resolveTimelineIsAtEnd({
        isAtEnd: false,
        contentLength,
        scroll: 900,
        scrollLength,
      }),
    ).toBe(false);
  });

  it("subtracts the composer inset and falls back to the strict list flag", () => {
    expect(
      resolveTimelineIsAtEnd(
        { isAtEnd: false, contentLength: 2_100, scroll: 1_170, scrollLength: 800 },
        100,
      ),
    ).toBe(true);
    expect(resolveTimelineIsAtEnd({ isAtEnd: true })).toBe(true);
    expect(resolveTimelineIsAtEnd({ isAtEnd: false })).toBe(false);
    expect(resolveTimelineIsAtEnd(undefined)).toBeUndefined();
  });
});

describe("computeMessageDurationStart", () => {
  it("returns message createdAt when there is no preceding user message", () => {
    const result = computeMessageDurationStart([
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:05Z",
        updatedAt: "2026-01-01T00:00:10Z",
        streaming: false,
      },
    ]);
    expect(result).toEqual(new Map([["a1", "2026-01-01T00:00:05Z"]]));
  });

  it("uses the user message createdAt for the first assistant response", () => {
    const result = computeMessageDurationStart([
      {
        id: "u1",
        role: "user",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        streaming: false,
      },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        updatedAt: "2026-01-01T00:00:30Z",
        streaming: false,
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
      ]),
    );
  });

  it("uses the previous completed assistant updatedAt for subsequent assistant responses", () => {
    const result = computeMessageDurationStart([
      {
        id: "u1",
        role: "user",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        streaming: false,
      },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        updatedAt: "2026-01-01T00:00:30Z",
        streaming: false,
      },
      {
        id: "a2",
        role: "assistant",
        createdAt: "2026-01-01T00:00:55Z",
        updatedAt: "2026-01-01T00:00:55Z",
        streaming: false,
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
        ["a2", "2026-01-01T00:00:30Z"],
      ]),
    );
  });

  it("does not advance the boundary for a streaming message", () => {
    const result = computeMessageDurationStart([
      {
        id: "u1",
        role: "user",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        streaming: false,
      },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        updatedAt: "2026-01-01T00:00:40Z",
        streaming: true,
      },
      {
        id: "a2",
        role: "assistant",
        createdAt: "2026-01-01T00:00:55Z",
        updatedAt: "2026-01-01T00:00:55Z",
        streaming: false,
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
        ["a2", "2026-01-01T00:00:00Z"],
      ]),
    );
  });

  it("resets the boundary on a new user message", () => {
    const result = computeMessageDurationStart([
      {
        id: "u1",
        role: "user",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        streaming: false,
      },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        updatedAt: "2026-01-01T00:00:30Z",
        streaming: false,
      },
      {
        id: "u2",
        role: "user",
        createdAt: "2026-01-01T00:01:00Z",
        updatedAt: "2026-01-01T00:01:00Z",
        streaming: false,
      },
      {
        id: "a2",
        role: "assistant",
        createdAt: "2026-01-01T00:01:20Z",
        updatedAt: "2026-01-01T00:01:20Z",
        streaming: false,
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
        ["u2", "2026-01-01T00:01:00Z"],
        ["a2", "2026-01-01T00:01:00Z"],
      ]),
    );
  });

  it("handles system messages without affecting the boundary", () => {
    const result = computeMessageDurationStart([
      {
        id: "u1",
        role: "user",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        streaming: false,
      },
      {
        id: "s1",
        role: "system",
        createdAt: "2026-01-01T00:00:01Z",
        updatedAt: "2026-01-01T00:00:01Z",
        streaming: false,
      },
      {
        id: "a1",
        role: "assistant",
        createdAt: "2026-01-01T00:00:30Z",
        updatedAt: "2026-01-01T00:00:30Z",
        streaming: false,
      },
    ]);

    expect(result).toEqual(
      new Map([
        ["u1", "2026-01-01T00:00:00Z"],
        ["s1", "2026-01-01T00:00:00Z"],
        ["a1", "2026-01-01T00:00:00Z"],
      ]),
    );
  });

  it("returns empty map for empty input", () => {
    expect(computeMessageDurationStart([])).toEqual(new Map());
  });
});

describe("normalizeCompactToolLabel", () => {
  it("removes trailing completion wording from command labels", () => {
    expect(normalizeCompactToolLabel("Ran command complete")).toBe("Ran command");
  });

  it("removes trailing completion wording from other labels", () => {
    expect(normalizeCompactToolLabel("Read file completed")).toBe("Read file");
  });
});

describe("resolveAssistantMessageCopyState", () => {
  it("returns enabled copy state for completed assistant messages", () => {
    expect(
      resolveAssistantMessageCopyState({
        showCopyButton: true,
        text: "Ship it",
        streaming: false,
      }),
    ).toEqual({
      text: "Ship it",
      visible: true,
    });
  });

  it("hides copy while an assistant message is still streaming", () => {
    expect(
      resolveAssistantMessageCopyState({
        showCopyButton: true,
        text: "Still streaming",
        streaming: true,
      }),
    ).toEqual({
      text: "Still streaming",
      visible: false,
    });
  });

  it("hides copy for empty completed assistant messages", () => {
    expect(
      resolveAssistantMessageCopyState({
        showCopyButton: true,
        text: "   ",
        streaming: false,
      }),
    ).toEqual({
      text: null,
      visible: false,
    });
  });

  it("hides copy for non-terminal assistant messages", () => {
    expect(
      resolveAssistantMessageCopyState({
        showCopyButton: false,
        text: "Interim thought",
        streaming: false,
      }),
    ).toEqual({
      text: "Interim thought",
      visible: false,
    });
  });
});

describe("deriveMessagesTimelineRows", () => {
  it("only enables assistant copy for the terminal assistant message in a turn", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "user-1-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:00Z",
          message: {
            id: "user-1" as never,
            role: "user",
            text: "Write a poem",
            turnId: null,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            streaming: false,
          },
        },
        {
          id: "assistant-thought-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:10Z",
          message: {
            id: "assistant-thought" as never,
            role: "assistant",
            text: "I should ground this first.",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:10Z",
            updatedAt: "2026-01-01T00:00:11Z",
            streaming: false,
          },
        },
        {
          id: "assistant-final-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:20Z",
          message: {
            id: "assistant-final" as never,
            role: "assistant",
            text: "Here is the poem.",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:20Z",
            updatedAt: "2026-01-01T00:00:30Z",
            streaming: false,
          },
        },
      ],
      expandedTurnIds: new Set(["turn-1" as never]),
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const assistantRows = rows.filter(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.role === "assistant",
    );

    expect(assistantRows).toHaveLength(2);
    expect(assistantRows[0]?.showAssistantCopyButton).toBe(false);
    expect(assistantRows[1]?.showAssistantCopyButton).toBe(true);
  });

  it("marks only the active assistant turn as streaming for copy controls", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "assistant-one-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:10Z",
          message: {
            id: "assistant-one" as never,
            role: "assistant",
            text: "Earlier response.",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:10Z",
            updatedAt: "2026-01-01T00:00:11Z",
            streaming: false,
          },
        },
        {
          id: "assistant-two-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:20Z",
          message: {
            id: "assistant-two" as never,
            role: "assistant",
            text: "Active response.",
            turnId: "turn-2" as never,
            createdAt: "2026-01-01T00:00:20Z",
            updatedAt: "2026-01-01T00:00:30Z",
            streaming: false,
          },
        },
      ],
      latestTurn: {
        turnId: "turn-2" as never,
        state: "running",
        startedAt: "2026-01-01T00:00:19Z",
        completedAt: null,
      },
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const assistantRows = rows.filter(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.role === "assistant",
    );

    expect(assistantRows[0]?.assistantCopyStreaming).toBe(false);
    expect(assistantRows[1]?.assistantCopyStreaming).toBe(true);
  });

  it("projects assistant diff summaries and user revert counts onto the affected rows", () => {
    const assistantTurnDiffSummary = {
      turnId: "turn-1" as never,
      completedAt: "2026-01-01T00:00:30Z",
      assistantMessageId: "assistant-1" as never,
      checkpointTurnCount: 2,
      checkpointRef: "checkpoint-1" as never,
      status: "ready" as const,
      files: [{ path: "src/index.ts", kind: "modified", additions: 3, deletions: 1 }],
    };

    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "user-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:00Z",
          message: {
            id: "user-1" as never,
            role: "user",
            text: "Do the thing",
            turnId: null,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            streaming: false,
          },
        },
        {
          id: "assistant-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:20Z",
          message: {
            id: "assistant-1" as never,
            role: "assistant",
            text: "Done",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:20Z",
            updatedAt: "2026-01-01T00:00:30Z",
            streaming: false,
          },
        },
      ],
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map([
        ["assistant-1" as never, assistantTurnDiffSummary],
      ]),
      revertTurnCountByUserMessageId: new Map([["user-1" as never, 1]]),
    });

    const userRow = rows.find(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.role === "user",
    );
    const assistantRow = rows.find(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.role === "assistant",
    );

    expect(userRow?.revertTurnCount).toBe(1);
    expect(assistantRow?.assistantTurnDiffSummary).toBe(assistantTurnDiffSummary);
  });

  it("folds settled-turn commentary and work behind a Worked-for row", () => {
    const timelineEntries = [
      {
        id: "user-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:00Z",
        message: {
          id: "user-1" as never,
          role: "user" as const,
          text: "Build it",
          turnId: null,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          streaming: false,
        },
      },
      {
        id: "assistant-thought-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:05Z",
        message: {
          id: "assistant-thought" as never,
          role: "assistant" as const,
          text: "Looking around first.",
          turnId: "turn-1" as never,
          createdAt: "2026-01-01T00:00:05Z",
          updatedAt: "2026-01-01T00:00:06Z",
          streaming: false,
        },
      },
      {
        id: "work-entry-1",
        kind: "work" as const,
        createdAt: "2026-01-01T00:00:08Z",
        entry: {
          id: "work-1",
          createdAt: "2026-01-01T00:00:08Z",
          turnId: "turn-1" as never,
          label: "Ran command",
          tone: "tool" as const,
        },
      },
      {
        id: "assistant-final-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:20Z",
        message: {
          id: "assistant-final" as never,
          role: "assistant" as const,
          text: "Done",
          turnId: "turn-1" as never,
          createdAt: "2026-01-01T00:00:20Z",
          updatedAt: "2026-01-01T00:00:22Z",
          streaming: false,
        },
      },
    ];

    const collapsedRows = deriveMessagesTimelineRows({
      timelineEntries,
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const foldRow = collapsedRows.find(
      (row): row is Extract<(typeof collapsedRows)[number], { kind: "turn-fold" }> =>
        row.kind === "turn-fold",
    );
    expect(foldRow?.turnId).toBe("turn-1");
    expect(foldRow?.expanded).toBe(false);
    // User message boundary (00:00:00) → terminal message updatedAt (00:00:22).
    expect(foldRow?.label).toBe("Worked for 22s");
    expect(collapsedRows.map((row) => row.id)).toEqual([
      "user-entry",
      "turn-fold:turn-1",
      "assistant-final-entry",
    ]);

    const expandedRows = deriveMessagesTimelineRows({
      timelineEntries,
      expandedTurnIds: new Set(["turn-1" as never]),
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(expandedRows.map((row) => row.id)).toEqual([
      "user-entry",
      "turn-fold:turn-1",
      "assistant-thought-entry",
      "work-toggle:work-entry-1",
      "assistant-final-entry",
    ]);
    expect(
      expandedRows.find((row) => row.kind === "turn-fold" && row.expanded === true),
    ).toBeDefined();
  });

  it("derives a sane duration for a steer-superseded turn with one instant commentary message", () => {
    // A steer ends the previous turn early: its only message completes the
    // instant it is created, and trailing work entries land after it. The
    // fold duration must span from the user message that started the turn to
    // the last entry, not message createdAt → message updatedAt (~0ms).
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "user-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:00Z",
          message: {
            id: "user-1" as never,
            role: "user" as const,
            text: "do it once more",
            turnId: null,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            streaming: false,
          },
        },
        {
          id: "assistant-commentary-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:09Z",
          message: {
            id: "assistant-commentary" as never,
            role: "assistant" as const,
            text: "Kicking off call 1.",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:09Z",
            updatedAt: "2026-01-01T00:00:09Z",
            streaming: false,
          },
        },
        {
          id: "work-entry-1",
          kind: "work",
          createdAt: "2026-01-01T00:00:12Z",
          entry: {
            id: "work-1",
            createdAt: "2026-01-01T00:00:12Z",
            turnId: "turn-1" as never,
            label: "Ran command",
            tone: "tool" as const,
          },
        },
        {
          id: "steer-user-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:14Z",
          message: {
            id: "user-2" as never,
            role: "user" as const,
            text: "actually do 15",
            turnId: null,
            createdAt: "2026-01-01T00:00:14Z",
            updatedAt: "2026-01-01T00:00:14Z",
            streaming: false,
          },
        },
        {
          id: "assistant-next-turn-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:17Z",
          message: {
            id: "assistant-next" as never,
            role: "assistant" as const,
            text: "One down — adjusting.",
            turnId: "turn-2" as never,
            createdAt: "2026-01-01T00:00:17Z",
            updatedAt: "2026-01-01T00:00:17Z",
            streaming: true,
          },
        },
      ],
      latestTurn: {
        turnId: "turn-2" as never,
        state: "running",
        startedAt: "2026-01-01T00:00:14Z",
        completedAt: null,
      },
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:14Z",
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const foldRow = rows.find(
      (row): row is Extract<(typeof rows)[number], { kind: "turn-fold" }> =>
        row.kind === "turn-fold",
    );
    // User message (00:00:00) → trailing work entry (00:00:12).
    expect(foldRow?.turnId).toBe("turn-1");
    expect(foldRow?.label).toBe("Worked for 12s");
  });

  it("uses latest-turn timings and the stopped label for an interrupted latest turn", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "work-entry-1",
          kind: "work",
          createdAt: "2026-01-01T00:00:05Z",
          entry: {
            id: "work-1",
            createdAt: "2026-01-01T00:00:05Z",
            turnId: "turn-1" as never,
            label: "Ran command",
            tone: "tool" as const,
          },
        },
      ],
      latestTurn: {
        turnId: "turn-1" as never,
        state: "interrupted",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: "2026-01-01T00:00:47Z",
      },
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows).toEqual([
      expect.objectContaining({
        kind: "turn-fold",
        turnId: "turn-1",
        label: "You stopped after 47s",
        expanded: false,
      }),
    ]);
  });

  it("keeps the previous turn folded while a newly sent message awaits its turn", () => {
    // Right after send, isWorking is true but latestTurn still points at the
    // previous, settled turn — it must stay folded through that window.
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "work-entry-1",
          kind: "work",
          createdAt: "2026-01-01T00:00:05Z",
          entry: {
            id: "work-1",
            createdAt: "2026-01-01T00:00:05Z",
            turnId: "turn-1" as never,
            label: "Ran command",
            tone: "tool" as const,
          },
        },
        {
          id: "assistant-final-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:20Z",
          message: {
            id: "assistant-final" as never,
            role: "assistant",
            text: "Done",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:20Z",
            updatedAt: "2026-01-01T00:00:22Z",
            streaming: false,
          },
        },
        {
          id: "user-followup-entry",
          kind: "message",
          createdAt: "2026-01-01T00:01:00Z",
          message: {
            id: "user-followup" as never,
            role: "user",
            text: "yooo",
            turnId: null,
            createdAt: "2026-01-01T00:01:00Z",
            updatedAt: "2026-01-01T00:01:00Z",
            streaming: false,
          },
        },
      ],
      latestTurn: {
        turnId: "turn-1" as never,
        state: "completed",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: "2026-01-01T00:00:22Z",
      },
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:01:00Z",
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows.map((row) => row.id)).toEqual([
      "turn-fold:turn-1",
      "assistant-final-entry",
      "user-followup-entry",
      "working-indicator-row",
    ]);
    const finalRow = rows.find((row) => row.id === "assistant-final-entry");
    expect(finalRow?.kind === "message" && finalRow.showAssistantMeta).toBe(true);
  });

  it("does not fold the active in-progress turn", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "assistant-thought-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:05Z",
          message: {
            id: "assistant-thought" as never,
            role: "assistant",
            text: "Working on it.",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:05Z",
            updatedAt: "2026-01-01T00:00:06Z",
            streaming: false,
          },
        },
        {
          id: "work-entry-1",
          kind: "work",
          createdAt: "2026-01-01T00:00:08Z",
          entry: {
            id: "work-1",
            createdAt: "2026-01-01T00:00:08Z",
            turnId: "turn-1" as never,
            label: "Ran command",
            tone: "tool" as const,
          },
        },
      ],
      latestTurn: {
        turnId: "turn-1" as never,
        state: "running",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: null,
      },
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:00Z",
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows.some((row) => row.kind === "turn-fold")).toBe(false);
    expect(rows.map((row) => row.id)).toEqual([
      "working-indicator-row",
      "assistant-thought-entry",
      "work-live:work-entry-1",
    ]);
  });

  it("keeps adjacent active tool calls in one replacing row", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "completed-command-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:05Z",
          entry: {
            id: "completed-command",
            createdAt: "2026-01-01T00:00:05Z",
            turnId: "turn-1" as never,
            label: "Ran rg",
            command: "rg toolCall",
            requestKind: "command",
            tone: "tool" as const,
            toolLifecycleStatus: "completed" as const,
          },
        },
        {
          id: "completed-edit-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:06Z",
          entry: {
            id: "completed-edit",
            createdAt: "2026-01-01T00:00:06Z",
            turnId: "turn-1" as never,
            label: "Edited files",
            requestKind: "file-change",
            changedFiles: ["src/one.ts", "src/two.ts"],
            tone: "tool" as const,
            toolLifecycleStatus: "completed" as const,
          },
        },
        {
          id: "running-command-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:07Z",
          entry: {
            id: "running-command",
            createdAt: "2026-01-01T00:00:07Z",
            turnId: "turn-1" as never,
            label: "Running tests",
            command: "vp test run",
            requestKind: "command",
            tone: "tool" as const,
            toolLifecycleStatus: "inProgress" as const,
          },
        },
      ],
      latestTurn: {
        turnId: "turn-1" as never,
        state: "running",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: null,
      },
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:00Z",
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows.map((row) => row.kind)).toEqual(["working", "work-live"]);
    expect(rows.find((row) => row.kind === "work-live")).toMatchObject({
      entry: { id: "running-command" },
      groupedEntries: [
        { id: "completed-command" },
        { id: "completed-edit" },
        { id: "running-command" },
      ],
    });
  });

  it("summarizes a tool run after commentary starts a new run", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "completed-command-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:05Z",
          entry: {
            id: "completed-command",
            createdAt: "2026-01-01T00:00:05Z",
            turnId: "turn-1" as never,
            label: "Ran rg",
            command: "rg toolCall",
            requestKind: "command",
            tone: "tool" as const,
            toolLifecycleStatus: "completed" as const,
          },
        },
        {
          id: "assistant-commentary-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:06Z",
          message: {
            id: "assistant-commentary" as never,
            role: "assistant",
            text: "Checking another thing.",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:06Z",
            updatedAt: "2026-01-01T00:00:06Z",
            streaming: false,
          },
        },
        {
          id: "running-command-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:07Z",
          entry: {
            id: "running-command",
            createdAt: "2026-01-01T00:00:07Z",
            turnId: "turn-1" as never,
            label: "Running tests",
            command: "vp test run",
            requestKind: "command",
            tone: "tool" as const,
            toolLifecycleStatus: "inProgress" as const,
          },
        },
      ],
      latestTurn: {
        turnId: "turn-1" as never,
        state: "running",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: null,
      },
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:00Z",
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows.map((row) => row.kind)).toEqual(["working", "work-toggle", "message", "work-live"]);
    expect(rows.find((row) => row.kind === "work-toggle")).toMatchObject({
      hiddenCount: 1,
      summary: "Ran 1 command",
    });
  });

  it("keeps separated in-progress tool runs visible", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "first-running-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:05Z",
          entry: {
            id: "first-running",
            createdAt: "2026-01-01T00:00:05Z",
            turnId: "turn-1" as never,
            label: "Running first command",
            command: "rg first",
            requestKind: "command",
            tone: "tool" as const,
            toolLifecycleStatus: "inProgress" as const,
          },
        },
        {
          id: "assistant-commentary-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:06Z",
          message: {
            id: "assistant-commentary" as never,
            role: "assistant",
            text: "Starting another command.",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:06Z",
            updatedAt: "2026-01-01T00:00:06Z",
            streaming: false,
          },
        },
        {
          id: "second-running-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:07Z",
          entry: {
            id: "second-running",
            createdAt: "2026-01-01T00:00:07Z",
            turnId: "turn-1" as never,
            label: "Running second command",
            command: "rg second",
            requestKind: "command",
            tone: "tool" as const,
            toolLifecycleStatus: "inProgress" as const,
          },
        },
      ],
      latestTurn: {
        turnId: "turn-1" as never,
        state: "running",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: null,
      },
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:00Z",
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows.map((row) => row.kind)).toEqual(["working", "work-live", "message", "work-live"]);
    expect(rows.filter((row) => row.kind === "work-live").map((row) => row.entry.id)).toEqual([
      "first-running",
      "second-running",
    ]);
  });

  it("does not revive stale in-progress tools before a fresh send has a turn id", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "stale-running-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:05Z",
          entry: {
            id: "stale-running",
            createdAt: "2026-01-01T00:00:05Z",
            turnId: "turn-1" as never,
            label: "Running stale command",
            command: "rg stale",
            requestKind: "command",
            tone: "tool" as const,
            toolLifecycleStatus: "inProgress" as const,
          },
        },
        {
          id: "user-followup-entry",
          kind: "message",
          createdAt: "2026-01-01T00:01:00Z",
          message: {
            id: "user-followup" as never,
            role: "user",
            text: "continue",
            turnId: null,
            createdAt: "2026-01-01T00:01:00Z",
            updatedAt: "2026-01-01T00:01:00Z",
            streaming: false,
          },
        },
      ],
      latestTurn: null,
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:01:00Z",
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows.some((row) => row.kind === "work-live")).toBe(false);
  });

  it("does not revive separated historical task progress", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "stale-progress-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:05Z",
          entry: {
            id: "stale-progress",
            createdAt: "2026-01-01T00:00:05Z",
            turnId: "turn-1" as never,
            label: "Old progress",
            tone: "thinking" as const,
            sourceActivityKind: "task.progress" as const,
          },
        },
        {
          id: "assistant-commentary-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:06Z",
          message: {
            id: "assistant-commentary" as never,
            role: "assistant",
            text: "Starting another command.",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:06Z",
            updatedAt: "2026-01-01T00:00:06Z",
            streaming: false,
          },
        },
        {
          id: "running-command-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:07Z",
          entry: {
            id: "running-command",
            createdAt: "2026-01-01T00:00:07Z",
            turnId: "turn-1" as never,
            label: "Running command",
            command: "rg current",
            requestKind: "command",
            tone: "tool" as const,
            toolLifecycleStatus: "inProgress" as const,
          },
        },
      ],
      latestTurn: {
        turnId: "turn-1" as never,
        state: "running",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: null,
      },
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:00Z",
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows.filter((row) => row.kind === "work-live").map((row) => row.entry.id)).toEqual([
      "running-command",
    ]);
  });

  it("keeps the latest completed tool call live while the turn is running", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "latest-command-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:05Z",
          entry: {
            id: "latest-command",
            createdAt: "2026-01-01T00:00:05Z",
            turnId: "turn-1" as never,
            label: "Ran rg",
            command: "rg toolCall",
            requestKind: "command",
            tone: "tool" as const,
            toolLifecycleStatus: "completed" as const,
          },
        },
      ],
      latestTurn: {
        turnId: "turn-1" as never,
        state: "running",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: null,
      },
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:00Z",
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows.map((row) => row.kind)).toEqual(["working", "work-live"]);
    expect(rows.find((row) => row.kind === "work-live")).toMatchObject({
      entry: { id: "latest-command" },
      groupedEntries: [{ id: "latest-command" }],
    });
  });

  it("does not fold the session's running turn when latestTurn regresses", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "previous-work-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:05Z",
          entry: {
            id: "previous-work",
            createdAt: "2026-01-01T00:00:05Z",
            turnId: "turn-1" as never,
            label: "Read files",
            tone: "tool" as const,
          },
        },
        {
          id: "user-followup-entry",
          kind: "message",
          createdAt: "2026-01-01T00:01:00Z",
          message: {
            id: "user-followup" as never,
            role: "user",
            text: "continue",
            turnId: null,
            createdAt: "2026-01-01T00:01:00Z",
            updatedAt: "2026-01-01T00:01:00Z",
            streaming: false,
          },
        },
        {
          id: "running-work-entry",
          kind: "work",
          createdAt: "2026-01-01T00:01:05Z",
          entry: {
            id: "running-work",
            createdAt: "2026-01-01T00:01:05Z",
            turnId: "turn-2" as never,
            label: "Searched files",
            tone: "tool" as const,
          },
        },
      ],
      latestTurn: {
        turnId: "turn-1" as never,
        state: "completed",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: "2026-01-01T00:00:25Z",
      },
      runningTurnId: "turn-2" as never,
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:01:00Z",
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows.filter((row) => row.kind === "turn-fold").map((row) => row.turnId)).toEqual([
      "turn-1",
    ]);
    expect(rows.map((row) => row.id)).toContain("work-live:running-work-entry");
  });

  it("only shows assistant metadata on the terminal assistant message", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "assistant-thought-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:10Z",
          message: {
            id: "assistant-thought" as never,
            role: "assistant",
            text: "Checking first.",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:10Z",
            updatedAt: "2026-01-01T00:00:11Z",
            streaming: false,
          },
        },
        {
          id: "assistant-final-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:20Z",
          message: {
            id: "assistant-final" as never,
            role: "assistant",
            text: "Done.",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:20Z",
            updatedAt: "2026-01-01T00:00:30Z",
            streaming: false,
          },
        },
      ],
      expandedTurnIds: new Set(["turn-1" as never]),
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const assistantRows = rows.filter(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.role === "assistant",
    );

    expect(assistantRows.map((row) => row.showAssistantMeta)).toEqual([false, true]);
  });

  it("withholds assistant metadata while the active turn is still in progress", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "assistant-thought-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:10Z",
          message: {
            id: "assistant-thought" as never,
            role: "assistant",
            text: "Working on it.",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:10Z",
            updatedAt: "2026-01-01T00:00:11Z",
            streaming: false,
          },
        },
      ],
      latestTurn: {
        turnId: "turn-1" as never,
        state: "running",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: null,
      },
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:00Z",
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const assistantRow = rows.find(
      (row): row is Extract<(typeof rows)[number], { kind: "message" }> =>
        row.kind === "message" && row.message.role === "assistant",
    );

    expect(assistantRow?.showAssistantMeta).toBe(false);
    expect(assistantRow?.showAssistantCopyButton).toBe(false);
  });

  it("models work log overflow expansion as inserted list rows", () => {
    const timelineEntries = [
      {
        id: "work-entry-1",
        kind: "work" as const,
        createdAt: "2026-01-01T00:00:01Z",
        entry: {
          id: "work-1",
          createdAt: "2026-01-01T00:00:01Z",
          label: "read",
          detail: "Reading package.json",
          tone: "tool" as const,
        },
      },
      {
        id: "work-entry-2",
        kind: "work" as const,
        createdAt: "2026-01-01T00:00:02Z",
        entry: {
          id: "work-2",
          createdAt: "2026-01-01T00:00:02Z",
          label: "edit",
          detail: "Editing MessagesTimeline.tsx",
          tone: "tool" as const,
        },
      },
      {
        id: "work-entry-3",
        kind: "work" as const,
        createdAt: "2026-01-01T00:00:03Z",
        entry: {
          id: "work-3",
          createdAt: "2026-01-01T00:00:03Z",
          label: "test",
          detail: "Running tests",
          tone: "tool" as const,
        },
      },
    ];

    const baseInput = {
      timelineEntries,
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    };
    const collapsedRows = deriveMessagesTimelineRows(baseInput);
    const expandedRows = deriveMessagesTimelineRows({
      ...baseInput,
      expandedWorkGroupIds: new Set(["work-group:work-entry-1"]),
    });

    expect(collapsedRows.map((row) => row.id)).toEqual(["work-toggle:work-entry-1"]);
    expect(collapsedRows.find((row) => row.kind === "work-toggle")).toMatchObject({
      groupId: "work-group:work-entry-1",
      hiddenCount: 3,
      expanded: false,
      onlyToolEntries: true,
      summary: "Used 3 tools",
    });
    expect(expandedRows.map((row) => row.id)).toEqual([
      "work-toggle:work-entry-1",
      "work-1",
      "work-2",
      "work-3",
    ]);
    expect(expandedRows.find((row) => row.kind === "work-toggle")).toMatchObject({
      expanded: true,
    });
  });

  it.each([
    ["recovered", ["failed", "completed"], false],
    ["ending in failure", ["completed", "failed"], true],
    ["failed", ["failed", "failed"], true],
  ] as const)("uses the final call for %s tool groups", (_, statuses, hasFailure) => {
    const timelineEntries = statuses.map((status, index) => ({
      id: `work-entry-${index}`,
      kind: "work" as const,
      createdAt: `2026-01-01T00:00:0${index}Z`,
      entry: {
        id: `work-${index}`,
        createdAt: `2026-01-01T00:00:0${index}Z`,
        label: "Ran command",
        tone: "tool" as const,
        itemType: "command_execution" as const,
        toolLifecycleStatus: status,
      },
    }));

    const rows = deriveMessagesTimelineRows({
      timelineEntries,
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows.find((row) => row.kind === "work-toggle")).toMatchObject({
      hiddenCount: 2,
      hasFailure,
    });
  });

  it("keeps a failure visible when other hidden entries succeeded", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "failed-work-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:01Z",
          entry: {
            id: "failed-work",
            createdAt: "2026-01-01T00:00:01Z",
            label: "Ran command",
            tone: "tool",
            toolLifecycleStatus: "failed",
          },
        },
        {
          id: "completed-work-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:02Z",
          entry: {
            id: "completed-work",
            createdAt: "2026-01-01T00:00:02Z",
            label: "Ran command",
            tone: "tool",
            toolLifecycleStatus: "completed",
          },
        },
        {
          id: "visible-info-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:03Z",
          entry: {
            id: "visible-info",
            createdAt: "2026-01-01T00:00:03Z",
            label: "Status updated",
            tone: "info",
          },
        },
      ],
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows.find((row) => row.kind === "work-toggle")).toMatchObject({
      hiddenCount: 2,
      summary: null,
      hasFailure: true,
    });
  });
});

describe("workLogEntryIsTaskLike", () => {
  it("is true only for entries carrying a non-empty taskId", () => {
    expect(workLogEntryIsTaskLike({ taskId: "task-1" })).toBe(true);
    expect(workLogEntryIsTaskLike({ taskId: "" })).toBe(false);
    expect(workLogEntryIsTaskLike({})).toBe(false);
  });
});

describe("workEntryIsTranscriptVisible", () => {
  const baseEntry = {
    id: "work-1",
    createdAt: "2026-01-01T00:00:01Z",
    label: "Read files",
    tone: "info" as const,
  };

  it("hides skipTranscript task entries from the transcript", () => {
    expect(
      workEntryIsTranscriptVisible({ ...baseEntry, taskId: "task-1", skipTranscript: true }),
    ).toBe(false);
    expect(
      workEntryIsTranscriptVisible({ ...baseEntry, taskId: "task-1", skipTranscript: false }),
    ).toBe(true);
  });

  it("hides panel-only activity projections regardless of tone", () => {
    expect(
      workEntryIsTranscriptVisible({ ...baseEntry, sourceActivityKind: "tool.progress" }),
    ).toBe(false);
    expect(
      workEntryIsTranscriptVisible({
        ...baseEntry,
        sourceActivityKind: "turn.reasoning.summary",
      }),
    ).toBe(false);
  });

  it("keeps ordinary entries and task lifecycle entries visible", () => {
    expect(workEntryIsTranscriptVisible(baseEntry)).toBe(true);
    expect(
      workEntryIsTranscriptVisible({
        ...baseEntry,
        taskId: "task-1",
        sourceActivityKind: "task.progress",
      }),
    ).toBe(true);
  });
});

describe("task card metric formatting", () => {
  it("formats token and tool counts with singular and plural nouns", () => {
    expect(formatTaskTokenCount(1)).toBe("1 token");
    expect(formatTaskTokenCount(1234)).toBe("1,234 tokens");
    expect(formatTaskToolUseCount(1)).toBe("1 tool");
    expect(formatTaskToolUseCount(12)).toBe("12 tools");
  });

  it("includes only provider-supplied metrics in a stable order", () => {
    expect(deriveTaskCardMetricParts({})).toEqual([]);
    expect(deriveTaskCardMetricParts({ usage: { toolUses: 1 } })).toEqual(["1 tool"]);
    expect(deriveTaskCardMetricParts({ lastToolName: "   " })).toEqual([]);
    expect(
      deriveTaskCardMetricParts({
        usage: { totalTokens: 1234, toolUses: 3, durationMs: 45_000 },
        lastToolName: "Read",
      }),
    ).toEqual(["1,234 tokens", "3 tools", "45s", "last: Read"]);
  });
});

describe("resolveTaskCardExpansionA11y", () => {
  it("links the collapsed disclosure to its mounted detail region", () => {
    expect(
      resolveTaskCardExpansionA11y({
        expandable: true,
        expanded: false,
        detailRegionId: "task-card-detail-1",
      }),
    ).toEqual({
      "aria-expanded": false,
      "aria-controls": "task-card-detail-1",
    });
  });

  it("keeps the same region link when the disclosure is expanded", () => {
    expect(
      resolveTaskCardExpansionA11y({
        expandable: true,
        expanded: true,
        detailRegionId: "task-card-detail-1",
      }),
    ).toEqual({
      "aria-expanded": true,
      "aria-controls": "task-card-detail-1",
    });
  });

  it("exposes no expansion semantics when the card has no expandable detail", () => {
    for (const expanded of [false, true]) {
      expect(
        resolveTaskCardExpansionA11y({
          expandable: false,
          expanded,
          detailRegionId: "task-card-detail-1",
        }),
      ).toEqual({});
    }
  });
});

describe("deriveMessagesTimelineRows task entries", () => {
  const baseRowsInput = {
    isWorking: false,
    activeTurnStartedAt: null,
    turnDiffSummaryByAssistantMessageId: new Map(),
    revertTurnCountByUserMessageId: new Map(),
  };

  it("keeps info and thinking in-progress task entries while dropping neutral ordinary tools", () => {
    for (const tone of ["info", "thinking"] as const) {
      const rows = deriveMessagesTimelineRows({
        ...baseRowsInput,
        timelineEntries: [
          {
            id: "task-entry",
            kind: "work",
            createdAt: "2026-01-01T00:00:01Z",
            entry: {
              id: "work-task-1",
              createdAt: "2026-01-01T00:00:01Z",
              label: "Explore the codebase",
              tone,
              taskId: "task-1",
              toolLifecycleStatus: "inProgress",
            },
          },
          {
            id: "neutral-tool-entry",
            kind: "work",
            createdAt: "2026-01-01T00:00:02Z",
            entry: {
              id: "work-neutral-tool",
              createdAt: "2026-01-01T00:00:02Z",
              label: "Glob",
              tone: "tool",
              toolLifecycleStatus: "inProgress",
            },
          },
        ],
      });

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ kind: "work", id: "task-entry" });
      const workRow = rows[0] as Extract<(typeof rows)[number], { kind: "work" }>;
      expect(workRow.groupedEntries.map((entry) => entry.id)).toEqual(["work-task-1"]);
    }
  });

  it("removes skipTranscript tasks before grouping, hidden counts, and toggle construction", () => {
    const rows = deriveMessagesTimelineRows({
      ...baseRowsInput,
      timelineEntries: [
        {
          id: "work-entry-1",
          kind: "work",
          createdAt: "2026-01-01T00:00:01Z",
          entry: {
            id: "work-1",
            createdAt: "2026-01-01T00:00:01Z",
            label: "Ran command",
            tone: "tool",
            toolLifecycleStatus: "completed",
          },
        },
        {
          id: "work-entry-hidden",
          kind: "work",
          createdAt: "2026-01-01T00:00:02Z",
          entry: {
            id: "work-hidden",
            createdAt: "2026-01-01T00:00:02Z",
            label: "Housekeeping sweep",
            tone: "info",
            taskId: "task-hidden",
            skipTranscript: true,
          },
        },
        {
          id: "work-entry-2",
          kind: "work",
          createdAt: "2026-01-01T00:00:03Z",
          entry: {
            id: "work-2",
            createdAt: "2026-01-01T00:00:03Z",
            label: "Read files",
            tone: "tool",
            toolLifecycleStatus: "completed",
          },
        },
      ],
    });

    expect(rows.map((row) => row.id)).toEqual(["work-toggle:work-entry-1"]);
    expect(rows.find((row) => row.kind === "work-toggle")).toMatchObject({
      hiddenCount: 2,
      onlyToolEntries: true,
      onlyTaskEntries: false,
    });
    expect(
      rows.every(
        (row) =>
          row.kind !== "work" || row.groupedEntries.every((entry) => entry.id !== "work-hidden"),
      ),
    ).toBe(true);
  });

  it("never creates rows from tool.progress or turn.reasoning.summary projections", () => {
    const rows = deriveMessagesTimelineRows({
      ...baseRowsInput,
      timelineEntries: [
        {
          id: "panel-progress-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:01Z",
          entry: {
            id: "work-panel-progress",
            createdAt: "2026-01-01T00:00:01Z",
            label: "Read in progress",
            tone: "info",
            sourceActivityKind: "tool.progress",
          },
        },
        {
          id: "panel-reasoning-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:02Z",
          entry: {
            id: "work-panel-reasoning",
            createdAt: "2026-01-01T00:00:02Z",
            label: "Reasoning summary",
            tone: "thinking",
            sourceActivityKind: "turn.reasoning.summary",
          },
        },
        {
          id: "visible-tool-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:03Z",
          entry: {
            id: "work-visible",
            createdAt: "2026-01-01T00:00:03Z",
            label: "Ran command",
            tone: "tool",
            toolLifecycleStatus: "completed",
          },
        },
      ],
    });

    expect(rows.map((row) => row.id)).toEqual(["work-toggle:visible-tool-entry"]);
  });

  it("marks task-only overflow groups as onlyTaskEntries", () => {
    const taskTimelineEntry = (suffix: string, createdAt: string) => ({
      id: `task-entry-${suffix}`,
      kind: "work" as const,
      createdAt,
      entry: {
        id: `work-task-${suffix}`,
        createdAt,
        label: `Task ${suffix}`,
        tone: "info" as const,
        taskId: `task-${suffix}`,
        toolLifecycleStatus: "completed" as const,
      },
    });

    const rows = deriveMessagesTimelineRows({
      ...baseRowsInput,
      timelineEntries: [
        taskTimelineEntry("1", "2026-01-01T00:00:01Z"),
        taskTimelineEntry("2", "2026-01-01T00:00:02Z"),
        taskTimelineEntry("3", "2026-01-01T00:00:03Z"),
      ],
    });

    expect(rows.map((row) => row.id)).toEqual(["work-task-3", "work-toggle:task-entry-1"]);
    expect(rows.find((row) => row.kind === "work-toggle")).toMatchObject({
      hiddenCount: 2,
      onlyToolEntries: false,
      onlyTaskEntries: true,
    });
  });

  it("marks mixed task and tool groups as neither only-tool nor only-task", () => {
    const rows = deriveMessagesTimelineRows({
      ...baseRowsInput,
      timelineEntries: [
        {
          id: "tool-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:01Z",
          entry: {
            id: "work-tool-1",
            createdAt: "2026-01-01T00:00:01Z",
            label: "Ran command",
            tone: "tool",
            toolLifecycleStatus: "completed",
          },
        },
        {
          id: "task-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:02Z",
          entry: {
            id: "work-task-1",
            createdAt: "2026-01-01T00:00:02Z",
            label: "Explore the codebase",
            tone: "info",
            taskId: "task-1",
            toolLifecycleStatus: "completed",
          },
        },
      ],
    });

    expect(rows.map((row) => row.id)).toEqual(["work-task-1", "work-toggle:tool-entry"]);
    expect(rows.find((row) => row.kind === "work-toggle")).toMatchObject({
      hiddenCount: 1,
      onlyToolEntries: false,
      onlyTaskEntries: false,
    });
  });

  it("removes skipTranscript tasks before turn-fold anchoring and expansion", () => {
    const timelineEntries = [
      {
        id: "user-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:00Z",
        message: {
          id: "user-1" as never,
          role: "user" as const,
          text: "Run the sweep",
          turnId: null,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          streaming: false,
        },
      },
      {
        id: "work-entry-hidden",
        kind: "work" as const,
        createdAt: "2026-01-01T00:00:05Z",
        entry: {
          id: "work-hidden",
          createdAt: "2026-01-01T00:00:05Z",
          turnId: "turn-1" as never,
          label: "Housekeeping sweep",
          tone: "info" as const,
          taskId: "task-hidden",
          skipTranscript: true,
        },
      },
      {
        id: "work-entry-tool",
        kind: "work" as const,
        createdAt: "2026-01-01T00:00:08Z",
        entry: {
          id: "work-tool",
          createdAt: "2026-01-01T00:00:08Z",
          turnId: "turn-1" as never,
          label: "Ran command",
          tone: "tool" as const,
          toolLifecycleStatus: "completed" as const,
        },
      },
      {
        id: "assistant-final-entry",
        kind: "message" as const,
        createdAt: "2026-01-01T00:00:20Z",
        message: {
          id: "assistant-final" as never,
          role: "assistant" as const,
          text: "Done",
          turnId: "turn-1" as never,
          createdAt: "2026-01-01T00:00:20Z",
          updatedAt: "2026-01-01T00:00:22Z",
          streaming: false,
        },
      },
    ];
    const latestTurn = {
      turnId: "turn-1" as never,
      state: "completed" as const,
      startedAt: "2026-01-01T00:00:00Z",
      completedAt: "2026-01-01T00:00:22Z",
    };

    const collapsedRows = deriveMessagesTimelineRows({
      ...baseRowsInput,
      timelineEntries,
      latestTurn,
    });

    // The fold anchors at the first visible turn entry — the removed
    // skipTranscript task can neither anchor nor appear behind the fold.
    expect(collapsedRows.map((row) => row.id)).toEqual([
      "user-entry",
      "turn-fold:turn-1",
      "assistant-final-entry",
    ]);

    const expandedRows = deriveMessagesTimelineRows({
      ...baseRowsInput,
      timelineEntries,
      latestTurn,
      expandedTurnIds: new Set(["turn-1" as never]),
    });

    expect(expandedRows.map((row) => row.id)).toEqual([
      "user-entry",
      "turn-fold:turn-1",
      "work-toggle:work-entry-tool",
      "assistant-final-entry",
    ]);
    expect(expandedRows.some((row) => row.id === "work-entry-hidden")).toBe(false);
  });
});

describe("computeStableMessagesTimelineRows", () => {
  it("returns the previous result when row order and content are unchanged", () => {
    const firstUserMessage = {
      id: "user-1" as never,
      role: "user" as const,
      text: "First",
      turnId: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      streaming: false,
    };
    const secondUserMessage = {
      id: "user-2" as never,
      role: "user" as const,
      text: "Second",
      turnId: null,
      createdAt: "2026-01-01T00:00:10Z",
      updatedAt: "2026-01-01T00:00:10Z",
      streaming: false,
    };

    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "entry-user-1",
          kind: "message",
          createdAt: firstUserMessage.createdAt,
          message: firstUserMessage,
        },
        {
          id: "entry-user-2",
          kind: "message",
          createdAt: secondUserMessage.createdAt,
          message: secondUserMessage,
        },
      ],
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const initial = computeStableMessagesTimelineRows(rows, {
      byId: new Map(),
      result: [],
    });

    const repeated = computeStableMessagesTimelineRows(rows, initial);

    expect(repeated).toBe(initial);
    expect(repeated.result).toBe(initial.result);
  });

  it("reuses work rows when equivalent timeline derivations create new grouped arrays", () => {
    const firstWorkEntry = {
      id: "work-1",
      createdAt: "2026-01-01T00:00:00Z",
      label: "thinking",
      detail: "Inspecting repository state",
      tone: "thinking" as const,
    };
    const secondWorkEntry = {
      id: "work-2",
      createdAt: "2026-01-01T00:00:01Z",
      label: "read",
      detail: "Reading package.json",
      tone: "tool" as const,
    };

    const createRows = () =>
      deriveMessagesTimelineRows({
        timelineEntries: [
          {
            id: "entry-work-1",
            kind: "work",
            createdAt: firstWorkEntry.createdAt,
            entry: firstWorkEntry,
          },
          {
            id: "entry-work-2",
            kind: "work",
            createdAt: secondWorkEntry.createdAt,
            entry: secondWorkEntry,
          },
        ],
        isWorking: false,
        activeTurnStartedAt: null,
        turnDiffSummaryByAssistantMessageId: new Map(),
        revertTurnCountByUserMessageId: new Map(),
      });

    const firstRows = createRows();
    const initial = computeStableMessagesTimelineRows(firstRows, {
      byId: new Map(),
      result: [],
    });
    const secondRows = createRows();

    expect(secondRows[0]).not.toBe(firstRows[0]);

    const repeated = computeStableMessagesTimelineRows(secondRows, initial);

    expect(repeated).toBe(initial);
    expect(repeated.result[0]).toBe(initial.result[0]);
  });

  it("returns a new result when row order changes without content changes", () => {
    const firstUserMessage = {
      id: "user-1" as never,
      role: "user" as const,
      text: "First",
      turnId: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      streaming: false,
    };
    const secondUserMessage = {
      id: "user-2" as never,
      role: "user" as const,
      text: "Second",
      turnId: null,
      createdAt: "2026-01-01T00:00:10Z",
      updatedAt: "2026-01-01T00:00:10Z",
      streaming: false,
    };

    const firstRows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "entry-user-1",
          kind: "message",
          createdAt: firstUserMessage.createdAt,
          message: firstUserMessage,
        },
        {
          id: "entry-user-2",
          kind: "message",
          createdAt: secondUserMessage.createdAt,
          message: secondUserMessage,
        },
      ],
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    const initial = computeStableMessagesTimelineRows(firstRows, {
      byId: new Map(),
      result: [],
    });

    const reordered = computeStableMessagesTimelineRows([firstRows[1]!, firstRows[0]!], initial);

    expect(reordered).not.toBe(initial);
    expect(reordered.result).toEqual([initial.result[1], initial.result[0]]);
  });

  describe("production task lifecycle pipeline", () => {
    const lifecycleTurnId = TurnId.make("turn-lifecycle");

    function makeTaskActivity(overrides: {
      id: string;
      createdAt: string;
      sequence: number;
      kind: "task.started" | "task.progress" | "task.completed";
      summary: string;
      payload: Record<string, unknown>;
    }): OrchestrationThreadActivity {
      return {
        id: EventId.make(overrides.id),
        createdAt: overrides.createdAt,
        kind: overrides.kind,
        summary: overrides.summary,
        tone: "tool",
        payload: overrides.payload,
        turnId: lifecycleTurnId,
        sequence: overrides.sequence,
      };
    }

    const makeLifecycleStarted = () =>
      makeTaskActivity({
        id: "task-activity-started",
        createdAt: "2026-02-23T00:00:01.000Z",
        sequence: 1,
        kind: "task.started",
        summary: "Task started",
        payload: {
          taskId: "task-1",
          toolUseId: "tool-use-1",
          description: "Explore the codebase",
          taskType: "agent",
          subagentType: "explorer",
          workflowName: "review-workflow",
          prompt: "Map the timeline rendering path",
        },
      });

    const makeLifecycleCompleted = (payload: Record<string, unknown>) =>
      makeTaskActivity({
        id: "task-activity-completed",
        createdAt: "2026-02-23T00:00:03.000Z",
        sequence: 3,
        kind: "task.completed",
        summary: "Task completed",
        payload: { taskId: "task-1", ...payload },
      });

    // The full production path a provider task snapshot travels before React:
    // activities -> deriveWorkLogEntries -> deriveTimelineEntries ->
    // deriveMessagesTimelineRows -> computeStableMessagesTimelineRows.
    function deriveTaskRows(
      activities: ReadonlyArray<OrchestrationThreadActivity>,
    ): MessagesTimelineRow[] {
      const workEntries = deriveWorkLogEntries(activities);
      const timelineEntries = deriveTimelineEntries([], [], workEntries);
      return deriveMessagesTimelineRows({
        timelineEntries,
        // The parent turn is still running while a subagent task streams
        // start/progress/completion, so no settled-turn fold hides the card.
        latestTurn: {
          turnId: lifecycleTurnId,
          state: "running",
          startedAt: "2026-02-23T00:00:00.000Z",
          completedAt: null,
        },
        isWorking: false,
        activeTurnStartedAt: null,
        turnDiffSummaryByAssistantMessageId: new Map(),
        revertTurnCountByUserMessageId: new Map(),
      });
    }

    function deriveSingleTaskRow(activities: ReadonlyArray<OrchestrationThreadActivity>) {
      const rows = deriveTaskRows(activities);
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.kind).toBe("work");
      return row as Extract<MessagesTimelineRow, { kind: "work" }>;
    }

    const emptyStableState = (): StableMessagesTimelineRowsState => ({
      byId: new Map(),
      result: [],
    });

    it("keeps one stable task row across derived start/progress/completion snapshots", () => {
      const started = makeLifecycleStarted();
      const progress = makeTaskActivity({
        id: "task-activity-progress",
        createdAt: "2026-02-23T00:00:02.000Z",
        sequence: 2,
        kind: "task.progress",
        summary: "Reasoning update",
        payload: {
          taskId: "task-1",
          summary: "Scanning files",
          usage: { total_tokens: 1200, tool_uses: 4, duration_ms: 30_000 },
          lastToolName: "Read",
        },
      });
      const completed = makeLifecycleCompleted({
        status: "completed",
        summary: "Found three files",
        outputFile: "/tmp/reports/out.md",
        usage: { total_tokens: 2400, tool_uses: 9, duration_ms: 61_000 },
      });

      const startRow = deriveSingleTaskRow([started]);
      const progressRow = deriveSingleTaskRow([started, progress]);
      const completedRow = deriveSingleTaskRow([started, progress, completed]);

      // Every snapshot produces exactly one task row at one production-derived
      // identity: the row id IS the work-entry id that MessagesTimeline passes
      // to TaskWorkEntryRow as key={workEntry.id}. Because that key is stable,
      // the card keeps its local disclosure (expansion) state while the
      // lifecycle content swaps underneath it.
      for (const row of [startRow, progressRow, completedRow]) {
        expect(row.id).toBe("task-activity-started");
        expect(row.groupedEntries.map((entry) => entry.id)).toEqual(["task-activity-started"]);
      }

      // Lifecycle-visible content reflects the latest valid reduced state.
      const startEntry = startRow.groupedEntries[0]!;
      expect(startEntry).toMatchObject({
        taskId: "task-1",
        toolLifecycleStatus: "inProgress",
        tone: "info",
        label: "Explore the codebase",
        description: "Explore the codebase",
        taskType: "agent",
        subagentType: "explorer",
        workflowName: "review-workflow",
        prompt: "Map the timeline rendering path",
        sourceActivityKind: "task.started",
      });
      expect(startEntry.usage).toBeUndefined();
      expect(startEntry.progressSummary).toBeUndefined();
      expect(startEntry.resultSummary).toBeUndefined();

      const progressEntry = progressRow.groupedEntries[0]!;
      expect(progressEntry).toMatchObject({
        taskId: "task-1",
        toolLifecycleStatus: "inProgress",
        tone: "thinking",
        label: "Scanning files",
        progressSummary: "Scanning files",
        usage: { totalTokens: 1200, toolUses: 4, durationMs: 30_000 },
        lastToolName: "Read",
        sourceActivityKind: "task.progress",
      });
      expect(progressEntry.resultSummary).toBeUndefined();

      const completedEntry = completedRow.groupedEntries[0]!;
      expect(completedEntry).toMatchObject({
        taskId: "task-1",
        toolLifecycleStatus: "completed",
        tone: "info",
        label: "Found three files",
        progressSummary: "Scanning files",
        resultSummary: "Found three files",
        usage: { totalTokens: 2400, toolUses: 9, durationMs: 61_000 },
        lastToolName: "Read",
        outputFile: "/tmp/reports/out.md",
        sourceActivityKind: "task.completed",
      });

      // Thread successive derived row arrays through the stable-row reducer,
      // passing the previous state into the next call exactly as ChatView does.
      const startState = computeStableMessagesTimelineRows(
        deriveTaskRows([started]),
        emptyStableState(),
      );
      const progressState = computeStableMessagesTimelineRows(
        deriveTaskRows([started, progress]),
        startState,
      );
      const completedState = computeStableMessagesTimelineRows(
        deriveTaskRows([started, progress, completed]),
        progressState,
      );

      // A changed lifecycle snapshot replaces the row object at the same id...
      expect(progressState).not.toBe(startState);
      expect(progressState.result[0]).not.toBe(startState.result[0]);
      expect(completedState).not.toBe(progressState);
      expect(completedState.result[0]).not.toBe(progressState.result[0]);
      expect(progressState.result[0]?.id).toBe(startState.result[0]?.id);
      expect(completedState.result[0]?.id).toBe(startState.result[0]?.id);

      // ...and the replacement carries the latest lifecycle-visible content.
      const stableProgressRow = progressState.result[0] as Extract<
        MessagesTimelineRow,
        { kind: "work" }
      >;
      expect(stableProgressRow.groupedEntries[0]).toMatchObject({
        toolLifecycleStatus: "inProgress",
        progressSummary: "Scanning files",
        usage: { totalTokens: 1200, toolUses: 4, durationMs: 30_000 },
        lastToolName: "Read",
      });
      const stableCompletedRow = completedState.result[0] as Extract<
        MessagesTimelineRow,
        { kind: "work" }
      >;
      expect(stableCompletedRow.groupedEntries[0]).toMatchObject({
        toolLifecycleStatus: "completed",
        resultSummary: "Found three files",
        usage: { totalTokens: 2400, toolUses: 9, durationMs: 61_000 },
        outputFile: "/tmp/reports/out.md",
      });

      // An equivalent repeated completed snapshot reuses the prior stable
      // state instead of producing another replacement.
      const repeatedCompletedState = computeStableMessagesTimelineRows(
        deriveTaskRows([started, progress, completed]),
        completedState,
      );
      expect(repeatedCompletedState).toBe(completedState);
    });

    it("replaces the stable task row when a repeated completion snapshot gains output", () => {
      const started = makeLifecycleStarted();
      const completedWithoutOutput = makeLifecycleCompleted({
        status: "completed",
        summary: "Found three files",
      });
      const completedWithOutput = makeLifecycleCompleted({
        status: "completed",
        summary: "Found three files",
        outputFile: "/tmp/reports/out.md",
      });

      const initial = computeStableMessagesTimelineRows(
        deriveTaskRows([started, completedWithoutOutput]),
        emptyStableState(),
      );

      const updated = computeStableMessagesTimelineRows(
        deriveTaskRows([started, completedWithOutput]),
        initial,
      );

      expect(updated).not.toBe(initial);
      expect(updated.result[0]).not.toBe(initial.result[0]);
      expect(updated.result[0]?.id).toBe(initial.result[0]?.id);
      const updatedRow = updated.result[0] as Extract<MessagesTimelineRow, { kind: "work" }>;
      expect(updatedRow.groupedEntries[0]?.outputFile).toBe("/tmp/reports/out.md");

      // Once published, an equivalent fresh derivation reuses the updated row.
      const repeated = computeStableMessagesTimelineRows(
        deriveTaskRows([started, completedWithOutput]),
        updated,
      );
      expect(repeated).toBe(updated);
    });

    it("returns a new state when a task leaves the transcript", () => {
      const started = makeLifecycleStarted();
      const hiddenCompleted = makeLifecycleCompleted({
        status: "completed",
        summary: "Sweep finished",
        skipTranscript: true,
      });

      const visibleRows = deriveTaskRows([started]);
      expect(visibleRows).toHaveLength(1);
      const initial = computeStableMessagesTimelineRows(visibleRows, emptyStableState());

      // The same task with skipTranscript set by its terminal snapshot derives
      // zero rows — the timeline must publish a new (empty) result instead of
      // holding the stale row.
      const hiddenRows = deriveTaskRows([started, hiddenCompleted]);
      expect(hiddenRows).toHaveLength(0);

      const updated = computeStableMessagesTimelineRows(hiddenRows, initial);
      expect(updated).not.toBe(initial);
      expect(updated.result).toHaveLength(0);

      const restored = computeStableMessagesTimelineRows(deriveTaskRows([started]), updated);
      expect(restored).not.toBe(updated);
      expect(restored.result).toHaveLength(1);
      expect(restored.result[0]?.id).toBe("task-activity-started");
    });
  });
});

describe("messageEntryIsTranscriptVisible", () => {
  it("hides the wake-up message a finished task injects into its parent", () => {
    expect(messageEntryIsTranscriptVisible({ role: "user", source: "task-result" })).toBe(false);
  });

  it("keeps every message a person or a provider actually produced", () => {
    expect(messageEntryIsTranscriptVisible({ role: "user", source: "user" })).toBe(true);
    expect(messageEntryIsTranscriptVisible({ role: "assistant", source: "provider" })).toBe(true);
    expect(messageEntryIsTranscriptVisible({ role: "system", source: "system" })).toBe(true);
    // Rows written before authorship was tracked carry no source at all.
    expect(messageEntryIsTranscriptVisible({ role: "user" })).toBe(true);
  });

  it("removes task-result messages before rows are derived", () => {
    const createdAt = "2026-01-01T00:00:00Z";
    const message = (id: string, source: "user" | "task-result") => ({
      id: `entry:${id}`,
      kind: "message" as const,
      createdAt,
      message: {
        id: MessageId.make(id),
        role: "user" as const,
        source,
        text: id,
        turnId: null,
        createdAt,
        updatedAt: createdAt,
        streaming: false,
      },
    });

    const rows = deriveMessagesTimelineRows({
      timelineEntries: [message("typed", "user"), message("woken", "task-result")],
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaryByAssistantMessageId: new Map(),
      revertTurnCountByUserMessageId: new Map(),
    });

    expect(rows.flatMap((row) => (row.kind === "message" ? [row.message.text] : []))).toEqual([
      "typed",
    ]);
  });
});
