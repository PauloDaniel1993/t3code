import { Fragment, memo, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  ActivityIcon,
  BotIcon,
  CheckIcon,
  ChevronDownIcon,
  FileSearchIcon,
  GlobeIcon,
  HistoryIcon,
  LoaderIcon,
  SquarePenIcon,
  TerminalIcon,
  WrenchIcon,
} from "lucide-react";

import { cn } from "~/lib/utils";
import { formatContextWindowTokens } from "../lib/contextWindow";
import { formatDuration, type WorkLogToolLifecycleStatus } from "../session-logic";
import type {
  WorkflowActivityModel,
  WorkflowActivityWorker,
  WorkflowPlanStepStatus,
  WorkflowRecentTool,
} from "../workflow-activity";
import { resolveWorkflowCardExpandedMaxHeight } from "./chat/timelineScrollAnchoring";
import { Badge } from "./ui/badge";

// ---------------------------------------------------------------------------
// Pure helpers (exported for focused tests)
// ---------------------------------------------------------------------------

export interface WorkflowActivitySelectionGroup {
  readonly id: string;
  readonly label: string;
  readonly status?: WorkflowPlanStepStatus;
  readonly historical?: boolean;
  readonly workers: ReadonlyArray<WorkflowActivityWorker>;
}

export interface WorkflowMetricSegment {
  readonly id: "tokens" | "tools" | "duration" | "lastTool";
  readonly text: string;
}

/**
 * Ordered selectable groups for the plan layout: current plan steps first,
 * then steps carried from an earlier plan snapshot, then the "Other activity"
 * group for workers that started without an active step.
 */
export function deriveWorkflowSelectionGroups(
  model: WorkflowActivityModel,
): WorkflowActivitySelectionGroup[] {
  const groups: WorkflowActivitySelectionGroup[] = [];
  for (const step of model.steps) {
    groups.push({
      id: step.id,
      label: step.label,
      status: step.status,
      workers: step.workers,
    });
  }
  for (const step of model.historicalSteps) {
    groups.push({
      id: step.id,
      label: step.label,
      status: step.status,
      historical: true,
      workers: step.workers,
    });
  }
  if (model.otherActivity && model.otherActivity.workers.length > 0) {
    groups.push({
      id: model.otherActivity.id,
      label: model.otherActivity.label,
      workers: model.otherActivity.workers,
    });
  }
  return groups;
}

/** Local step selection, tagged with the turn it was made under. */
export interface WorkflowStepSelection {
  readonly turnId: string;
  readonly stepId: string;
}

/**
 * Selection never leaks into a replacement turn: it only resolves while the
 * model's turn identity matches the turn the selection was made under. ChatView
 * additionally remounts the card on thread/turn replacement, so this resolver
 * is the in-component guarantee that a stale selection cannot dangle.
 */
export function resolveTurnScopedSelectedStepId(
  selection: WorkflowStepSelection | null,
  turnId: string,
): string | null {
  return selection !== null && selection.turnId === turnId ? selection.stepId : null;
}

/** Click toggles: same step clears, a different step switches the inline region. */
export function resolveNextWorkflowStepSelection(
  currentStepId: string | null,
  clickedStepId: string,
): string | null {
  return currentStepId === clickedStepId ? null : clickedStepId;
}

/** Stale selections (step vanished from a replaced plan) collapse instead of dangling. */
export function resolveSelectedWorkflowGroup(
  groups: ReadonlyArray<WorkflowActivitySelectionGroup>,
  selectedStepId: string | null,
): WorkflowActivitySelectionGroup | null {
  if (selectedStepId === null) {
    return null;
  }
  return groups.find((group) => group.id === selectedStepId) ?? null;
}

/** Overall step counter: "Step 2 of 4" while a step is active, otherwise a completion tally. */
export function deriveWorkflowStepCounter(
  steps: ReadonlyArray<Pick<WorkflowActivityModel["steps"][number], "status">>,
): string {
  const total = steps.length;
  const activeIndex = steps.findIndex((step) => step.status === "inProgress");
  if (activeIndex >= 0) {
    return `Step ${activeIndex + 1} of ${total}`;
  }
  const completed = steps.filter((step) => step.status === "completed").length;
  return `${completed} of ${total} complete`;
}

