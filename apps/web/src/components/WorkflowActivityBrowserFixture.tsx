import {
  EnvironmentId,
  EventId,
  MessageId,
  TurnId,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { type LegendListRef } from "@legendapp/list/react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  deriveTimelineEntries,
  deriveWorkLogEntries,
  type WorkLogToolLifecycleStatus,
} from "../session-logic";
import type { ChatMessage, TurnDiffSummary } from "../types";
import { deriveWorkflowActivityModel } from "../workflow-activity";
import { WorkflowActivityCard } from "./WorkflowActivityCard";
import { MessagesTimeline } from "./chat/MessagesTimeline";
import {
  deriveMessagesTimelineRows,
  type MessagesTimelineRow,
  type TimelineLatestTurn,
} from "./chat/MessagesTimeline.logic";
import {
  consumeWorkflowCardHeightDelta,
  createWorkflowCardHeightBookkeeping,
  getAnchoredTurnMetrics,
  reconcileWorkflowCardHeightOwner,
  recordWorkflowCardHeight,
  resolveWorkflowCardScrollCompensation,
  type TimelineScrollMode,
} from "./chat/timelineScrollAnchoring";

type FixtureThreadId = "alpha" | "beta";

interface FixtureThreadState {
  readonly id: FixtureThreadId;
  readonly label: string;
  readonly turnRevision: number;
  readonly turnId: TurnId;
  readonly nextTick: number;
  readonly nextTaskNumber: number;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly messages: ReadonlyArray<ChatMessage>;
  readonly selectedTaskId: string | null;
}

interface FixtureDomSnapshot {
  readonly renderedTaskCards: number;
  readonly expandedTaskIds: ReadonlyArray<string>;
  readonly recentToolRows: number;
  readonly recentToolStatuses: ReadonlyArray<string>;
  readonly pinnedGroupExpanded: boolean;
  readonly pinnedProgressExpanded: boolean;
  readonly reasoningExpanded: boolean;
  readonly minimapPresent: boolean;
  readonly minimapBottomInset: string;
}

interface CardTelemetry {
  readonly ownerKey: string;
  readonly height: number;
  readonly heightDelta: number;
  readonly compensation: string;
  readonly eventCount: number;
}

interface ActivityInput {
  readonly kind: OrchestrationThreadActivity["kind"];
  readonly summary: string;
  readonly payload: unknown;
  readonly tone?: OrchestrationThreadActivity["tone"];
}

const FIXTURE_ENVIRONMENT_ID = EnvironmentId.make("workflow-fixture");
const FIXTURE_COMPOSER_INSET_PX = 48;
const LONG_PROGRESS_SUMMARY =
  "This deterministic progress summary is intentionally long so the production disclosure must bound and safely wrap it without widening the card, covering neighboring controls, or crowding the virtualized timeline out of the viewport. ".repeat(
    4,
  );
const LONG_RESULT_SUMMARY =
  "This deterministic terminal result is intentionally verbose and remains available only through the production worker disclosure while preserving the card and timeline layout. ".repeat(
    4,
  );
const LONG_REASONING_SUMMARY =
  "This provider-visible synthetic reasoning summary is intentionally long and contains only provider-authorized summary content; the production disclosure must keep it bounded, readable, and isolated from hidden chain-of-thought. ".repeat(
    4,
  );
const LONG_OUTPUT_FILE = `fixture-output/${"deeply-nested-segment/".repeat(12)}result-with-an-intentionally-long-file-name.md`;
const EMPTY_TURN_DIFFS = new Map<MessageId, TurnDiffSummary>();
const EMPTY_REVERT_COUNTS = new Map<MessageId, number>();
const EMPTY_DOM_SNAPSHOT: FixtureDomSnapshot = {
  renderedTaskCards: 0,
  expandedTaskIds: [],
  recentToolRows: 0,
  recentToolStatuses: [],
  pinnedGroupExpanded: false,
  pinnedProgressExpanded: false,
  reasoningExpanded: false,
  minimapPresent: false,
  minimapBottomInset: "none",
};

function fixtureTimestamp(threadId: FixtureThreadId, turnRevision: number, tick: number): string {
  const threadOffset = threadId === "alpha" ? 0 : 30;
  const base = Date.UTC(2042, 0, 1 + threadOffset + turnRevision, 12, 0, 0);
  return new Date(base + tick * 1_000).toISOString();
}

function appendActivity(thread: FixtureThreadState, input: ActivityInput): FixtureThreadState {
  const tick = thread.nextTick;
  const activity: OrchestrationThreadActivity = {
    id: EventId.make(`fixture-${thread.id}-turn-${thread.turnRevision}-activity-${tick}`),
    kind: input.kind,
    summary: input.summary,
    payload: input.payload,
    tone: input.tone ?? "tool",
    turnId: thread.turnId,
    sequence: tick,
    createdAt: fixtureTimestamp(thread.id, thread.turnRevision, tick),
  };
  return {
    ...thread,
    nextTick: tick + 1,
    activities: [...thread.activities, activity],
  };
}

function appendMessage(thread: FixtureThreadState, role: "user" | "assistant", text: string) {
  const tick = thread.nextTick;
  const createdAt = fixtureTimestamp(thread.id, thread.turnRevision, tick);
  const message: ChatMessage = {
    id: MessageId.make(`fixture-${thread.id}-turn-${thread.turnRevision}-message-${tick}`),
    role,
    text,
    turnId: thread.turnId,
    streaming: false,
    createdAt,
    updatedAt: createdAt,
  };
  return {
    ...thread,
    nextTick: tick + 1,
    messages: [...thread.messages, message],
  } satisfies FixtureThreadState;
}

function appendPlanSnapshot(
  thread: FixtureThreadState,
  input: {
    readonly labelPrefix: string;
    readonly statuses: ReadonlyArray<"pending" | "inProgress" | "completed">;
  },
): FixtureThreadState {
  return appendActivity(thread, {
    kind: "turn.plan.updated",
    summary: "Plan updated",
    tone: "info",
    payload: {
      explanation: `Deterministic ${input.labelPrefix.toLowerCase()} fixture plan.`,
      plan: input.statuses.map((status, index) => ({
        step: `${input.labelPrefix} ${index + 1}`,
        status,
      })),
    },
  });
}

function removePlanActivities(thread: FixtureThreadState): FixtureThreadState {
  return {
    ...thread,
    activities: thread.activities.filter((activity) => activity.kind !== "turn.plan.updated"),
  };
}

