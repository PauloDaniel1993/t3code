import {
  MessageId,
  NodeId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import {
  buildBoundedThreadProjection,
  boundedTimelineEncodedBytes,
  computeLatestLocalTurnOrdinal,
  encodeThreadHistoryCursor,
  projectedRowBoundedSnapshotEncodedBytes,
  projectedRowEncodedBytes,
  selectHistoryPageFromCursor,
  selectRecentTimelineWindow,
  THREAD_HISTORY_PAGE_POLICY,
} from "./threadHistoryPaging.ts";
import { projectThreadProjectionForWire } from "./WireProjection.ts";
import { buildBoundedThreadStreamSnapshot } from "./ThreadStream.ts";

const NOW = DateTime.makeUnsafe("2026-06-20T00:00:00.000Z");
const THREAD = ThreadId.make("thread-1");
const RUN = RunId.make("run-interrupt-1");
const NODE = NodeId.make("node-interrupt-1");

function makeRow(
  index: number,
  options?: { readonly outputBytes?: number },
): OrchestrationV2ProjectedTurnItem {
  const id = TurnItemId.make(`item-${index}`);
  const output =
    options?.outputBytes !== undefined ? "x".repeat(options.outputBytes) : `output-${index}`;
  return {
    position: index,
    visibility: "local",
    sourceThreadId: THREAD,
    sourceItemId: id,
    item: {
      id,
      type: "command_execution",
      threadId: THREAD,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: index + 1,
      status: "completed",
      title: `Command ${index}`,
      input: `cmd-${index}`,
      output,
      exitCode: 0,
      startedAt: NOW,
      completedAt: NOW,
      updatedAt: NOW,
    },
  };
}

function interruptItem(
  id: string,
  type: "run_interrupt_request" | "run_interrupt_result",
  ordinal: number,
): OrchestrationV2TurnItem {
  return {
    id: TurnItemId.make(id),
    type,
    threadId: THREAD,
    runId: RUN,
    nodeId: NODE,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed",
    title: type,
    message: type === "run_interrupt_request" ? "Stopping" : "Stopped",
    startedAt: NOW,
    completedAt: NOW,
    updatedAt: NOW,
  } as OrchestrationV2TurnItem;
}

function interruptRow(
  index: number,
  type: "run_interrupt_request" | "run_interrupt_result",
): OrchestrationV2ProjectedTurnItem {
  const item = interruptItem(
    type === "run_interrupt_request" ? "interrupt-req" : "interrupt-res",
    type,
    index + 1,
  );
  return {
    position: index,
    visibility: "local",
    sourceThreadId: THREAD,
    sourceItemId: item.id,
    item,
  };
}

function makeProjection(visibleTurnItems: OrchestrationV2ProjectedTurnItem[]) {
  return {
    thread: {
      id: THREAD,
      projectId: "project-1",
      title: "Thread",
      providerInstanceId: "codex",
      modelSelection: { instanceId: "codex", model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: THREAD,
      },
      forkedFrom: null,
      createdBy: "user",
      creationSource: "web",
      createdAt: NOW,
      updatedAt: NOW,
      archivedAt: null,
      deletedAt: null,
      settledOverride: null,
      settledAt: null,
    },
    runs: [{ id: "run-1" }],
    attempts: [{ id: "attempt-1" }],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runtimeRequests: [{ id: "req-1" }],
    messages: [],
    plans: [],
    turnItems: visibleTurnItems.map((row) => row.item),
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems,
    updatedAt: NOW,
  } as unknown as Parameters<typeof buildBoundedThreadProjection>[0]["projection"];
}

describe("threadHistoryPaging", () => {
  it("bounds node-bearing history and preserves active control ancestors", () => {
    const rows = Array.from({ length: 10_001 }, (_, i) => makeRow(i));
    const first = rows[0]!;
    if (first.item.type !== "command_execution") throw new Error("Expected command fixture");
    rows[0] = {
      ...first,
      item: {
        ...first.item,
        type: "user_message",
        messageId: MessageId.make("prompt"),
        text: "go",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
        inputIntent: "turn_start",
      },
    };
    const nodes = rows.slice(1).map((row, i) => ({
      id: NodeId.make(`node-${i}`),
      threadId: THREAD,
      runId: null,
      parentNodeId: NODE,
      rootNodeId: NODE,
      kind: "tool_call" as const,
      status: "completed" as const,
      countsForRun: true,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      runtimeRequestId: null,
      checkpointScopeId: null,
      startedAt: NOW,
      completedAt: NOW,
    }));
    for (let i = 1; i < rows.length; i++)
      rows[i] = { ...rows[i]!, item: { ...rows[i]!.item, nodeId: nodes[i - 1]!.id } };
    const root = { ...nodes[0]!, id: NODE, kind: "root_turn" as const, parentNodeId: null };
    const live = {
      ...nodes[0]!,
      id: NodeId.make("off-page-live"),
      status: "waiting" as const,
      completedAt: null,
    };
    const snapshot = buildBoundedThreadStreamSnapshot({
      snapshotSequence: 1,
      projection: { ...makeProjection(rows), nodes: [root, live, ...nodes] },
    });
    expect(snapshot.projection.visibleTurnItems).toHaveLength(THREAD_HISTORY_PAGE_POLICY.maxItems);
    expect(snapshot.projection.nodes).toHaveLength(THREAD_HISTORY_PAGE_POLICY.maxItems + 2);
    expect(snapshot.projection.nodes).toContainEqual(root);
    expect(snapshot.projection.nodes).toContainEqual(live);
    expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThanOrEqual(1_048_576);
    expect(Buffer.byteLength(JSON.stringify(snapshot.projection))).toBeLessThanOrEqual(1_048_576);
  });

  it("builds a resumable bounded socket snapshot frame", () => {
    const projection = makeProjection(Array.from({ length: 90 }, (_, index) => makeRow(index)));
    const item = buildBoundedThreadStreamSnapshot({
      snapshotSequence: 23,
      projection,
    });

    expect(item.kind).toBe("snapshot");
    expect(item.snapshotSequence).toBe(23);
    expect(item.projection.visibleTurnItems).toHaveLength(THREAD_HISTORY_PAGE_POLICY.maxItems);
    expect(item.historyCursor).not.toBeNull();
    expect(item.hasMoreHistory).toBe(true);
    expect(item.latestLocalTurnOrdinal).toBe(90);
    expect(Buffer.byteLength(JSON.stringify(item.projection))).toBeLessThanOrEqual(1_048_576);
  });

  it("keeps a human turn whole up to the turn row budget and pages a longer one from inside", () => {
    const humanTurn = (length: number) => {
      const items = Array.from({ length }, (_, index) => makeRow(index));
      items[0] = {
        ...items[0]!,
        item: {
          ...items[0]!.item,
          type: "user_message",
          createdBy: "user",
          creationSource: "web",
          inputIntent: "turn_start",
          messageId: MessageId.make("long-human-turn"),
          text: "Continue",
          attachments: [],
        },
      } as OrchestrationV2ProjectedTurnItem;
      return items;
    };

    const whole = selectRecentTimelineWindow({ items: humanTurn(180), snapshotSequence: 1 });
    expect(whole.items).toHaveLength(180);
    expect(whole.hasMoreHistory).toBe(false);

    const items = humanTurn(THREAD_HISTORY_PAGE_POLICY.maxTurnItems + 100);
    const recent = selectRecentTimelineWindow({ items, snapshotSequence: 1 });
    expect(recent.items).toHaveLength(THREAD_HISTORY_PAGE_POLICY.maxItems);
    const loaded = [...recent.items];
    let cursor = recent.nextCursor;
    for (let pages = 0; cursor !== null; pages += 1) {
      expect(pages).toBeLessThan(items.length);
      const page = selectHistoryPageFromCursor({ items, cursor, snapshotSequence: 1 });
      expect(page.items.length).toBeGreaterThan(0);
      expect(page.items.length).toBeLessThanOrEqual(
        page.items[0]?.item.type === "user_message"
          ? THREAD_HISTORY_PAGE_POLICY.maxTurnItems
          : THREAD_HISTORY_PAGE_POLICY.maxItems,
      );
      loaded.unshift(...page.items);
      cursor = page.nextCursor;
    }
    expect(loaded.map((row) => row.sourceItemId)).toEqual(items.map((row) => row.sourceItemId));

    const large = items
      .slice(0, 12)
      .map((row) =>
        row.item.type === "command_execution"
          ? { ...row, item: { ...row.item, output: "x".repeat(200_000) } }
          : row,
      );
    const bounded = buildBoundedThreadProjection({
      projection: makeProjection(large),
      snapshotSequence: 1,
    });
    expect(bounded.projection.visibleTurnItems.length).toBeLessThan(large.length);
    expect(boundedTimelineEncodedBytes(bounded.projection)).toBeLessThanOrEqual(
      THREAD_HISTORY_PAGE_POLICY.maxEncodedBytes,
    );
  });

  it("keeps background turns with user turns, with main's 150-turn fan-out ceiling", () => {
    const items = Array.from({ length: 161 }, (_, turn) => {
      const row = makeRow(turn * 2);
      if (row.item.type !== "command_execution") throw new Error("Expected command fixture");
      const prompt: OrchestrationV2ProjectedTurnItem = {
        ...row,
        item: {
          ...row.item,
          type: "user_message",
          createdBy: turn === 0 ? "user" : "agent",
          creationSource: "provider",
          inputIntent: "turn_start",
          messageId: MessageId.make(`prompt-${turn}`),
          text: `Prompt ${turn}`,
          attachments: [],
        },
      };
      return [prompt, makeRow(turn * 2 + 1)];
    }).flat();
    const policy = { ...THREAD_HISTORY_PAGE_POLICY, maxItems: 1_000, maxEncodedBytes: 10_000_000 };
    const first = selectRecentTimelineWindow({ items, snapshotSequence: 1, policy });
    expect(first.items).toHaveLength(300);
    expect(first.items[0]?.sourceItemId).toBe("item-22");
    const older = selectHistoryPageFromCursor({
      items,
      cursor: first.nextCursor!,
      snapshotSequence: 1,
      policy,
    });
    expect(older.items).toHaveLength(22);
    expect(older.hasMoreHistory).toBe(false);
    expect([...older.items, ...first.items].map((row) => row.sourceItemId)).toEqual(
      items.map((row) => row.sourceItemId),
    );
  });

  it("measures and pages one turn with 10,000 tool items without gaps or duplicates", () => {
    const command = makeRow(0);
    if (command.item.type !== "command_execution") throw new Error("Expected command fixture");
    const user = {
      ...command,
      item: {
        ...command.item,
        type: "user_message",
        messageId: MessageId.make("prompt"),
        createdBy: "user",
        creationSource: "web",
        inputIntent: "turn_start",
        text: "Run tools",
        attachments: [],
      },
    } satisfies OrchestrationV2ProjectedTurnItem;
    const items = [user, ...Array.from({ length: 10_000 }, (_, index) => makeRow(index + 1))];
    const first = buildBoundedThreadStreamSnapshot({
      projection: makeProjection(items),
      snapshotSequence: 1,
    });
    expect(first.projection.visibleTurnItems).toHaveLength(THREAD_HISTORY_PAGE_POLICY.maxItems);
    expect(Buffer.byteLength(JSON.stringify(first.projection))).toBeLessThanOrEqual(
      THREAD_HISTORY_PAGE_POLICY.maxEncodedBytes,
    );
    let cursor: string | null = first.historyCursor ?? null;
    const loaded = [...first.projection.visibleTurnItems];
    let pages = 1;
    while (cursor !== null) {
      const page = selectHistoryPageFromCursor({ items, cursor, snapshotSequence: 1 });
      expect(page.items.length).toBeGreaterThan(0);
      expect(page.items.length).toBeLessThanOrEqual(THREAD_HISTORY_PAGE_POLICY.maxTurnItems);
      loaded.unshift(...page.items);
      cursor = page.nextCursor;
      pages += 1;
    }
    expect(loaded.map((row) => row.sourceItemId)).toEqual(items.map((row) => row.sourceItemId));
    const wireItems = projectThreadProjectionForWire(makeProjection(items)).visibleTurnItems;
    process.stdout.write(
      JSON.stringify({
        measurement: "single-turn history",
        beforeRows: wireItems.length,
        beforeBytes: Buffer.byteLength(JSON.stringify(wireItems)),
        afterRows: first.projection.visibleTurnItems.length,
        afterBytes: Buffer.byteLength(JSON.stringify(first.projection.visibleTurnItems)),
        pages,
      }),
    );
  });

  it("keeps the latest assistant identity beyond the page while omitting earlier hidden messages", () => {
    const rows = Array.from({ length: 500 }, (_, index) => makeRow(index, { outputBytes: 20_000 }));
    const first = rows[0]!;
    if (first.item.type !== "command_execution") throw new Error("Expected command fixture");
    rows[0] = {
      ...first,
      item: {
        ...first.item,
        type: "user_message",
        messageId: MessageId.make("user"),
        createdBy: "user",
        creationSource: "web",
        inputIntent: "turn_start",
        text: "Run",
        attachments: [],
      },
    };
    const window = selectRecentTimelineWindow({ items: rows, snapshotSequence: 1 });
    expect(window.items.length).toBeLessThan(200);
    expect(
      window.items.reduce((sum, row) => sum + projectedRowEncodedBytes(row), 0),
    ).toBeLessThanOrEqual(THREAD_HISTORY_PAGE_POLICY.maxEncodedBytes);
    const projection = makeProjection(rows);
    const full = {
      ...projection,
      runs: [
        {
          ...projection.runs[0]!,
          id: RunId.make("latest"),
          ordinal: 1,
          userMessageId: MessageId.make("user"),
          status: "completed" as const,
        },
      ],
      messages: Array.from({ length: 2_000 }, (_, index) => ({
        id: MessageId.make(`hidden-${index}`),
        threadId: THREAD,
        runId: RunId.make("latest"),
        nodeId: null,
        role: "assistant" as const,
        text: "x".repeat(1_000),
        attachments: [],
        streaming: false,
        createdBy: "agent" as const,
        creationSource: "provider" as const,
        createdAt: NOW,
        updatedAt: NOW,
      })),
    };
    const bounded = buildBoundedThreadProjection({ projection: full, snapshotSequence: 1 });
    expect(bounded.projection.messages.map((message) => message.id)).toEqual(["hidden-1999"]);
    expect(Buffer.byteLength(JSON.stringify(bounded.projection))).toBeLessThanOrEqual(1_048_576);
  });

  it("counts duplicated assistant messages in the final snapshot and keeps a recoverable cursor", () => {
    const rows = Array.from({ length: 200 }, (_, i) => {
      const row = makeRow(i);
      if (row.item.type !== "command_execution") throw new Error("Expected command fixture");
      return {
        ...row,
        item: {
          ...row.item,
          type: "assistant_message" as const,
          messageId: MessageId.make(`assistant-${i}`),
          text: "x".repeat(10_000),
          streaming: false,
        },
      };
    });
    const projection = makeProjection(rows);
    const messages = rows.map(({ item }) => ({
      id: item.messageId,
      threadId: THREAD,
      runId: null,
      nodeId: null,
      role: "assistant" as const,
      text: item.text,
      attachments: [],
      streaming: false,
      createdBy: "agent" as const,
      creationSource: "provider" as const,
      createdAt: NOW,
      updatedAt: NOW,
    }));
    const full = { ...projection, messages };
    const snapshot = buildBoundedThreadStreamSnapshot({ projection: full, snapshotSequence: 1 });
    expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThanOrEqual(1_048_576);
    expect(Buffer.byteLength(JSON.stringify(snapshot.projection))).toBeLessThanOrEqual(1_048_576);
    const earlier = selectHistoryPageFromCursor({
      items: full.visibleTurnItems,
      cursor: snapshot.historyCursor!,
      snapshotSequence: 1,
    });
    expect(earlier.items.at(-1)?.sourceItemId).toBe(
      `item-${200 - snapshot.projection.visibleTurnItems.length - 1}`,
    );
    expect(snapshot.projection.messages).toHaveLength(snapshot.projection.visibleTurnItems.length);
  });

  it("pages complete notification-started runs at the item ceiling", () => {
    const inRun = (index: number, run: number, item: object = {}) => {
      const row = makeRow(index);
      return {
        ...row,
        item: { ...row.item, runId: RunId.make(`run-${run}`), ...item },
      } as OrchestrationV2ProjectedTurnItem;
    };
    const notification = (summary: string) => ({
      type: "notification",
      source: { kind: "monitor" },
      outcome: "completed",
      summary,
    });
    const items = Array.from({ length: 161 }, (_, run) => [
      inRun(run * 4, run),
      inRun(
        run * 4 + 1,
        run,
        run === 0
          ? {
              type: "user_message",
              createdBy: "user",
              creationSource: "web",
              inputIntent: "turn_start",
              messageId: MessageId.make("prompt-0"),
              text: "Prompt 0",
              attachments: [],
            }
          : notification(`Wake ${run}`),
      ),
      inRun(run * 4 + 2, run, notification(`Steer ${run}`)),
      inRun(run * 4 + 3, run),
    ]).flat();
    const policy = {
      ...THREAD_HISTORY_PAGE_POLICY,
      maxItems: 1_000,
      maxTurnItems: 1_000,
      maxEncodedBytes: 10_000_000,
    };
    const first = selectRecentTimelineWindow({ items, snapshotSequence: 1, policy });
    expect(first.items).toHaveLength(150 * 4 - 1);
    expect(first.items[0]?.sourceItemId).toBe(`item-${11 * 4 + 1}`);
    const older = selectHistoryPageFromCursor({
      items,
      cursor: first.nextCursor!,
      snapshotSequence: 1,
      policy,
    });
    expect([...older.items, ...first.items].map((row) => row.sourceItemId)).toEqual(
      items.map((row) => row.sourceItemId),
    );
  });

  it("pages agent-only child transcripts instead of dropping their earlier activity", () => {
    const commandRows = Array.from({ length: 300 }, (_, index) => makeRow(index + 1));
    const first = makeRow(0);
    const prompt = {
      ...first,
      item: {
        ...first.item,
        type: "user_message" as const,
        createdBy: "agent" as const,
        creationSource: "provider" as const,
        inputIntent: "turn_start" as const,
        messageId: MessageId.make("child-prompt"),
        text: "Inspect this project",
        attachments: [],
      },
    } as OrchestrationV2ProjectedTurnItem;
    const items = [prompt, ...commandRows];
    const recent = selectRecentTimelineWindow({ items, snapshotSequence: 1 });

    expect(recent.items).toHaveLength(THREAD_HISTORY_PAGE_POLICY.maxItems);
    expect(recent.hasMoreHistory).toBe(true);
    const loaded = [...recent.items];
    let cursor = recent.nextCursor;
    while (cursor !== null) {
      const older = selectHistoryPageFromCursor({ items, cursor, snapshotSequence: 1 });
      loaded.unshift(...older.items);
      cursor = older.nextCursor;
    }
    expect(loaded[0]?.item.type).toBe("user_message");
    expect(loaded.map((row) => row.sourceItemId)).toEqual(items.map((row) => row.sourceItemId));
  });

  it("always includes at least one pathological oversized item", () => {
    for (const humanTurn of [false, true]) {
      const oversized = makeRow(0, { outputBytes: 2_000_000 });
      const items = [
        humanTurn
          ? ({
              ...oversized,
              item: {
                ...oversized.item,
                type: "user_message",
                createdBy: "user",
                creationSource: "web",
                inputIntent: "turn_start",
                messageId: MessageId.make("oversized-human-turn"),
                text: "x".repeat(2_000_000),
                attachments: [],
              },
            } as OrchestrationV2ProjectedTurnItem)
          : oversized,
        makeRow(1, { outputBytes: 10 }),
      ];
      const policy = { ...THREAD_HISTORY_PAGE_POLICY, maxItems: 50, maxEncodedBytes: 1_024 };
      const page = selectRecentTimelineWindow({ items, snapshotSequence: 1, policy });
      expect(page.items).toHaveLength(1);
      expect(page.items[0]?.sourceItemId).toBe("item-1");
      expect(page.hasMoreHistory).toBe(true);

      const older = selectHistoryPageFromCursor({
        items,
        cursor: page.nextCursor!,
        snapshotSequence: 1,
        policy,
      });
      expect(older.items).toHaveLength(1);
      expect(older.items[0]?.sourceItemId).toBe("item-0");
      expect(older.hasMoreHistory).toBe(false);
      expect(older.nextCursor).toBeNull();
      expect([...older.items, ...page.items].map((row) => row.sourceItemId)).toEqual(
        items.map((row) => row.sourceItemId),
      );
    }
  });

  it("recovers identity-miss cursors when position is past a shrunken timeline", () => {
    const items = Array.from({ length: 5 }, (_, index) => makeRow(index));
    const cursor = encodeThreadHistoryCursor({
      snapshotSequence: 3,
      sourceThreadId: THREAD,
      sourceItemId: TurnItemId.make("item-deleted-long-ago"),
      position: 40,
    });
    const page = selectHistoryPageFromCursor({
      items,
      cursor,
      snapshotSequence: 3,
      policy: { maxItems: 2, maxEncodedBytes: 10_000_000 },
    });
    expect(page.items.map((row) => row.sourceItemId)).toEqual(["item-3", "item-4"]);
    expect(page.hasMoreHistory).toBe(true);
    expect(page.nextCursor).not.toBeNull();
  });

  it("keeps cursor resolution stable when newer items append", () => {
    const initial = Array.from({ length: 20 }, (_, index) => makeRow(index));
    const recent = selectRecentTimelineWindow({
      items: initial,
      snapshotSequence: 2,
      policy: { maxItems: 5, maxEncodedBytes: 10_000_000 },
    });
    const cursor = recent.nextCursor!;
    const grown = [...initial, makeRow(20), makeRow(21)];
    const older = selectHistoryPageFromCursor({
      items: grown,
      cursor,
      snapshotSequence: 5,
      policy: { maxItems: 5, maxEncodedBytes: 10_000_000 },
    });
    expect(older.items.map((row) => row.sourceItemId)).toEqual([
      "item-10",
      "item-11",
      "item-12",
      "item-13",
      "item-14",
    ]);
    expect(older.hasMoreHistory).toBe(true);
  });

  it("builds a bounded projection that preserves non-timeline control state", () => {
    const full = makeProjection(Array.from({ length: 40 }, (_, index) => makeRow(index)));
    const bounded = buildBoundedThreadProjection({
      projection: full,
      snapshotSequence: 7,
      policy: { maxItems: 5, maxEncodedBytes: 10_000_000 },
    });
    expect(bounded.projection.runs).toEqual(full.runs);
    expect(bounded.projection.runtimeRequests).toEqual(full.runtimeRequests);
    expect(bounded.projection.attempts).toEqual(full.attempts);
    expect(bounded.projection.visibleTurnItems).toHaveLength(5);
    expect(bounded.projection.turnItems).toHaveLength(5);
    expect(bounded.hasMoreHistory).toBe(true);
    expect(bounded.historyCursor).not.toBeNull();
    expect(bounded.projection.visibleTurnItems.map((row) => row.position)).toEqual([0, 1, 2, 3, 4]);
    expect(bounded.latestLocalTurnOrdinal).toBe(40);
    expect(computeLatestLocalTurnOrdinal(full.turnItems)).toBe(40);
  });

  it("carries a full-projection watermark when the bounded window is inherited-only", () => {
    const localOlder = makeRow(0);
    const localMid = makeRow(1);
    const inherited = {
      ...makeRow(2),
      visibility: "inherited" as const,
      sourceThreadId: ThreadId.make("parent-thread"),
      item: {
        ...makeRow(2).item,
        threadId: ThreadId.make("parent-thread"),
      },
    };
    const full = makeProjection([localOlder, localMid, inherited]);
    const inheritedOnly = {
      ...full,
      visibleTurnItems: [inherited],
      turnItems: [localOlder.item, localMid.item],
    };
    const bounded = buildBoundedThreadProjection({
      projection: inheritedOnly,
      snapshotSequence: 2,
      policy: { maxItems: 1, maxEncodedBytes: 10_000_000 },
    });
    expect(bounded.projection.visibleTurnItems.map((row) => String(row.sourceItemId))).toEqual([
      String(inherited.sourceItemId),
    ]);
    expect(bounded.latestLocalTurnOrdinal).toBe(2);
    expect(computeLatestLocalTurnOrdinal([])).toBeNull();
  });

  it("retains an out-of-window run_interrupt_request needed by a visible result", () => {
    const request = interruptRow(0, "run_interrupt_request");
    const filler = makeRow(1);
    const result = interruptRow(2, "run_interrupt_result");
    const full = makeProjection([request, filler, result]);
    const bounded = buildBoundedThreadProjection({
      projection: full,
      snapshotSequence: 3,
      policy: { maxItems: 1, maxEncodedBytes: 10_000_000 },
    });

    expect(bounded.projection.visibleTurnItems.map((row) => String(row.sourceItemId))).toEqual([
      "interrupt-res",
    ]);
    expect(bounded.projection.turnItems.map((item) => String(item.id)).sort()).toEqual([
      "interrupt-req",
      "interrupt-res",
    ]);
    expect(bounded.hasMoreHistory).toBe(true);
  });

  it("charges local row.item duplication when measuring bounded timeline bytes", () => {
    const rows = Array.from({ length: 8 }, (_, index) => makeRow(index, { outputBytes: 2_000 }));
    const full = makeProjection(rows);
    const maxEncodedBytes = 12_000;
    const bounded = buildBoundedThreadProjection({
      projection: full,
      snapshotSequence: 1,
      policy: { maxItems: 50, maxEncodedBytes },
    });

    const contribution = boundedTimelineEncodedBytes({
      visibleTurnItems: bounded.projection.visibleTurnItems,
      turnItems: bounded.projection.turnItems,
    });
    expect(contribution).toBeLessThanOrEqual(maxEncodedBytes);
    expect(bounded.projection.visibleTurnItems.length).toBeGreaterThan(0);
    expect(bounded.projection.visibleTurnItems.length).toBeLessThan(rows.length);

    const historyPage = selectRecentTimelineWindow({
      items: rows,
      snapshotSequence: 1,
      policy: { maxItems: 50, maxEncodedBytes },
    });
    const historyBytes = historyPage.items.reduce(
      (sum, row) => sum + projectedRowEncodedBytes(row),
      0,
    );
    expect(historyBytes).toBeLessThanOrEqual(maxEncodedBytes);
    expect(historyPage.items.length).toBeGreaterThan(bounded.projection.visibleTurnItems.length);

    const sample = rows[0]!;
    expect(projectedRowBoundedSnapshotEncodedBytes(sample, THREAD)).toBeGreaterThan(
      projectedRowEncodedBytes(sample),
    );
  });

  it("does not carry the full duplicated message table into a bounded snapshot", () => {
    const projection = makeProjection(Array.from({ length: 120 }, (_, index) => makeRow(index)));
    const full = {
      ...projection,
      messages: Array.from({ length: 2_000 }, (_, index) => ({
        id: MessageId.make(`message-${index}`),
        threadId: THREAD,
        runId: RunId.make(`old-run-${index}`),
        nodeId: null,
        role: "assistant" as const,
        text: "x".repeat(1_000),
        attachments: [],
        streaming: false,
        createdBy: "agent" as const,
        creationSource: "provider" as const,
        createdAt: NOW,
        updatedAt: NOW,
      })),
    } as typeof projection;

    const bounded = buildBoundedThreadProjection({
      projection: full,
      snapshotSequence: 9,
    });

    expect(bounded.projection.messages).toEqual([]);
    expect(Buffer.byteLength(JSON.stringify(bounded.projection), "utf8")).toBeLessThan(
      THREAD_HISTORY_PAGE_POLICY.maxEncodedBytes + 100_000,
    );
  });

  it("keeps a workflow coordinator's script outside the bounded window", () => {
    const projection = makeProjection(Array.from({ length: 120 }, (_, index) => makeRow(index)));
    const message = (index: number, workflowScript?: boolean) => ({
      id: MessageId.make(`message-${index}`),
      threadId: THREAD,
      runId: RunId.make(`old-run-${index}`),
      nodeId: null,
      role: "user" as const,
      text: `message ${index}`,
      attachments: [],
      streaming: false,
      createdBy: "agent" as const,
      creationSource: "provider" as const,
      createdAt: NOW,
      updatedAt: NOW,
      ...(workflowScript === undefined ? {} : { workflowScript }),
    });
    const full = {
      ...projection,
      messages: [message(0, true), message(1, false), message(2)],
    } as typeof projection;

    const bounded = buildBoundedThreadProjection({ projection: full, snapshotSequence: 9 });

    expect(bounded.projection.messages.map((retained) => retained.id)).toEqual([
      MessageId.make("message-0"),
    ]);
  });

  it("omits historical control details that remain available from history items", () => {
    const projection = makeProjection(Array.from({ length: 200 }, (_, index) => makeRow(index)));
    const populated = {
      ...projection,
      plans: Array.from({ length: 120 }, (_, index) => ({
        id: `plan-${index}`,
        threadId: THREAD,
        runId: null,
        nodeId: `node-${index}`,
        status: "completed",
        kind: "proposed_plan",
        markdown: "p".repeat(2_097_152),
      })),
      contextHandoffs: Array.from({ length: 120 }, (_, index) => ({
        id: `handoff-${index}`,
        threadId: THREAD,
        targetRunId: "run-1",
        fromProviderThreadIds: [],
        toProviderThreadId: "provider-thread-1",
        coveredRunOrdinals: { from: 1, to: 1 },
        strategy: "manual_context",
        status: "superseded",
        summaryMessageId: null,
        summaryText: "h".repeat(2_097_152),
        createdByProviderInstanceId: null,
        createdAt: NOW,
        updatedAt: NOW,
      })),
    } as unknown as typeof projection;

    const bounded = buildBoundedThreadProjection({
      projection: projectThreadProjectionForWire(populated),
      snapshotSequence: 9,
    });
    const serializedBytes = Buffer.byteLength(JSON.stringify(bounded.projection), "utf8");

    expect(serializedBytes).toBeLessThanOrEqual(THREAD_HISTORY_PAGE_POLICY.maxEncodedBytes);
    expect(bounded.projection.plans).toEqual([]);
    expect(bounded.projection.contextHandoffs).toEqual([]);
    expect(populated.plans).toHaveLength(120);
    expect(
      populated.plans[0]?.kind === "proposed_plan" ? populated.plans[0].markdown.length : 0,
    ).toBe(2_097_152);
  });

  it("preserves oversized actionable state", () => {
    const projection = makeProjection([makeRow(0)]);
    const actionable = {
      ...projection,
      plans: [
        {
          id: "plan-actionable",
          threadId: THREAD,
          runId: null,
          nodeId: "node-actionable",
          status: "active",
          kind: "proposed_plan",
          markdown: "a".repeat(2_097_152),
        },
      ],
    } as unknown as typeof projection;

    const bounded = buildBoundedThreadProjection({ projection: actionable, snapshotSequence: 9 });

    expect(bounded.projection.plans[0]).toEqual(actionable.plans[0]);
    expect(bounded.projection.visibleTurnItems).toEqual(actionable.visibleTurnItems);
  });

  it("keeps agent-only turns visible when checkpoint file lists fill the byte budget", () => {
    const items = Array.from({ length: 3 }, (_, turn) => {
      const first = makeRow(turn * 5);
      const prompt = {
        ...first,
        item: {
          ...first.item,
          type: "user_message" as const,
          createdBy: "agent" as const,
          creationSource: "provider" as const,
          inputIntent: "turn_start" as const,
          messageId: MessageId.make(`agent-prompt-${turn}`),
          text: `Step ${turn}`,
          attachments: [],
        },
      } as OrchestrationV2ProjectedTurnItem;
      return [prompt, ...Array.from({ length: 4 }, (_, index) => makeRow(turn * 5 + index + 1))];
    }).flat();
    const files = Array.from(
      { length: 15_000 },
      (_, index) =>
        `work/ws-${index % 40}/.jj/repo/store/extra/${index.toString(16).padStart(40, "0")}`,
    );
    const projection = {
      ...makeProjection(items),
      nodes: [
        {
          id: NODE,
          status: "waiting",
          parentNodeId: null,
          rootNodeId: NODE,
          checkpointScopeId: "scope-1",
        },
      ],
      checkpointScopes: [{ id: "scope-1", nodeId: NODE, parentScopeId: null }],
      checkpoints: [{ id: "checkpoint-1", scopeId: "scope-1", files }],
    } as unknown as ReturnType<typeof makeProjection>;

    const bounded = buildBoundedThreadProjection({ projection, snapshotSequence: 1 });

    expect(bounded.projection.visibleTurnItems).toHaveLength(items.length);
    expect(bounded.hasMoreHistory).toBe(false);
  });

  it("retains the latest completed task list outside the visible history window", () => {
    const projection = makeProjection(Array.from({ length: 120 }, (_, index) => makeRow(index)));
    const taskList = (ordinal: number) => ({
      id: `task-list-${ordinal}`,
      threadId: THREAD,
      runId: `run-${ordinal}`,
      nodeId: NODE,
      kind: "todo_list",
      status: "completed",
      steps: [{ step: `Task ${ordinal}`, status: "completed" }],
    });
    const latest = taskList(2);
    const full = {
      ...projection,
      runs: [
        { id: "run-1", ordinal: 1 },
        { id: "run-2", ordinal: 2 },
      ],
      plans: [taskList(1), latest],
    } as unknown as typeof projection;

    const bounded = buildBoundedThreadProjection({ projection: full, snapshotSequence: 1 });

    expect(bounded.hasMoreHistory).toBe(true);
    expect(bounded.projection.plans).toEqual([latest]);
  });

  it("keeps paged historical plan detail in the turn item and only status in its artifact", () => {
    const detail = "Implement the historical plan exactly.\n".repeat(1_000);
    const item = {
      ...makeRow(0).item,
      type: "proposed_plan",
      planId: "plan-historical-visible",
      markdown: detail,
      streaming: false,
    } as OrchestrationV2TurnItem;
    const row = {
      ...makeRow(0),
      sourceItemId: item.id,
      item,
    } as OrchestrationV2ProjectedTurnItem;
    const base = makeProjection([row]);
    const projection = {
      ...base,
      plans: [
        {
          id: "plan-historical-visible",
          threadId: THREAD,
          runId: null,
          nodeId: "node-historical-visible",
          status: "completed",
          kind: "proposed_plan",
          markdown: detail,
        },
      ],
    } as unknown as typeof base;

    const bounded = buildBoundedThreadProjection({ projection, snapshotSequence: 9 });

    expect(bounded.projection.visibleTurnItems[0]?.item).toMatchObject({
      type: "proposed_plan",
      markdown: detail,
    });
    expect(bounded.projection.plans[0]).toMatchObject({
      status: "completed",
      markdown: "",
      detailInTurnItem: true,
    });
  });
});