/** Compact usage segments; only values the provider actually supplied, never placeholders. */
export function deriveUsageMetricSegments(usage: {
  readonly totalTokens?: number | undefined;
  readonly toolUses?: number | undefined;
  readonly durationMs?: number | undefined;
}): WorkflowMetricSegment[] {
  const segments: WorkflowMetricSegment[] = [];
  if (usage.totalTokens !== undefined) {
    segments.push({
      id: "tokens",
      text: `${formatContextWindowTokens(usage.totalTokens)} tokens`,
    });
  }
  if (usage.toolUses !== undefined) {
    segments.push({
      id: "tools",
      text: `${usage.toolUses} ${usage.toolUses === 1 ? "tool" : "tools"}`,
    });
  }
  if (usage.durationMs !== undefined) {
    segments.push({ id: "duration", text: formatDuration(usage.durationMs) });
  }
  return segments;
}

export function deriveWorkerMetricSegments(
  worker: Pick<WorkflowActivityWorker, "usage" | "lastToolName">,
): WorkflowMetricSegment[] {
  const segments = worker.usage ? deriveUsageMetricSegments(worker.usage) : [];
  if (worker.lastToolName) {
    segments.push({ id: "lastTool", text: `Last: ${worker.lastToolName}` });
  }
  return segments;
}

/** Card title: workflow name when the provider supplied one, else a generic heading. */
export function deriveWorkflowCardTitle(model: WorkflowActivityModel): string {
  if (model.steps.length === 0) {
    return "Activity";
  }
  const workflowName = model.workers.find((worker) => worker.workflowName)?.workflowName;
  return workflowName ?? "Workflow";
}

// ---------------------------------------------------------------------------
// Presentation constants
// ---------------------------------------------------------------------------

const WORKER_STATUS_META: Record<
  WorkLogToolLifecycleStatus,
  {
    readonly label: string;
    readonly variant: "info" | "success" | "error" | "warning" | "secondary";
  }
> = {
  inProgress: { label: "Running", variant: "info" },
  completed: { label: "Completed", variant: "success" },
  failed: { label: "Failed", variant: "error" },
  declined: { label: "Declined", variant: "warning" },
  stopped: { label: "Stopped", variant: "secondary" },
};

const STEP_STATUS_SR_LABEL: Record<WorkflowPlanStepStatus, string> = {
  pending: "Pending",
  inProgress: "In progress",
  completed: "Completed",
};

const DISCLOSURE_BUTTON_CLASS =
  "flex cursor-pointer select-none items-center gap-1 rounded-md px-1 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70";

function stepStripSegmentClass(status: WorkflowPlanStepStatus): string {
  if (status === "completed") {
    return "bg-success/70";
  }
  if (status === "inProgress") {
    return "bg-primary/70 motion-safe:animate-pulse";
  }
  return "bg-muted-foreground/20";
}

function WorkflowStepStatusIcon({
  status,
}: {
  readonly status?: WorkflowPlanStepStatus | undefined;
}) {
  if (status === "completed") {
    return (
      <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-success/10 text-success-foreground">
        <CheckIcon className="size-2.5" aria-hidden />
      </span>
    );
  }
  if (status === "inProgress") {
    return (
      <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
        <LoaderIcon className="size-2.5 animate-spin" aria-hidden />
      </span>
    );
  }
  if (status === "pending") {
    return (
      <span className="flex size-4 shrink-0 items-center justify-center rounded-full border border-border/60 bg-muted/30">
        <span className="size-1 rounded-full bg-muted-foreground/30" />
      </span>
    );
  }
  return (
    <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground/60">
      <ActivityIcon className="size-3" aria-hidden />
    </span>
  );
}

function WorkflowGroupIcon({ group }: { readonly group: WorkflowActivitySelectionGroup }) {
  if (group.historical) {
    return (
      <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground/60">
        <HistoryIcon className="size-3" aria-hidden />
      </span>
    );
  }
  return <WorkflowStepStatusIcon status={group.status} />;
}

function recentToolIcon(toolName: string | undefined) {
  switch (toolName) {
    case "Bash":
    case "Terminal":
      return TerminalIcon;
    case "Read":
    case "Grep":
    case "Glob":
      return FileSearchIcon;
    case "Edit":
    case "Write":
    case "NotebookEdit":
      return SquarePenIcon;
    case "WebFetch":
    case "WebSearch":
      return GlobeIcon;
    case "Task":
      return BotIcon;
    default:
      return WrenchIcon;
  }
}

// ---------------------------------------------------------------------------
// Leaf components
// ---------------------------------------------------------------------------