function appendTaskStart(
  thread: FixtureThreadState,
  options: {
    readonly description?: string;
    readonly skipTranscript?: boolean;
    readonly taskId?: string;
  } = {},
): FixtureThreadState {
  const taskNumber = thread.nextTaskNumber;
  const taskId =
    options.taskId ?? `fixture-${thread.id}-turn-${thread.turnRevision}-task-${taskNumber}`;
  const description = options.description ?? `Inspect deterministic target ${taskNumber}`;
  const next = appendActivity(thread, {
    kind: "task.started",
    summary: "Task started",
    payload: {
      taskId,
      toolUseId: `${taskId}-tool-use`,
      description,
      taskType: "agent",
      subagentType: taskNumber % 2 === 0 ? "reviewer" : "explorer",
      workflowName: "workflow-activity-browser-fixture",
      prompt: `Synthetic prompt for ${description.toLowerCase()}.`,
      ...(options.skipTranscript === undefined ? {} : { skipTranscript: options.skipTranscript }),
    },
  });
  return {
    ...next,
    nextTaskNumber: options.taskId === undefined ? taskNumber + 1 : thread.nextTaskNumber,
    selectedTaskId: taskId,
  };
}

function appendTaskProgress(
  thread: FixtureThreadState,
  taskId: string,
  options: {
    readonly summary?: string;
    readonly totalTokens?: number;
    readonly toolUses?: number;
    readonly durationMs?: number;
    readonly lastToolName?: string;
  } = {},
): FixtureThreadState {
  const totalTokens = options.totalTokens ?? 1_200 + thread.nextTick * 10;
  const toolUses = options.toolUses ?? 3;
  const durationMs = options.durationMs ?? 24_000;
  return appendActivity(thread, {
    kind: "task.progress",
    summary: "Task progress",
    payload: {
      taskId,
      summary: options.summary ?? `Progress snapshot at sequence ${thread.nextTick}`,
      usage: { totalTokens, toolUses, durationMs },
      lastToolName: options.lastToolName ?? "Read",
    },
  });
}

function appendTaskTerminal(
  thread: FixtureThreadState,
  taskId: string,
  status: Extract<WorkLogToolLifecycleStatus, "completed" | "failed" | "stopped">,
  options: {
    readonly summary?: string;
    readonly outputFile?: string;
    readonly totalTokens?: number;
    readonly toolUses?: number;
    readonly durationMs?: number;
  } = {},
): FixtureThreadState {
  return appendActivity(thread, {
    kind: "task.completed",
    summary: `Task ${status}`,
    tone: status === "failed" ? "error" : "tool",
    payload: {
      taskId,
      status,
      summary:
        options.summary ??
        (status === "completed"
          ? "Synthetic task result is ready."
          : status === "failed"
            ? "Synthetic task failed at a controlled boundary."
            : "Synthetic task stopped at the requested checkpoint."),
      outputFile: options.outputFile ?? `fixture-output/${taskId}.md`,
      usage: {
        totalTokens: options.totalTokens ?? 2_400,
        toolUses: options.toolUses ?? 7,
        durationMs: options.durationMs ?? 61_000,
      },
    },
  });
}

function createFixtureThread(id: FixtureThreadId, turnRevision = 1): FixtureThreadState {
  let thread: FixtureThreadState = {
    id,
    label: id === "alpha" ? "Alpha / planned" : "Beta / plan-less",
    turnRevision,
    turnId: TurnId.make(`fixture-${id}-turn-${turnRevision}`),
    nextTick: 1,
    nextTaskNumber: 1,
    activities: [],
    messages: [],
    selectedTaskId: null,
  };
  thread = appendMessage(thread, "user", `Begin deterministic ${id} fixture turn.`);
  thread = appendMessage(
    thread,
    "assistant",
    "This checked-in synthetic conversation exercises production timeline rendering.",
  );

  if (id === "alpha") {
    thread = appendPlanSnapshot(thread, {
      labelPrefix: "Fixture step",
      statuses: ["completed", "inProgress", "pending"],
    });
    thread = appendTaskStart(thread, { description: "Inspect lifecycle continuity" });
    thread = appendTaskProgress(thread, thread.selectedTaskId!, {
      summary: "Scanning the production derivation path",
      totalTokens: 1_200,
      toolUses: 4,
      durationMs: 30_000,
      lastToolName: "Read",
    });
    thread = appendActivity(thread, {
      kind: "turn.reasoning.summary",
      summary: "Reasoning summary updated",
      tone: "info",
      payload: {
        reasoningSummary:
          "Provider-visible reasoning summary: preserve task identity while lifecycle content changes.",
      },
    });
  } else {
    thread = appendTaskStart(thread, { description: "Exercise plan-less activity" });
    thread = appendTaskProgress(thread, thread.selectedTaskId!, {
      summary: "Reviewing the responsive main-column placement",
      totalTokens: 800,
      toolUses: 2,
      durationMs: 18_000,
      lastToolName: "Search",
    });
  }

  return thread;
}

function appendTranscriptRows(thread: FixtureThreadState, count: number): FixtureThreadState {
  let next = thread;
  for (let index = 0; index < count; index += 1) {
    const role = index % 2 === 0 ? "user" : "assistant";
    next = appendMessage(
      next,
      role,
      `${role === "user" ? "Fixture request" : "Fixture response"} ${index + 1}: synthetic row for virtualization.`,
    );
  }
  return next;
}

function appendInterleavedTasks(thread: FixtureThreadState): FixtureThreadState {
  let next = appendTaskStart(thread, { description: "Interleaved worker A" });
  const taskA = next.selectedTaskId!;
  next = appendTaskStart(next, { description: "Interleaved worker B" });
  const taskB = next.selectedTaskId!;
  next = appendTaskProgress(next, taskA, {
    summary: "Worker A yielded its first update",
    totalTokens: 600,
    toolUses: 2,
    durationMs: 9_000,
    lastToolName: "Search",
  });
  next = appendTaskProgress(next, taskB, {
    summary: "Worker B yielded between worker A events",
    totalTokens: 900,
    toolUses: 3,
    durationMs: 12_000,
    lastToolName: "Read",
  });
  return { ...next, selectedTaskId: taskA };
}

function appendDuplicateResume(thread: FixtureThreadState, taskId: string): FixtureThreadState {
  let next = appendTaskStart(thread, {
    taskId,
    description: "Duplicate start notification for the selected task",
  });
  next = appendTaskProgress(next, taskId, {
    summary: "Resumed notification after a duplicate start",
    totalTokens: 2_650,
    toolUses: 8,
    durationMs: 70_000,
    lastToolName: "Resume",
  });
  return next;
}

function appendRepeatedUsage(thread: FixtureThreadState, taskId: string): FixtureThreadState {
  let next = appendTaskProgress(thread, taskId, {
    summary: "Earlier cumulative usage snapshot",
    totalTokens: 1_000,
    toolUses: 3,
    durationMs: 20_000,
    lastToolName: "Search",
  });
  next = appendTaskProgress(next, taskId, {
    summary: "Latest cumulative usage snapshot",
    totalTokens: 1_750,
    toolUses: 5,
    durationMs: 35_000,
    lastToolName: "Read",
  });
  return next;
}

