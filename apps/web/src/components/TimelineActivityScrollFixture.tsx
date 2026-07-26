import {
  EnvironmentId,
  EventId,
  MessageId,
  TurnId,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { type LegendListRef } from "@legendapp/list/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { deriveTimelineEntries, deriveWorkLogEntries } from "../session-logic";
import type { ChatMessage, TurnDiffSummary } from "../types";
import { deriveWorkflowActivityModels } from "../workflow-activity";
import { WorkflowActivityCard, type WorkflowActivityCardViewState } from "./WorkflowActivityCard";
import { MessagesTimeline, updateWorkflowActivityViewState } from "./chat/MessagesTimeline";

/**
 * Reproduction harness for the pinned-activity scroll feedback loop.
 *
 * ChatView pins one workflow activity card above the composer, picks which
 * card that is from the timeline's scroll offset, and folds the card's
 * measured height into the list's bottom content inset. That closes a loop:
 * scroll -> selected card -> card height -> list geometry -> scroll. This
 * fixture wires the same three edges with checked-in data and counts every
 * traversal so a browser step can tell a settled surface from an oscillating
 * one.
 */

const FIXTURE_ENVIRONMENT_ID = EnvironmentId.make("timeline-activity-scroll-fixture");
const FIXTURE_THREAD_ID = "timeline-activity-scroll";
const FIXTURE_COMPOSER_HEIGHT_PX = 128;
const EMPTY_TURN_DIFFS = new Map<MessageId, TurnDiffSummary>();
const EMPTY_REVERT_COUNTS = new Map<MessageId, number>();
const EMPTY_VIEW_STATES: ReadonlyMap<TurnId, WorkflowActivityCardViewState> = new Map();

interface FixtureCycleSpec {
  readonly index: number;
  readonly hasActivity: boolean;
  readonly workerCount: number;
}

const FIXTURE_CYCLES: ReadonlyArray<FixtureCycleSpec> = [
  { index: 1, hasActivity: true, workerCount: 3 },
  { index: 2, hasActivity: true, workerCount: 1 },
  { index: 3, hasActivity: false, workerCount: 0 },
  { index: 4, hasActivity: true, workerCount: 2 },
  { index: 5, hasActivity: false, workerCount: 0 },
  { index: 6, hasActivity: true, workerCount: 4 },
];
const FIXTURE_MESSAGES_PER_CYCLE = 5;

function fixtureTimestamp(tick: number): string {
  return new Date(Date.UTC(2042, 0, 1, 12, 0, 0) + tick * 1_000).toISOString();
}

function fixtureTurnId(cycleIndex: number): TurnId {
  return TurnId.make(`timeline-activity-scroll-turn-${cycleIndex}`);
}

interface FixtureThread {
  readonly messages: ReadonlyArray<ChatMessage>;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
}

function buildFixtureThread(): FixtureThread {
  const messages: ChatMessage[] = [];
  const activities: OrchestrationThreadActivity[] = [];
  let tick = 1;

  for (const cycle of FIXTURE_CYCLES) {
    const turnId = fixtureTurnId(cycle.index);
    const userCreatedAt = fixtureTimestamp(tick);
    messages.push({
      id: MessageId.make(`timeline-activity-scroll-user-${cycle.index}`),
      role: "user",
      text: `Cycle ${cycle.index}: deterministic request that opens a new message cycle.`,
      turnId: null,
      streaming: false,
      createdAt: userCreatedAt,
      updatedAt: userCreatedAt,
    });
    tick += 1;

    if (cycle.hasActivity) {
      activities.push({
        id: EventId.make(`timeline-activity-scroll-plan-${cycle.index}`),
        kind: "turn.plan.updated",
        summary: "Plan updated",
        tone: "info",
        payload: {
          explanation: `Deterministic plan for cycle ${cycle.index}.`,
          plan: [
            { step: `Cycle ${cycle.index} step 1`, status: "completed" },
            { step: `Cycle ${cycle.index} step 2`, status: "inProgress" },
            { step: `Cycle ${cycle.index} step 3`, status: "pending" },
          ],
        },
        turnId,
        sequence: tick,
        createdAt: fixtureTimestamp(tick),
      });
      tick += 1;
    }

    for (let workerIndex = 0; workerIndex < cycle.workerCount; workerIndex += 1) {
      const taskId = `timeline-activity-scroll-task-${cycle.index}-${workerIndex + 1}`;
      activities.push({
        id: EventId.make(`${taskId}-started`),
        kind: "task.started",
        summary: "Task started",
        tone: "tool",
        payload: {
          taskId,
          toolUseId: `${taskId}-tool-use`,
          description: `Cycle ${cycle.index} worker ${workerIndex + 1}`,
          taskType: "agent",
          subagentType: workerIndex % 2 === 0 ? "explorer" : "reviewer",
          workflowName: "timeline-activity-scroll-fixture",
          prompt: `Synthetic prompt for cycle ${cycle.index} worker ${workerIndex + 1}.`,
        },
        turnId,
        sequence: tick,
        createdAt: fixtureTimestamp(tick),
      });
      tick += 1;
      activities.push({
        id: EventId.make(`${taskId}-completed`),
        kind: "task.completed",
        summary: "Task completed",
        tone: "tool",
        payload: {
          taskId,
          status: "completed",
          summary: `Cycle ${cycle.index} worker ${workerIndex + 1} finished.`,
          outputFile: `fixture-output/${taskId}.md`,
          usage: { totalTokens: 2_400, toolUses: 7, durationMs: 61_000 },
        },
        turnId,
        sequence: tick,
        createdAt: fixtureTimestamp(tick),
      });
      tick += 1;
    }

    for (let messageIndex = 0; messageIndex < FIXTURE_MESSAGES_PER_CYCLE; messageIndex += 1) {
      const createdAt = fixtureTimestamp(tick);
      messages.push({
        id: MessageId.make(`timeline-activity-scroll-assistant-${cycle.index}-${messageIndex + 1}`),
        role: "assistant",
        text: `Cycle ${cycle.index} response ${messageIndex + 1}. ${"Deterministic transcript filler that makes every cycle taller than a single wheel notch so cycle boundaries are crossed while scrolling. ".repeat(
          4,
        )}`,
        turnId,
        streaming: false,
        createdAt,
        updatedAt: createdAt,
      });
      tick += 1;
    }
  }

  return { messages, activities };
}

interface FixtureTelemetry {
  readonly selectionEvents: number;
  readonly selectionTrail: ReadonlyArray<string>;
  readonly heightEvents: number;
  readonly heightTrail: ReadonlyArray<number>;
  readonly scrollEvents: number;
}

const EMPTY_TELEMETRY: FixtureTelemetry = {
  selectionEvents: 0,
  selectionTrail: [],
  heightEvents: 0,
  heightTrail: [],
  scrollEvents: 0,
};

export function TimelineActivityScrollFixture() {
  const thread = useMemo(buildFixtureThread, []);
  const listRef = useRef<LegendListRef | null>(null);
  const positionedAnchorRef = useRef<MessageId | null>(null);

  const workEntries = useMemo(() => deriveWorkLogEntries(thread.activities), [thread.activities]);
  const timelineEntries = useMemo(
    () => deriveTimelineEntries(thread.messages, [], workEntries),
    [thread.messages, workEntries],
  );
  const workflowActivityModelsByTurnId = useMemo(
    () => deriveWorkflowActivityModels(thread.activities),
    [thread.activities],
  );
  const latestTurn = useMemo(
    () => ({
      turnId: fixtureTurnId(FIXTURE_CYCLES[FIXTURE_CYCLES.length - 1]?.index ?? 1),
      state: "completed" as const,
      startedAt: fixtureTimestamp(1),
      completedAt: fixtureTimestamp(500),
    }),
    [],
  );
  const anchorMessageId = useMemo(
    () => [...thread.messages].toReversed().find((message) => message.role === "user")?.id ?? null,
    [thread.messages],
  );

  // ChatView mirror: the pinned turn is whatever the timeline last reported for
  // the scroll position, falling back to the latest turn that has activity.
  const [scrollContextTurnId, setScrollContextTurnId] = useState<TurnId | null | undefined>(
    undefined,
  );
  const [viewStateByTurnId, setViewStateByTurnId] =
    useState<ReadonlyMap<TurnId, WorkflowActivityCardViewState>>(EMPTY_VIEW_STATES);
  const [activityOverlayHeight, setActivityOverlayHeight] = useState(0);
  // Stands in for the composer overlay growing when an approval or user-input
  // card mounts above the prompt.
  const [composerHeight, setComposerHeight] = useState(FIXTURE_COMPOSER_HEIGHT_PX);
  // A thread opened from the sidebar has no anchored end space, so LegendList
  // falls back to maintainScrollAtEnd. Both modes must survive an inset change.
  const [anchorEnabled, setAnchorEnabled] = useState(true);
  const [overlayWheelHost, setOverlayWheelHost] = useState<HTMLDivElement | null>(null);
  const [telemetry, setTelemetry] = useState<FixtureTelemetry>(EMPTY_TELEMETRY);
  const [isAtEnd, setIsAtEnd] = useState(true);

  const initialTurnId = workflowActivityModelsByTurnId.has(latestTurn.turnId)
    ? latestTurn.turnId
    : null;
  const pinnedTurnId = scrollContextTurnId === undefined ? initialTurnId : scrollContextTurnId;
  const workflowActivityModel =
    pinnedTurnId === null ? null : (workflowActivityModelsByTurnId.get(pinnedTurnId) ?? null);
  const workflowActivityViewState =
    workflowActivityModel === null
      ? null
      : (viewStateByTurnId.get(workflowActivityModel.turnId) ?? "collapsed");
  const visibleWorkflowActivityModel =
    workflowActivityViewState === "closed" ? null : workflowActivityModel;
  const timelineBottomOverlayHeight = composerHeight + activityOverlayHeight;

  const handleActiveWorkflowTurnIdChange = useCallback((turnId: TurnId | null) => {
    setScrollContextTurnId((current) => (current === turnId ? current : turnId));
    setTelemetry((current) => ({
      ...current,
      selectionEvents: current.selectionEvents + 1,
      selectionTrail: [...current.selectionTrail, turnId ?? "none"].slice(-24),
    }));
  }, []);

  const handleWorkflowCardHeightChange = useCallback((nextHeight: number) => {
    const measured = Number.isFinite(nextHeight) ? Math.max(0, Math.ceil(nextHeight)) : 0;
    setActivityOverlayHeight((current) => (current === measured ? current : measured));
    setTelemetry((current) => ({
      ...current,
      heightEvents: current.heightEvents + 1,
      heightTrail: [...current.heightTrail, measured].slice(-24),
    }));
  }, []);

  useEffect(() => {
    if (visibleWorkflowActivityModel === null) {
      handleWorkflowCardHeightChange(0);
    }
  }, [handleWorkflowCardHeightChange, visibleWorkflowActivityModel]);

  const handleViewStateChange = useCallback(
    (turnId: TurnId, state: WorkflowActivityCardViewState) => {
      setViewStateByTurnId((current) => updateWorkflowActivityViewState(current, turnId, state));
    },
    [],
  );

  const onAnchorReady = useCallback((messageId: MessageId, anchorIndex: number) => {
    if (positionedAnchorRef.current === messageId) {
      return;
    }
    positionedAnchorRef.current = messageId;
    requestAnimationFrame(() => {
      void listRef.current?.scrollToIndex({
        index: anchorIndex,
        animated: false,
        viewPosition: 0,
        viewOffset: 16,
      });
    });
  }, []);

  const onIsAtEndChange = useCallback((nextIsAtEnd: boolean) => {
    setIsAtEnd(nextIsAtEnd);
  }, []);

  const handleScrollSample = useCallback(() => {
    setTelemetry((current) => ({ ...current, scrollEvents: current.scrollEvents + 1 }));
  }, []);

  useEffect(() => {
    const scrollNode = listRef.current?.getScrollableNode();
    if (!scrollNode) {
      return;
    }
    scrollNode.addEventListener("scroll", handleScrollSample, { passive: true });
    return () => scrollNode.removeEventListener("scroll", handleScrollSample);
  }, [handleScrollSample]);

  const resetTelemetry = useCallback(() => {
    setTelemetry(EMPTY_TELEMETRY);
  }, []);

  const nudgeScroll = useCallback((delta: number) => {
    const list = listRef.current;
    const state = list?.getState?.();
    if (!list || !state) {
      return;
    }
    void list.scrollToOffset({ offset: Math.max(0, state.scroll + delta), animated: false });
  }, []);

  // Browser steps read the harness through the DOM instead of React internals.
  useEffect(() => {
    const globalScope = window as unknown as Record<string, unknown>;
    globalScope.__timelineActivityScrollFixture = {
      telemetry,
      pinnedTurnId,
      activityOverlayHeight,
      timelineBottomOverlayHeight,
      isAtEnd,
      reset: resetTelemetry,
      nudge: nudgeScroll,
      scroll: () => listRef.current?.getState?.()?.scroll ?? null,
      state: () => {
        const state = listRef.current?.getState?.();
        return state
          ? {
              scroll: Math.round(state.scroll),
              scrollLength: Math.round(state.scrollLength),
              contentLength: Math.round(state.contentLength),
              isAtEnd: state.isAtEnd,
              isNearEnd: state.isNearEnd,
            }
          : null;
      },
      expandPinned: () => {
        if (pinnedTurnId !== null) {
          handleViewStateChange(pinnedTurnId, "expanded");
        }
      },
      setComposerHeight,
      setAnchorEnabled,
    };
  }, [
    activityOverlayHeight,
    anchorEnabled,
    composerHeight,
    handleViewStateChange,
    isAtEnd,
    nudgeScroll,
    pinnedTurnId,
    resetTelemetry,
    telemetry,
    timelineBottomOverlayHeight,
  ]);

  return (
    <div className="flex h-screen min-h-0 w-full flex-col bg-background text-foreground">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2 text-xs">
        <span className="font-medium">Timeline activity scroll harness</span>
        <button
          type="button"
          className="rounded-md border border-border/70 px-2 py-1"
          data-testid="fixture-reset"
          onClick={resetTelemetry}
        >
          Reset counters
        </button>
        <button
          type="button"
          className="rounded-md border border-border/70 px-2 py-1"
          data-testid="fixture-scroll-up"
          onClick={() => nudgeScroll(-160)}
        >
          Scroll up 160px
        </button>
        <span data-testid="fixture-pinned-turn">pinned: {pinnedTurnId ?? "none"}</span>
        <span data-testid="fixture-selection-events">selections: {telemetry.selectionEvents}</span>
        <span data-testid="fixture-height-events">heights: {telemetry.heightEvents}</span>
        <span data-testid="fixture-scroll-events">scrolls: {telemetry.scrollEvents}</span>
        <span data-testid="fixture-inset">inset: {timelineBottomOverlayHeight}</span>
        <span data-testid="fixture-selection-trail">
          trail: {telemetry.selectionTrail.join(" > ") || "-"}
        </span>
      </div>

      {/* ChatView mirror: chat column -> messages wrapper -> overlays. */}
      <div
        ref={setOverlayWheelHost}
        className="relative flex min-h-0 min-w-0 flex-1 flex-col"
        data-chat-column="true"
      >
        <div className="relative flex min-h-0 flex-1 flex-col">
          <MessagesTimeline
            isWorking={false}
            activeTurnInProgress={false}
            activeTurnStartedAt={null}
            listRef={listRef}
            timelineEntries={timelineEntries}
            latestTurn={latestTurn}
            runningTurnId={null}
            workflowActivityModelsByTurnId={workflowActivityModelsByTurnId}
            workflowActivityViewStateByTurnId={viewStateByTurnId}
            onWorkflowActivityViewStateChange={handleViewStateChange}
            onActiveWorkflowTurnIdChange={handleActiveWorkflowTurnIdChange}
            turnDiffSummaryByAssistantMessageId={EMPTY_TURN_DIFFS}
            routeThreadKey={`${FIXTURE_ENVIRONMENT_ID}:${FIXTURE_THREAD_ID}`}
            onOpenTurnDiff={() => undefined}
            revertTurnCountByUserMessageId={EMPTY_REVERT_COUNTS}
            onRevertUserMessage={() => undefined}
            isRevertingCheckpoint={false}
            onImageExpand={() => undefined}
            activeThreadEnvironmentId={FIXTURE_ENVIRONMENT_ID}
            markdownCwd={undefined}
            resolvedTheme="dark"
            timestampFormat="24-hour"
            workspaceRoot={undefined}
            anchorMessageId={anchorEnabled ? anchorMessageId : null}
            onAnchorReady={onAnchorReady}
            onAnchorSizeChanged={() => undefined}
            contentInsetEndAdjustment={timelineBottomOverlayHeight}
            overlayWheelHost={overlayWheelHost}
            onIsAtEndChange={onIsAtEndChange}
            onManualNavigation={() => undefined}
          />

          {visibleWorkflowActivityModel !== null && workflowActivityViewState !== null ? (
            <div
              className="pointer-events-none absolute inset-x-0 z-30"
              style={{ bottom: composerHeight }}
              data-workflow-activity-overlay="true"
            >
              <WorkflowActivityCard
                key={visibleWorkflowActivityModel.turnId}
                model={visibleWorkflowActivityModel}
                viewState={workflowActivityViewState}
                pinnedMaxHeight={240}
                onViewStateChange={(state) =>
                  handleViewStateChange(visibleWorkflowActivityModel.turnId, state)
                }
                onHeightChange={handleWorkflowCardHeightChange}
              />
            </div>
          ) : null}
        </div>

        <div
          className="pointer-events-none absolute inset-x-0 bottom-0 z-20"
          data-chat-composer-overlay="true"
          style={{ height: composerHeight }}
        >
          <div className="pointer-events-auto mx-auto mb-3 h-full w-full max-w-3xl rounded-[22px] border border-border/60 bg-card/95" />
        </div>
      </div>
    </div>
  );
}