function WorkflowDisclosureBody({
  id,
  text,
  className,
}: {
  readonly id: string;
  readonly text: string;
  readonly className?: string;
}) {
  return (
    <div
      id={id}
      className={cn("mt-1 overflow-y-auto rounded-md bg-muted/30 px-2 py-1.5", className)}
    >
      {/* Provider text renders as a plain text node — always escaped by React. */}
      <p className="whitespace-pre-wrap break-words text-xs leading-5 text-muted-foreground">
        {text}
      </p>
    </div>
  );
}

function WorkflowWorkerCard({
  worker,
  idPrefix,
}: {
  readonly worker: WorkflowActivityWorker;
  readonly idPrefix: string;
}) {
  const [progressOpen, setProgressOpen] = useState(false);
  const statusMeta = WORKER_STATUS_META[worker.status] ?? WORKER_STATUS_META.inProgress;
  const metrics = deriveWorkerMetricSegments(worker);
  const label = worker.description ?? worker.subagentType ?? worker.taskType ?? "Task";
  const progressRegionId = `${idPrefix}-progress-${worker.taskId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;

  return (
    <article
      className="min-w-0 rounded-md border border-border/60 bg-background/60 px-2 py-1.5"
      data-slot="workflow-worker-card"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <Badge variant={statusMeta.variant} size="sm">
          {statusMeta.label}
        </Badge>
        <p className="min-w-0 flex-1 break-words text-xs font-medium text-foreground/85">{label}</p>
        {metrics.length > 0 ? (
          <p className="flex flex-wrap items-center gap-x-1.5 text-[11px] tabular-nums text-muted-foreground/60">
            {metrics.map((segment, index) => (
              <Fragment key={segment.id}>
                {index > 0 ? <span aria-hidden="true">·</span> : null}
                <span>{segment.text}</span>
              </Fragment>
            ))}
          </p>
        ) : null}
      </div>
      {worker.resultSummary ? (
        <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-5 text-muted-foreground">
          <span className="font-medium text-foreground/70">Result: </span>
          {worker.resultSummary}
        </p>
      ) : null}
      {worker.outputFile ? (
        <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground/60">
          Output: {worker.outputFile}
        </p>
      ) : null}
      {worker.progressSummary ? (
        <div className="mt-1">
          <button
            type="button"
            aria-expanded={progressOpen}
            aria-controls={progressOpen ? progressRegionId : undefined}
            onClick={() => setProgressOpen((open) => !open)}
            className={DISCLOSURE_BUTTON_CLASS}
          >
            <ChevronDownIcon
              className={cn(
                "size-3.5 opacity-70 transition-transform duration-200",
                progressOpen && "rotate-180",
              )}
              aria-hidden
            />
            <span>Progress</span>
          </button>
          {progressOpen ? (
            <WorkflowDisclosureBody
              id={progressRegionId}
              text={worker.progressSummary}
              className="max-h-40"
            />
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function WorkflowRecentToolRow({ tool }: { readonly tool: WorkflowRecentTool }) {
  const linkedToTask =
    tool.taskId !== undefined ||
    (tool.parentToolUseId !== undefined && tool.parentToolUseId !== null);
  const Icon = recentToolIcon(tool.toolName);

  return (
    <li
      className="flex min-w-0 items-center gap-1.5 rounded-md px-0.5 py-0.5 text-xs leading-5"
      data-slot="workflow-recent-tool"
    >
      <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground/60">
        <Icon className="size-3" aria-hidden />
      </span>
      <span className="shrink-0 font-medium text-foreground/80">{tool.toolName ?? "Tool"}</span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground/55">{tool.summary ?? ""}</span>
      {linkedToTask ? (
        <Badge variant="secondary" size="sm">
          task
        </Badge>
      ) : null}
      {tool.elapsedSeconds !== undefined ? (
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/55">
          {formatDuration(tool.elapsedSeconds * 1000)}
        </span>
      ) : null}
      <span
        className="flex size-4 shrink-0 items-center justify-center"
        role="img"
        aria-label="Running"
      >
        <LoaderIcon className="size-3 animate-spin text-muted-foreground/60" aria-hidden />
      </span>
    </li>
  );
}

// ---------------------------------------------------------------------------
// WorkflowActivityCard — pinned above the message timeline (Option F)
// ---------------------------------------------------------------------------

export const WorkflowActivityCard = memo(function WorkflowActivityCard({
  model,
  onHeightChange,
}: {
  readonly model: WorkflowActivityModel;
  /**
   * Reports the card's settled outer height (integer px) whenever it changes,
   * and 0 when the card renders nothing. ChatView uses the deltas to apply
   * explicit per-mode scroll compensation on the timeline below.
   */
  readonly onHeightChange?: ((height: number) => void) | undefined;
}) {
  const reactId = useId();
  const idPrefix = `workflow-activity-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const workerRegionId = `${idPrefix}-workers`;
  const reasoningRegionId = `${idPrefix}-reasoning`;

  const [selection, setSelection] = useState<WorkflowStepSelection | null>(null);
  const [reasoningOpen, setReasoningOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [chatColumnHeight, setChatColumnHeight] = useState(0);

  // The card is a layout sibling above the virtualized timeline: expanding it
  // shrinks the list viewport. Measure the chat column so expanded content is
  // bounded on short viewports and scrolls internally instead of crowding the
  // timeline out (LegendList re-anchors itself on the resulting layout change).
  useEffect(() => {
    const column = rootRef.current?.parentElement;
    if (!column || typeof ResizeObserver === "undefined") {
      return;
    }
    const measure = () => {
      const nextHeight = Math.floor(column.getBoundingClientRect().height);
      setChatColumnHeight((current) => (current === nextHeight ? current : nextHeight));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(column);
    return () => observer.disconnect();
  }, []);

  const hasPlan = model.steps.length > 0;
  const hasRenderableContent =
    model.workers.length > 0 ||
    model.recentTools.length > 0 ||
    model.reasoningSummary !== undefined ||
    hasPlan;

  // Report the card's own settled height so the timeline can compensate each
  // LegendList scroll mode explicitly. Re-runs when content appears or
  // disappears (the root element only exists while content renders).
  useEffect(() => {
    if (!onHeightChange) {
      return;
    }
    const root = rootRef.current;
    if (!root) {
      onHeightChange(0);
      return;
    }
    let lastReportedHeight = -1;
    const measure = () => {
      const nextHeight = Math.round(root.getBoundingClientRect().height);
      if (nextHeight === lastReportedHeight) {
        return;
      }
      lastReportedHeight = nextHeight;
      onHeightChange(nextHeight);
    };
    // Always report the initial settled height, even where ResizeObserver is
    // unavailable — the mount delta is what restores following-end positioning.
    measure();
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, [hasRenderableContent, onHeightChange]);

  const groups = useMemo(() => deriveWorkflowSelectionGroups(model), [model]);
  const selectedStepId = resolveTurnScopedSelectedStepId(selection, model.turnId);
  const selectedGroup = resolveSelectedWorkflowGroup(groups, selectedStepId);
  const expandedMaxHeight = resolveWorkflowCardExpandedMaxHeight(chatColumnHeight);

  if (!hasRenderableContent) {
    return null;
  }

  const title = deriveWorkflowCardTitle(model);
  const counter = hasPlan ? deriveWorkflowStepCounter(model.steps) : null;
  const totalUsageSegments = model.totalUsage ? deriveUsageMetricSegments(model.totalUsage) : [];

  return (
    <div
      ref={rootRef}
      className="chat-composer-horizontal-inset shrink-0 pt-2 sm:pt-3"
      data-slot="workflow-activity-card"
    >
      <section
        aria-label={hasPlan ? "Workflow activity" : "Task activity"}
        className="mx-auto w-full min-w-0 max-w-3xl rounded-lg border border-border/80 bg-card/45 px-2.5 py-2"
      >
        {/* Heading + counter + aggregate usage */}
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 px-0.5">
          <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground/60">
            {title}
          </p>
          {counter ? (
            <span className="text-[11px] tabular-nums text-muted-foreground/60">{counter}</span>
          ) : null}
          {totalUsageSegments.length > 0 ? (
            <p className="ms-auto flex flex-wrap items-center gap-x-1.5 text-[11px] tabular-nums text-muted-foreground/60">
              {totalUsageSegments.map((segment, index) => (
                <Fragment key={segment.id}>
                  {index > 0 ? <span aria-hidden="true">·</span> : null}
                  <span>{segment.text}</span>
                </Fragment>
              ))}
            </p>
          ) : null}
        </div>

        {/* Segmented progress strip (decorative — the step buttons carry status) */}
        {hasPlan ? (
          <div className="mt-1.5 flex gap-0.5 px-0.5" aria-hidden="true">
            {model.steps.map((step) => (
              <span
                key={step.id}
                data-slot="workflow-step-strip-segment"
                className={cn(
                  "h-1 min-w-2 flex-1 rounded-full",
                  stepStripSegmentClass(step.status),
                )}
              />
            ))}
          </div>
        ) : null}

        {/* Clickable step labels */}
        {hasPlan ? (
          <ul className="mt-1 space-y-px">
            {groups.map((group) => {
              const isSelected = selectedGroup?.id === group.id;
              return (
                <li key={group.id}>
                  <button
                    type="button"
                    aria-expanded={isSelected}
                    aria-controls={isSelected ? workerRegionId : undefined}
                    onClick={() =>
                      setSelection((current) => {
                        const nextStepId = resolveNextWorkflowStepSelection(
                          resolveTurnScopedSelectedStepId(current, model.turnId),
                          group.id,
                        );
                        return nextStepId === null
                          ? null
                          : { turnId: model.turnId, stepId: nextStepId };
                      })
                    }
                    className="flex w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs leading-5 transition-colors duration-150 hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
                  >
                    <WorkflowGroupIcon group={group} />
                    <span className="min-w-0 flex-1 truncate font-medium text-foreground/80">
                      {group.label}
                      {group.status ? (
                        <span className="sr-only"> ({STEP_STATUS_SR_LABEL[group.status]})</span>
                      ) : null}
                    </span>
                    {group.historical ? (
                      <span className="shrink-0 text-[11px] text-muted-foreground/55">
                        earlier plan
                      </span>
                    ) : null}
                    {group.workers.length > 0 ? (
                      <span className="shrink-0 tabular-nums text-[11px] text-muted-foreground/55">
                        {group.workers.length}
                      </span>
                    ) : null}
                    <ChevronDownIcon
                      className={cn(
                        "size-3.5 shrink-0 opacity-70 transition-transform duration-200",
                        isSelected && "rotate-180",
                      )}
                      aria-hidden
                    />
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}

        {/* Inline worker region — expands below a separator inside the same container */}
        {hasPlan && selectedGroup ? (
          <div id={workerRegionId} className="mt-1.5 border-t border-border/60 pt-1.5">
            <div
              className="space-y-1.5 overflow-y-auto pe-0.5"
              style={{ maxHeight: expandedMaxHeight }}
            >
              {selectedGroup.workers.length > 0 ? (
                selectedGroup.workers.map((worker) => (
                  <WorkflowWorkerCard key={worker.id} worker={worker} idPrefix={idPrefix} />
                ))
              ) : (
                <p className="px-0.5 py-1 text-xs text-muted-foreground/60">
                  No workers for this step yet.
                </p>
              )}
            </div>
          </div>
        ) : null}

        {/* Plan-less layout: workers listed directly under the Activity heading */}
        {!hasPlan && model.workers.length > 0 ? (
          <div
            className="mt-1.5 space-y-1.5 overflow-y-auto pe-0.5"
            style={{ maxHeight: expandedMaxHeight }}
          >
            {model.workers.map((worker) => (
              <WorkflowWorkerCard key={worker.id} worker={worker} idPrefix={idPrefix} />
            ))}
          </div>
        ) : null}

        {/* Turn-level provider reasoning summary — collapsed by default */}
        {model.reasoningSummary ? (
          <div className="mt-1.5 border-t border-border/60 pt-1.5">
            <button
              type="button"
              aria-expanded={reasoningOpen}
              aria-controls={reasoningOpen ? reasoningRegionId : undefined}
              onClick={() => setReasoningOpen((open) => !open)}
              className={DISCLOSURE_BUTTON_CLASS}
            >
              <ChevronDownIcon
                className={cn(
                  "size-3.5 opacity-70 transition-transform duration-200",
                  reasoningOpen && "rotate-180",
                )}
                aria-hidden
              />
              <span>Reasoning</span>
            </button>
            {reasoningOpen ? (
              <WorkflowDisclosureBody
                id={reasoningRegionId}
                text={model.reasoningSummary}
                className="max-h-48"
              />
            ) : null}
          </div>
        ) : null}

        {/* Bounded compact recent tools */}
        {model.recentTools.length > 0 ? (
          <div className="mt-1.5 border-t border-border/60 pt-1.5">
            <p className="px-0.5 pb-1 text-[10px] uppercase tracking-[0.12em] text-muted-foreground/60">
              Recent tools
            </p>
            <ul className="space-y-px">
              {model.recentTools.map((tool) => (
                <WorkflowRecentToolRow key={tool.id} tool={tool} />
              ))}
            </ul>
          </div>
        ) : null}
      </section>
    </div>
  );
});