function appendLinkedAndUnlinkedTools(
  thread: FixtureThreadState,
  selectedTaskId: string | null,
): FixtureThreadState {
  let next = appendActivity(thread, {
    kind: "tool.progress",
    summary: "Linked synthetic tool",
    payload: {
      toolUseId: `linked-tool-${thread.nextTick}`,
      taskId: selectedTaskId ?? undefined,
      toolName: "Read",
      summary: "Read a synthetic fixture module",
      elapsedSeconds: 2,
    },
  });
  next = appendActivity(next, {
    kind: "tool.progress",
    summary: "Unlinked synthetic tool",
    payload: {
      toolUseId: `unlinked-tool-${next.nextTick}`,
      parentToolUseId: null,
      toolName: "Search",
      summary: "Search checked-in synthetic content",
      elapsedSeconds: 3,
    },
  });
  return next;
}

function fixtureRecentToolUseId(thread: FixtureThreadState): string {
  return `fixture-${thread.id}-turn-${thread.turnRevision}-recent-tool`;
}

function activityToolUseId(activity: OrchestrationThreadActivity): string | null {
  if (activity.payload === null || typeof activity.payload !== "object") return null;
  const value = (activity.payload as Record<string, unknown>).toolUseId;
  return typeof value === "string" ? value : null;
}

function appendRecentToolProgress(
  thread: FixtureThreadState,
  options: { readonly reset?: boolean; readonly late?: boolean } = {},
): FixtureThreadState {
  const toolUseId = fixtureRecentToolUseId(thread);
  const base = options.reset
    ? {
        ...thread,
        activities: thread.activities.filter(
          (activity) => activityToolUseId(activity) !== toolUseId,
        ),
      }
    : thread;
  return appendActivity(base, {
    kind: "tool.progress",
    summary: options.late ? "Late recent-tool progress" : "Recent tool in progress",
    payload: {
      toolUseId,
      taskId: thread.selectedTaskId ?? undefined,
      toolName: "Bash",
      summary: options.late
        ? "Late progress must not revive this terminal row"
        : "Run the deterministic recent-tool check",
      elapsedSeconds: options.late ? 9 : 1,
    },
  });
}

function appendRecentToolTerminal(
  thread: FixtureThreadState,
  status: "completed" | "failed",
): FixtureThreadState {
  return appendActivity(thread, {
    kind: "tool.completed",
    summary: `Recent tool ${status}`,
    tone: status === "failed" ? "error" : "tool",
    payload: {
      toolUseId: fixtureRecentToolUseId(thread),
      status,
      detail: `Deterministic recent tool ${status}`,
    },
  });
}

function appendExplicitValuesScenario(thread: FixtureThreadState): FixtureThreadState {
  let next = appendTaskStart(thread, {
    description: "Explicit false / zero / null worker",
    skipTranscript: false,
  });
  const taskId = next.selectedTaskId!;
  next = appendTaskProgress(next, taskId, {
    summary: "Zero-valued cumulative snapshot is intentionally retained.",
    totalTokens: 0,
    toolUses: 0,
    durationMs: 0,
    lastToolName: "ZeroSnapshot",
  });
  return appendActivity(next, {
    kind: "tool.progress",
    summary: "Explicit null parent tool",
    payload: {
      toolUseId: `null-parent-tool-${next.nextTick}`,
      parentToolUseId: null,
      toolName: "Search",
      summary: "Null-compatible parent identity is intentionally retained.",
      elapsedSeconds: 0,
    },
  });
}

function appendLongContentScenario(thread: FixtureThreadState): FixtureThreadState {
  let next = appendTaskStart(thread, { description: "Bounded long-content worker" });
  const taskId = next.selectedTaskId!;
  next = appendTaskProgress(next, taskId, {
    summary: LONG_PROGRESS_SUMMARY,
    totalTokens: 3_200,
    toolUses: 9,
    durationMs: 75_000,
    lastToolName: "Read",
  });
  next = appendTaskTerminal(next, taskId, "completed", {
    summary: LONG_RESULT_SUMMARY,
    outputFile: LONG_OUTPUT_FILE,
    totalTokens: 3_600,
    toolUses: 11,
    durationMs: 82_000,
  });
  return appendActivity(next, {
    kind: "turn.reasoning.summary",
    summary: "Long reasoning summary updated",
    tone: "info",
    payload: { reasoningSummary: LONG_REASONING_SUMMARY },
  });
}

function removeWorkflowCard(thread: FixtureThreadState): FixtureThreadState {
  return { ...thread, activities: [], selectedTaskId: null };
}

function appendHistoricalAndOtherGroups(thread: FixtureThreadState): FixtureThreadState {
  let next = appendPlanSnapshot(thread, {
    labelPrefix: "Earlier investigation",
    statuses: ["inProgress", "pending"],
  });
  next = appendTaskStart(next, { description: "Worker from an earlier plan" });
  next = appendPlanSnapshot(next, {
    labelPrefix: "Replacement plan",
    statuses: ["completed", "inProgress", "pending"],
  });
  next = appendPlanSnapshot(next, {
    labelPrefix: "No-active-step plan",
    statuses: ["completed", "pending", "pending"],
  });
  next = appendTaskStart(next, { description: "Worker without an active step" });
  return next;
}

function toggleReasoningSummary(thread: FixtureThreadState): FixtureThreadState {
  const hasReasoning = thread.activities.some(
    (activity) => activity.kind === "turn.reasoning.summary",
  );
  if (hasReasoning) {
    return {
      ...thread,
      activities: thread.activities.filter(
        (activity) => activity.kind !== "turn.reasoning.summary",
      ),
    };
  }
  return appendActivity(thread, {
    kind: "turn.reasoning.summary",
    summary: "Reasoning summary updated",
    tone: "info",
    payload: {
      reasoningSummary:
        "Provider-visible synthetic reasoning summary, intentionally not hidden chain-of-thought.",
    },
  });
}

function taskStatus(
  rows: ReadonlyArray<MessagesTimelineRow>,
  taskId: string | null,
): WorkLogToolLifecycleStatus | null {
  if (!taskId) return null;
  for (const row of rows) {
    if (row.kind !== "work") continue;
    const entry = row.groupedEntries.find((candidate) => candidate.taskId === taskId);
    if (entry) return entry.toolLifecycleStatus ?? "inProgress";
  }
  return null;
}

function taskRowIds(rows: ReadonlyArray<MessagesTimelineRow>, taskId: string | null): string[] {
  if (!taskId) return [];
  return rows.flatMap((row) =>
    row.kind === "work" && row.groupedEntries.some((entry) => entry.taskId === taskId)
      ? [row.id]
      : [],
  );
}

function readDomSnapshot(root: HTMLElement | null): FixtureDomSnapshot {
  if (!root) return EMPTY_DOM_SNAPSHOT;
  const taskCards = [...root.querySelectorAll<HTMLElement>("[data-task-card='true']")];
  const expandedTaskIds = taskCards.flatMap((card) => {
    const trigger = card.querySelector<HTMLButtonElement>("button[aria-expanded='true']");
    return trigger && card.dataset.taskId ? [card.dataset.taskId] : [];
  });
  const workflowCard = root.querySelector<HTMLElement>("[data-slot='workflow-activity-card']");
  const recentToolRows = workflowCard
    ? [...workflowCard.querySelectorAll<HTMLElement>("[data-slot='workflow-recent-tool']")]
    : [];
  const minimap = root.querySelector<HTMLElement>("[data-testid='timeline-minimap']");
  const expandedButtons = workflowCard
    ? [...workflowCard.querySelectorAll<HTMLButtonElement>("button[aria-expanded='true']")].filter(
        (button) => button.dataset.slot !== "workflow-activity-toggle",
      )
    : [];
  const buttonHasLabel = (button: HTMLButtonElement, label: string) =>
    button.textContent?.trim().startsWith(label) ?? false;
  return {
    renderedTaskCards: taskCards.length,
    expandedTaskIds,
    recentToolRows: recentToolRows.length,
    recentToolStatuses: recentToolRows.flatMap((row) => {
      const label = row.querySelector<HTMLElement>("[aria-label]")?.getAttribute("aria-label");
      return label ? [label] : [];
    }),
    pinnedGroupExpanded: expandedButtons.some(
      (button) => !buttonHasLabel(button, "Progress") && !buttonHasLabel(button, "Reasoning"),
    ),
    pinnedProgressExpanded: expandedButtons.some((button) => buttonHasLabel(button, "Progress")),
    reasoningExpanded: expandedButtons.some((button) => buttonHasLabel(button, "Reasoning")),
    minimapPresent: minimap !== null,
    minimapBottomInset: minimap?.style.bottom || "none",
  };
}

function domSnapshotsEqual(left: FixtureDomSnapshot, right: FixtureDomSnapshot): boolean {
  return (
    left.renderedTaskCards === right.renderedTaskCards &&
    left.recentToolRows === right.recentToolRows &&
    left.recentToolStatuses.join("|") === right.recentToolStatuses.join("|") &&
    left.pinnedGroupExpanded === right.pinnedGroupExpanded &&
    left.pinnedProgressExpanded === right.pinnedProgressExpanded &&
    left.reasoningExpanded === right.reasoningExpanded &&
    left.minimapPresent === right.minimapPresent &&
    left.minimapBottomInset === right.minimapBottomInset &&
    left.expandedTaskIds.join("|") === right.expandedTaskIds.join("|")
  );
}

function FixtureButton({
  children,
  disabled = false,
  onClick,
}: {
  readonly children: ReactNode;
  readonly disabled?: boolean;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="cursor-pointer rounded-md border border-border/80 bg-background px-2 py-1.5 text-left text-xs font-medium text-foreground/85 transition-colors hover:bg-accent/45 disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function ControlGroup({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <section className="space-y-2 border-b border-border/60 pb-3 last:border-b-0">
      <h2 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Metric({ label, value }: { readonly label: string; readonly value: ReactNode }) {
  return (
    <div className="min-w-0 rounded-md border border-border/60 bg-background/70 px-2 py-1.5">
      <dt className="text-[10px] uppercase tracking-[0.1em] text-muted-foreground/70">{label}</dt>
      <dd className="mt-0.5 truncate text-xs font-medium text-foreground/85">{value}</dd>
    </div>
  );
}

export function WorkflowActivityBrowserFixture() {
  const [activeThreadId, setActiveThreadId] = useState<FixtureThreadId>("alpha");
  const [threads, setThreads] = useState<Record<FixtureThreadId, FixtureThreadState>>(() => ({
    alpha: createFixtureThread("alpha"),
    beta: createFixtureThread("beta"),
  }));
  const [scrollMode, setScrollMode] = useState<TimelineScrollMode>("following-end");
  const [anchorMessageId, setAnchorMessageId] = useState<MessageId | null>(null);
  const [anchorIndex, setAnchorIndex] = useState<number | null>(null);
  const [anchorSize, setAnchorSize] = useState<number | null>(null);
  const [isAtEnd, setIsAtEnd] = useState(true);
  const [domSnapshot, setDomSnapshot] = useState<FixtureDomSnapshot>(EMPTY_DOM_SNAPSHOT);
  const [controlNote, setControlNote] = useState("Ready for deterministic browser steps.");
  const [cardTelemetry, setCardTelemetry] = useState<CardTelemetry>({
    ownerKey: "",
    height: 0,
    heightDelta: 0,
    compensation: "none",
    eventCount: 0,
  });
  const fixtureRootRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<LegendListRef | null>(null);
  const activeAnchorIndexRef = useRef<number | null>(null);
  const scrollModeRef = useRef<TimelineScrollMode>(scrollMode);
  const cardBookkeepingRef = useRef(createWorkflowCardHeightBookkeeping(null));

  const activeThread = threads[activeThreadId];
  // Production height ownership is thread-scoped so replacing a turn/card in
  // the same thread measures the real old-to-new transition. Timeline anchor
  // ownership is turn-scoped because a replaced turn must never retain an old
  // message anchor.
  const cardOwnerKey = activeThread.id;
  const timelineOwnerKey = `${activeThread.id}:${activeThread.turnId}`;
  const latestTurn = useMemo<TimelineLatestTurn>(
    () => ({
      turnId: activeThread.turnId,
      state: "running",
      startedAt: fixtureTimestamp(activeThread.id, activeThread.turnRevision, 0),
      completedAt: null,
    }),
    [activeThread.id, activeThread.turnId, activeThread.turnRevision],
  );
  const workEntries = useMemo(
    () => deriveWorkLogEntries(activeThread.activities),
    [activeThread.activities],
  );
  const timelineEntries = useMemo(
    () => deriveTimelineEntries(activeThread.messages, [], workEntries),
    [activeThread.messages, workEntries],
  );
  const workflowModel = useMemo(
    () => deriveWorkflowActivityModel(activeThread.activities, activeThread.turnId),
    [activeThread.activities, activeThread.turnId],
  );
  const observableRows = useMemo(
    () =>
      deriveMessagesTimelineRows({
        timelineEntries,
        latestTurn,
        runningTurnId: activeThread.turnId,
        isWorking: false,
        activeTurnStartedAt: latestTurn.startedAt,
        turnDiffSummaryByAssistantMessageId: EMPTY_TURN_DIFFS,
        revertTurnCountByUserMessageId: EMPTY_REVERT_COUNTS,
      }),
    [activeThread.turnId, latestTurn, timelineEntries],
  );
  const selectedTask =
    workflowModel?.workers.find((worker) => worker.taskId === activeThread.selectedTaskId) ?? null;
  const selectedTaskRowIds = taskRowIds(observableRows, activeThread.selectedTaskId);
  const selectedTaskStatus =
    selectedTask?.status ?? taskStatus(observableRows, activeThread.selectedTaskId);
  const taskTimelineRowCount = observableRows.filter(
    (row) => row.kind === "work" && row.groupedEntries.some((entry) => entry.taskId !== undefined),
  ).length;
  const hiddenTranscriptTaskCount =
    workflowModel?.workers.filter((worker) => worker.skipTranscript).length ?? 0;
  const activeStepCount =
    workflowModel?.steps.filter((step) => step.status === "inProgress").length ?? 0;
  const hasExplicitNullParent =
    workflowModel?.recentTools.some((tool) => tool.parentToolUseId === null) ?? false;
  const fixtureRecentTool = workflowModel?.recentTools.find(
    (tool) => tool.toolUseId === fixtureRecentToolUseId(activeThread),
  );

  const updateActiveThread = useCallback(
    (update: (thread: FixtureThreadState) => FixtureThreadState) => {
      setThreads((current) => ({
        ...current,
        [activeThreadId]: update(current[activeThreadId]),
      }));
    },
    [activeThreadId],
  );

  useLayoutEffect(() => {
    cardBookkeepingRef.current = reconcileWorkflowCardHeightOwner(
      cardBookkeepingRef.current,
      cardOwnerKey,
    );
    setCardTelemetry({
      ownerKey: cardOwnerKey,
      height: cardBookkeepingRef.current.height,
      heightDelta: 0,
      compensation: "owner-reset",
      eventCount: 0,
    });
  }, [cardOwnerKey]);

  useLayoutEffect(() => {
    activeAnchorIndexRef.current = null;
    setAnchorIndex(null);
    setAnchorSize(null);
    if (scrollModeRef.current === "free-scrolling") {
      setAnchorMessageId(null);
      setIsAtEnd(false);
      return;
    }
    if (scrollModeRef.current !== "anchoring-new-turn") {
      setAnchorMessageId(null);
      setIsAtEnd(true);
      return;
    }
    const nextAnchor = [...activeThread.messages]
      .toReversed()
      .find((message) => message.role === "user")?.id;
    setAnchorMessageId(nextAnchor ?? null);
  }, [activeThread.messages, timelineOwnerKey]);

  const handleCardHeightChange = useCallback(
    (nextHeight: number) => {
      const recorded = recordWorkflowCardHeight(
        cardBookkeepingRef.current,
        cardOwnerKey,
        nextHeight,
      );
      if (recorded === cardBookkeepingRef.current) return;
      cardBookkeepingRef.current = recorded;
      const consumed = consumeWorkflowCardHeightDelta(cardBookkeepingRef.current, cardOwnerKey);
      cardBookkeepingRef.current = consumed.bookkeeping;
      const list = listRef.current;
      const listState = list?.getState() ?? null;
      const compensation = resolveWorkflowCardScrollCompensation({
        mode: scrollModeRef.current,
        heightDelta: consumed.heightDelta,
        state: listState,
      });

      if (list && compensation.kind === "restore-end") {
        void list.scrollToEnd?.({ animated: false });
      } else if (list && compensation.kind === "preserve-offset") {
        void list.scrollToOffset({ offset: compensation.targetOffset, animated: false });
      } else if (
        list &&
        listState &&
        compensation.kind === "revalidate-anchor" &&
        activeAnchorIndexRef.current !== null
      ) {
        const metrics = getAnchoredTurnMetrics({
          state: listState,
          anchorIndex: activeAnchorIndexRef.current,
          composerOverlayHeight: FIXTURE_COMPOSER_INSET_PX,
          anchorOffset: 0,
        });
        if (metrics && metrics.scrollDeltaToRevealEnd > 1) {
          void list.scrollToOffset({
            offset: listState.scroll + metrics.scrollDeltaToRevealEnd,
            animated: false,
          });
        }
      }

      setCardTelemetry((current) => ({
        ownerKey: cardOwnerKey,
        height: nextHeight,
        heightDelta: consumed.heightDelta,
        compensation: compensation.kind,
        eventCount: current.ownerKey === cardOwnerKey ? current.eventCount + 1 : 1,
      }));
    },
    [cardOwnerKey],
  );

  useEffect(() => {
    if (workflowModel === null) handleCardHeightChange(0);
  }, [handleCardHeightChange, workflowModel]);

  useEffect(() => {
    const capture = () => {
      const next = readDomSnapshot(fixtureRootRef.current);
      setDomSnapshot((current) => (domSnapshotsEqual(current, next) ? current : next));
    };
    capture();
    const root = fixtureRootRef.current;
    if (!root || typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(capture);
    observer.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["aria-expanded", "aria-label", "data-task-status"],
    });
    return () => observer.disconnect();
  }, [observableRows, timelineOwnerKey, workflowModel]);

  const driveScrollMode = useCallback(
    (nextMode: TimelineScrollMode) => {
      scrollModeRef.current = nextMode;
      setScrollMode(nextMode);
      const list = listRef.current;
      if (nextMode === "following-end") {
        setAnchorMessageId(null);
        activeAnchorIndexRef.current = null;
        setAnchorIndex(null);
        setAnchorSize(null);
        setIsAtEnd(true);
        void list?.scrollToEnd?.({ animated: false });
        setControlNote("Following-end mode selected; the production list was sent to its end.");
        return;
      }
      if (nextMode === "free-scrolling") {
        setAnchorMessageId(null);
        activeAnchorIndexRef.current = null;
        setAnchorIndex(null);
        setAnchorSize(null);
        setIsAtEnd(false);
        const currentScroll = list?.getState()?.scroll ?? 0;
        void list?.scrollToOffset({
          offset: Math.max(0, currentScroll - 240),
          animated: false,
        });
        setControlNote("Free-scrolling mode selected with a deterministic 240px offset move.");
        return;
      }
      const anchor = [...activeThread.messages]
        .toReversed()
        .find((message) => message.role === "user")?.id;
      activeAnchorIndexRef.current = null;
      setAnchorIndex(null);
      setAnchorSize(null);
      setAnchorMessageId(anchor ?? null);
      setControlNote(
        anchor
          ? `Anchoring-new-turn mode selected at ${anchor}.`
          : "Anchoring-new-turn selected; add a user transcript row to supply an anchor.",
      );
    },
    [activeThread.messages],
  );

  const setPinnedGroupExpanded = useCallback(
    (expanded: boolean) => {
      const card = fixtureRootRef.current?.querySelector<HTMLElement>(
        "[data-slot='workflow-activity-card']",
      );
      const candidates = card
        ? [...card.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")].filter(
            (button) => {
              if (button.dataset.slot === "workflow-activity-toggle") return false;
              const label = button.textContent?.trim() ?? "";
              return !label.startsWith("Progress") && !label.startsWith("Reasoning");
            },
          )
        : [];
      const preferredGroupLabel = workflowModel
        ? [
            ...workflowModel.steps,
            ...workflowModel.historicalSteps,
            ...(workflowModel.otherActivity ? [workflowModel.otherActivity] : []),
          ].find((group) => group.workers.length > 0)?.label
        : undefined;
      const target = expanded
        ? (candidates.find(
            (button) =>
              button.getAttribute("aria-expanded") === "false" &&
              (preferredGroupLabel === undefined ||
                button.textContent?.trim().startsWith(preferredGroupLabel)),
          ) ?? candidates.find((button) => button.getAttribute("aria-expanded") === "false"))
        : candidates.find((button) => button.getAttribute("aria-expanded") === "true");
      if (!target) {
        setControlNote(
          expanded
            ? "No collapsed plan group is available; load a plan first."
            : "The pinned card is already collapsed.",
        );
        return;
      }
      target.click();
      setControlNote(`${expanded ? "Expanded" : "Collapsed"} the production pinned card group.`);
    },
    [workflowModel],
  );

  const setPinnedProgressExpanded = useCallback((expanded: boolean) => {
    const card = fixtureRootRef.current?.querySelector<HTMLElement>(
      "[data-slot='workflow-activity-card']",
    );
    const target = card
      ? [...card.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")].find((button) =>
          button.textContent?.trim().startsWith("Progress"),
        )
      : undefined;
    if (!target) {
      setControlNote("No visible pinned Progress disclosure; expand a worker-bearing group first.");
      return;
    }
    if ((target.getAttribute("aria-expanded") === "true") !== expanded) target.click();
    setControlNote(`${expanded ? "Expanded" : "Collapsed"} pinned worker progress.`);
  }, []);

  const setTaskDisclosureExpanded = useCallback(
    (expanded: boolean) => {
      const taskId = activeThread.selectedTaskId;
      const cards =
        fixtureRootRef.current?.querySelectorAll<HTMLElement>("[data-task-card='true']");
      const taskCard = cards
        ? [...cards].find((candidate) => candidate.dataset.taskId === taskId)
        : undefined;
      const trigger = taskCard?.querySelector<HTMLButtonElement>("button[aria-expanded]");
      if (!trigger) {
        setControlNote(
          "The selected task card is hidden or has no disclosure; start a task so it is the latest row.",
        );
        return;
      }
      if ((trigger.getAttribute("aria-expanded") === "true") !== expanded) trigger.click();
      setControlNote(`${expanded ? "Expanded" : "Collapsed"} the selected production task card.`);
    },
    [activeThread.selectedTaskId],
  );

  const selectedTaskOptions = workflowModel?.workers ?? [];
  const hasSelectedTask = activeThread.selectedTaskId !== null;

  return (
    <div
      ref={fixtureRootRef}
      className="flex h-dvh min-h-0 w-full flex-col overflow-hidden bg-background text-foreground"
      data-testid="workflow-activity-browser-fixture"
    >
      <header className="shrink-0 border-b border-border bg-card/60 px-3 py-2 sm:px-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-primary">
              Development fixture
            </p>
            <h1 className="text-sm font-semibold">Workflow activity production harness</h1>
          </div>
          <p className="ms-auto max-w-2xl text-right text-[11px] text-muted-foreground max-[980px]:w-full max-[980px]:text-left">
            Synthetic checked-in data only · explicit controls · no provider, transcript, path, or
            timer
          </p>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(18rem,23rem)_minmax(0,1fr)] max-[980px]:grid-cols-1 max-[980px]:grid-rows-[minmax(10rem,26vh)_minmax(0,1fr)]">
        <aside className="min-h-0 overflow-y-auto border-r border-border bg-muted/15 p-3 max-[980px]:border-r-0 max-[980px]:border-b">
          <div className="space-y-3">
            <ControlGroup title="Thread and turn">
              <div className="grid grid-cols-2 gap-1.5">
                <FixtureButton
                  onClick={() => {
                    setActiveThreadId("alpha");
                    setControlNote("Selected the Alpha thread snapshot.");
                  }}
                >
                  Select Alpha
                </FixtureButton>
                <FixtureButton
                  onClick={() => {
                    setActiveThreadId("beta");
                    setControlNote("Selected the Beta thread snapshot.");
                  }}
                >
                  Select Beta
                </FixtureButton>
                <FixtureButton
                  onClick={() => {
                    updateActiveThread((thread) =>
                      createFixtureThread(thread.id, thread.turnRevision + 1),
                    );
                    setControlNote(
                      "Replaced the active turn with the next deterministic revision.",
                    );
                  }}
                >
                  Replace turn
                </FixtureButton>
                <FixtureButton
                  onClick={() => {
                    updateActiveThread((thread) =>
                      createFixtureThread(thread.id, thread.turnRevision),
                    );
                    setControlNote("Reset the active thread snapshot.");
                  }}
                >
                  Reset snapshot
                </FixtureButton>
              </div>
            </ControlGroup>

            <ControlGroup title="Selected task lifecycle">
              <select
                aria-label="Selected fixture task"
                value={activeThread.selectedTaskId ?? ""}
                onChange={(event) => {
                  const taskId = event.currentTarget.value || null;
                  updateActiveThread((thread) => ({ ...thread, selectedTaskId: taskId }));
                  setControlNote(`Selected task ${taskId ?? "none"}.`);
                }}
                className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs"
              >
                <option value="">No task selected</option>
                {selectedTaskOptions.map((worker) => (
                  <option key={worker.taskId} value={worker.taskId}>
                    {worker.description ?? worker.taskId}
                  </option>
                ))}
              </select>
              <div className="grid grid-cols-2 gap-1.5">
                <FixtureButton
                  onClick={() => {
                    updateActiveThread((thread) => appendTaskStart(thread));
                    setControlNote("Appended one task.started activity.");
                  }}
                >
                  Append start
                </FixtureButton>
                <FixtureButton
                  disabled={!hasSelectedTask}
                  onClick={() => {
                    updateActiveThread((thread) =>
                      thread.selectedTaskId
                        ? appendTaskProgress(thread, thread.selectedTaskId)
                        : thread,
                    );
                    setControlNote("Appended progress to the selected task.");
                  }}
                >
                  Append progress
                </FixtureButton>
                {(["completed", "failed", "stopped"] as const).map((status) => (
                  <FixtureButton
                    key={status}
                    disabled={!hasSelectedTask}
                    onClick={() => {
                      updateActiveThread((thread) =>
                        thread.selectedTaskId
                          ? appendTaskTerminal(thread, thread.selectedTaskId, status)
                          : thread,
                      );
                      setControlNote(`Appended the ${status} terminal activity.`);
                    }}
                  >
                    Append {status}
                  </FixtureButton>
                ))}
              </div>
            </ControlGroup>

            <ControlGroup title="Recent tool lifecycle">
              <div className="grid grid-cols-2 gap-1.5">
                <FixtureButton
                  onClick={() => {
                    updateActiveThread((thread) =>
                      appendRecentToolProgress(thread, { reset: true }),
                    );
                    setControlNote("Reset one canonical recent tool to Running.");
                  }}
                >
                  Tool progress
                </FixtureButton>
                <FixtureButton
                  disabled={fixtureRecentTool?.status !== "inProgress"}
                  onClick={() => {
                    updateActiveThread((thread) => appendRecentToolTerminal(thread, "completed"));
                    setControlNote("Settled the canonical recent tool as Completed.");
                  }}
                >
                  Tool completed
                </FixtureButton>
                <FixtureButton
                  disabled={fixtureRecentTool?.status !== "inProgress"}
                  onClick={() => {
                    updateActiveThread((thread) => appendRecentToolTerminal(thread, "failed"));
                    setControlNote("Settled the canonical recent tool as Failed.");
                  }}
                >
                  Tool failed
                </FixtureButton>
                <FixtureButton
                  disabled={
                    fixtureRecentTool === undefined || fixtureRecentTool.status === "inProgress"
                  }
                  onClick={() => {
                    updateActiveThread((thread) =>
                      appendRecentToolProgress(thread, { late: true }),
                    );
                    setControlNote("Appended late progress; terminal status must remain latched.");
                  }}
                >
                  Late tool progress
                </FixtureButton>
              </div>
            </ControlGroup>

            <ControlGroup title="Coverage scenarios">
              <div className="grid grid-cols-2 gap-1.5">
                <FixtureButton
                  onClick={() => {
                    updateActiveThread(appendInterleavedTasks);
                    setControlNote("Appended two interleaved task lifecycles.");
                  }}
                >
                  Interleave tasks
                </FixtureButton>
                <FixtureButton
                  disabled={!hasSelectedTask}
                  onClick={() => {
                    updateActiveThread((thread) =>
                      thread.selectedTaskId
                        ? appendDuplicateResume(thread, thread.selectedTaskId)
                        : thread,
                    );
                    setControlNote("Appended duplicate start and resumed progress notifications.");
                  }}
                >
                  Duplicate / resume
                </FixtureButton>
                <FixtureButton
                  disabled={!hasSelectedTask}
                  onClick={() => {
                    updateActiveThread((thread) =>
                      thread.selectedTaskId
                        ? appendRepeatedUsage(thread, thread.selectedTaskId)
                        : thread,
                    );
                    setControlNote("Appended two cumulative usage snapshots; latest should win.");
                  }}
                >
                  Repeated usage
                </FixtureButton>
                <FixtureButton
                  onClick={() => {
                    updateActiveThread((thread) =>
                      appendLinkedAndUnlinkedTools(thread, thread.selectedTaskId),
                    );
                    setControlNote("Appended linked and unlinked tool.progress activity.");
                  }}
                >
                  Linked + unlinked tools
                </FixtureButton>
                <FixtureButton
                  onClick={() => {
                    updateActiveThread(appendExplicitValuesScenario);
                    setControlNote(
                      "Appended explicit false, zero, and null-compatible provider values.",
                    );
                  }}
                >
                  False / zero / null
                </FixtureButton>
                <FixtureButton
                  onClick={() => {
                    updateActiveThread(appendLongContentScenario);
                    setControlNote("Appended deterministic long summary and output content.");
                  }}
                >
                  Long content
                </FixtureButton>
                <FixtureButton
                  onClick={() => {
                    updateActiveThread((thread) => {
                      let next = appendTaskStart(thread, {
                        description: "Ambient skipTranscript worker",
                        skipTranscript: true,
                      });
                      next = appendTaskProgress(next, next.selectedTaskId!, {
                        summary: "Visible in pinned activity, hidden from transcript",
                        totalTokens: 500,
                        toolUses: 1,
                        durationMs: 5_000,
                      });
                      return next;
                    });
                    setControlNote("Appended a skipTranscript task lifecycle.");
                  }}
                >
                  skipTranscript task
                </FixtureButton>
                <FixtureButton
                  onClick={() => {
                    updateActiveThread(toggleReasoningSummary);
                    setControlNote("Toggled provider-visible reasoning summary present / absent.");
                  }}
                >
                  Toggle reasoning
                </FixtureButton>
                <FixtureButton
                  onClick={() => {
                    updateActiveThread((thread) =>
                      appendPlanSnapshot(removePlanActivities(thread), {
                        labelPrefix: "Fixture step",
                        statuses: ["completed", "inProgress", "pending"],
                      }),
                    );
                    setControlNote("Loaded one-active-step plan state.");
                  }}
                >
                  Plan
                </FixtureButton>
                <FixtureButton
                  onClick={() => {
                    updateActiveThread(removePlanActivities);
                    setControlNote(
                      "Removed plan activity; workers now use plan-less Activity layout.",
                    );
                  }}
                >
                  No plan
                </FixtureButton>
                <FixtureButton
                  onClick={() => {
                    updateActiveThread((thread) =>
                      appendPlanSnapshot(removePlanActivities(thread), {
                        labelPrefix: "Multi-active step",
                        statuses: ["inProgress", "inProgress", "pending"],
                      }),
                    );
                    setControlNote("Loaded a plan with two active steps.");
                  }}
                >
                  Multiple active steps
                </FixtureButton>
                <FixtureButton
                  onClick={() => {
                    updateActiveThread(appendHistoricalAndOtherGroups);
                    setControlNote("Appended historical-step and Other activity workers.");
                  }}
                >
                  Historical + Other
                </FixtureButton>
                <FixtureButton
                  onClick={() => {
                    updateActiveThread((thread) => appendTranscriptRows(thread, 80));
                    setControlNote("Appended 80 deterministic message rows for virtualization.");
                  }}
                >
                  Add 80 transcript rows
                </FixtureButton>
                <FixtureButton
                  onClick={() => {
                    updateActiveThread(removeWorkflowCard);
                    setControlNote(
                      "Removed all active-turn workflow activity while preserving the transcript.",
                    );
                  }}
                >
                  Remove card
                </FixtureButton>
              </div>
            </ControlGroup>

            <ControlGroup title="Disclosures and scroll">
              <div className="grid grid-cols-2 gap-1.5">
                <FixtureButton onClick={() => setPinnedGroupExpanded(true)}>
                  Expand pinned card
                </FixtureButton>
                <FixtureButton onClick={() => setPinnedGroupExpanded(false)}>
                  Collapse pinned card
                </FixtureButton>
                <FixtureButton onClick={() => setPinnedProgressExpanded(true)}>
                  Expand pinned progress
                </FixtureButton>
                <FixtureButton onClick={() => setPinnedProgressExpanded(false)}>
                  Collapse pinned progress
                </FixtureButton>
                <FixtureButton onClick={() => setTaskDisclosureExpanded(true)}>
                  Expand task card
                </FixtureButton>
                <FixtureButton onClick={() => setTaskDisclosureExpanded(false)}>
                  Collapse task card
                </FixtureButton>
                <FixtureButton onClick={() => driveScrollMode("following-end")}>
                  Following end
                </FixtureButton>
                <FixtureButton onClick={() => driveScrollMode("anchoring-new-turn")}>
                  Anchor new turn
                </FixtureButton>
                <FixtureButton onClick={() => driveScrollMode("free-scrolling")}>
                  Free scrolling
                </FixtureButton>
              </div>
            </ControlGroup>
          </div>
        </aside>

        <main className="min-h-0 min-w-0 bg-background p-2 sm:p-3">
          <section className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-card/20">
            <div className="max-h-20 shrink-0 overflow-y-auto border-b border-border/70 bg-muted/20 p-2">
              <dl className="grid grid-cols-4 gap-1.5 max-[1180px]:grid-cols-3 max-[720px]:grid-cols-2">
                <Metric label="Thread" value={activeThread.label} />
                <Metric label="Turn" value={activeThread.turnId} />
                <Metric label="Scroll mode" value={scrollMode} />
                <Metric label="At end" value={isAtEnd ? "yes" : "no"} />
                <Metric label="Activities" value={activeThread.activities.length} />
                <Metric
                  label="Transcript / rows"
                  value={`${activeThread.messages.length} / ${observableRows.length}`}
                />
                <Metric
                  label="Work / task rows"
                  value={`${workEntries.length} / ${taskTimelineRowCount}`}
                />
                <Metric label="Rendered task cards" value={domSnapshot.renderedTaskCards} />
                <Metric label="Selected task" value={activeThread.selectedTaskId ?? "none"} />
                <Metric label="Lifecycle" value={selectedTaskStatus ?? "none"} />
                <Metric
                  label="Stable row id"
                  value={selectedTaskRowIds.join(", ") || "not visible"}
                />
                <Metric
                  label="Usage"
                  value={
                    selectedTask?.usage
                      ? `${selectedTask.usage.totalTokens ?? "–"} tok · ${selectedTask.usage.toolUses ?? "–"} tools · ${selectedTask.usage.durationMs ?? "–"} ms`
                      : "none"
                  }
                />
                <Metric
                  label="Explicit values"
                  value={`${selectedTask?.skipTranscript === false ? "false" : "missing"} / ${selectedTask?.usage?.totalTokens ?? "missing"} tok / ${selectedTask?.usage?.toolUses ?? "missing"} tools / ${selectedTask?.usage?.durationMs ?? "missing"} ms / parent ${hasExplicitNullParent ? "null" : "missing"}`}
                />
                <Metric
                  label="Recent tool"
                  value={`${domSnapshot.recentToolRows} row · ${fixtureRecentTool?.id ?? "none"} · ${fixtureRecentTool?.status ?? "none"} · aria ${domSnapshot.recentToolStatuses.join(", ") || "none"}`}
                />
                <Metric
                  label="Plan / active"
                  value={`${workflowModel?.steps.length ?? 0} / ${activeStepCount}`}
                />
                <Metric
                  label="Historical / Other"
                  value={`${workflowModel?.historicalSteps.length ?? 0} / ${workflowModel?.otherActivity?.workers.length ?? 0}`}
                />
                <Metric
                  label="Reasoning"
                  value={`${workflowModel?.reasoningSummary ? "present" : "absent"} / ${domSnapshot.reasoningExpanded ? "open" : "closed"}`}
                />
                <Metric label="skipTranscript workers" value={hiddenTranscriptTaskCount} />
                <Metric
                  label="Pinned disclosure"
                  value={`${domSnapshot.pinnedGroupExpanded ? "open" : "closed"} · progress ${domSnapshot.pinnedProgressExpanded ? "open" : "closed"}`}
                />
                <Metric
                  label="Task disclosure"
                  value={
                    activeThread.selectedTaskId &&
                    domSnapshot.expandedTaskIds.includes(activeThread.selectedTaskId)
                      ? "open"
                      : "closed"
                  }
                />
                <Metric
                  label="Card height"
                  value={`${cardTelemetry.height}px · Δ${cardTelemetry.heightDelta}px`}
                />
                <Metric
                  label="Compensation"
                  value={`${cardTelemetry.compensation} #${cardTelemetry.eventCount}`}
                />
                <Metric label="Card owner" value={cardTelemetry.ownerKey || "none"} />
                <Metric
                  label="Anchor"
                  value={
                    anchorMessageId
                      ? `${anchorIndex ?? "pending"} / ${anchorSize ?? "?"}px`
                      : "none"
                  }
                />
                <Metric
                  label="Minimap"
                  value={`${domSnapshot.minimapPresent ? "present" : "absent"} / bottom ${domSnapshot.minimapBottomInset}`}
                />
                <Metric label="Composer inset" value={`${FIXTURE_COMPOSER_INSET_PX}px`} />
                <Metric label="Scroll affordance" value={isAtEnd ? "hidden" : "visible"} />
              </dl>
              <p
                className="mt-1.5 truncate text-[11px] text-muted-foreground"
                aria-live="polite"
                title={controlNote}
              >
                {controlNote}
              </p>
            </div>

            <div className="relative flex min-h-0 min-w-0 flex-1 flex-col" data-fixture-chat-column>
              {workflowModel ? (
                <WorkflowActivityCard
                  key={timelineOwnerKey}
                  model={workflowModel}
                  defaultOpen
                  onHeightChange={handleCardHeightChange}
                />
              ) : null}
              <div className="relative min-h-0 flex-1" data-fixture-virtualized-timeline>
                <MessagesTimeline
                  key={activeThread.id}
                  isWorking={false}
                  activeTurnInProgress
                  activeTurnStartedAt={latestTurn.startedAt}
                  listRef={listRef}
                  timelineEntries={timelineEntries}
                  latestTurn={latestTurn}
                  runningTurnId={activeThread.turnId}
                  turnDiffSummaryByAssistantMessageId={EMPTY_TURN_DIFFS}
                  routeThreadKey={`${FIXTURE_ENVIRONMENT_ID}:${activeThread.id}`}
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
                  anchorMessageId={anchorMessageId}
                  onAnchorReady={(messageId, nextAnchorIndex) => {
                    if (messageId !== anchorMessageId) return;
                    activeAnchorIndexRef.current = nextAnchorIndex;
                    setAnchorIndex(nextAnchorIndex);
                  }}
                  onAnchorSizeChanged={(messageId, size) => {
                    if (messageId === anchorMessageId) setAnchorSize(size);
                  }}
                  contentInsetEndAdjustment={FIXTURE_COMPOSER_INSET_PX}
                  onIsAtEndChange={(nextIsAtEnd) => {
                    setIsAtEnd(scrollModeRef.current === "free-scrolling" ? false : nextIsAtEnd);
                  }}
                  onManualNavigation={() => driveScrollMode("free-scrolling")}
                />
                {!isAtEnd ? (
                  <div
                    className="pointer-events-none absolute left-1/2 z-30 flex -translate-x-1/2 justify-center py-1.5"
                    style={{ bottom: FIXTURE_COMPOSER_INSET_PX + 4 }}
                  >
                    <button
                      type="button"
                      aria-label="Scroll to end"
                      title="Scroll to end"
                      data-fixture-scroll-to-end
                      onClick={() => driveScrollMode("following-end")}
                      className="pointer-events-auto cursor-pointer rounded-full border border-border/60 bg-card px-3 py-1 text-xs text-muted-foreground shadow-sm transition-colors hover:border-border hover:text-foreground"
                    >
                      Scroll to end
                    </button>
                  </div>
                ) : null}
              </div>
              <div
                aria-label={`Synthetic composer inset ${FIXTURE_COMPOSER_INSET_PX} pixels`}
                data-fixture-composer
                className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex items-center justify-center border-t border-border/60 bg-card/90 text-[11px] text-muted-foreground backdrop-blur-sm"
                style={{ height: FIXTURE_COMPOSER_INSET_PX }}
              >
                Synthetic composer inset · {FIXTURE_COMPOSER_INSET_PX}px
              </div>
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}
