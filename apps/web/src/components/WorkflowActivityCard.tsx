import { Fragment, memo, useId, useMemo, useState } from "react";
import {
  ActivityIcon,
  BotIcon,
  CheckIcon,
  ChevronDownIcon,
  FileSearchIcon,
  GlobeIcon,
  HistoryIcon,
  LoaderIcon,
  SquareIcon,
  SquarePenIcon,
  TerminalIcon,
  WrenchIcon,
  XIcon,
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

export function deriveWorkflowEmptyWorkersMessage(
  status: WorkflowPlanStepStatus | undefined,
): string {
  return status === "completed"
    ? "No workers were used for this step."
    : "No workers for this step yet.";
}

/**
 * Ordered selectable groups for the plan layout: current plan steps first,
 * then steps carried from an earlier plan snapshot, then the "Other activity"
 * group for workers that started without an active step.
 */
export function deriveWorkflowSelectionGroups(
  model: WorkflowActivityModel,
): WorkflowActivitySelectionGroup[] {
  const activeStep = model.steps.find((step) => step.status === "inProgress");
  const unassociatedWorkers = model.otherActivity?.workers ?? [];
  const attachUnassociatedToActiveStep = activeStep !== undefined && unassociatedWorkers.length > 0;
  const groups: WorkflowActivitySelectionGroup[] = [];
  for (const step of model.steps) {
    groups.push({
      id: step.id,
      label: step.label,
      status: step.status,
      workers:
        attachUnassociatedToActiveStep && step.id === activeStep.id
          ? [...step.workers, ...unassociatedWorkers]
          : step.workers,
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

function WorkflowRecentToolStatus({ status }: { readonly status: WorkLogToolLifecycleStatus }) {
  const statusMeta = WORKER_STATUS_META[status];
  const StatusIcon =
    status === "inProgress"
      ? LoaderIcon
      : status === "completed"
        ? CheckIcon
        : status === "stopped"
          ? SquareIcon
          : XIcon;
  return (
    <Badge variant={statusMeta.variant} size="sm" aria-label={statusMeta.label}>
      <StatusIcon className={cn("size-3", status === "inProgress" && "animate-spin")} aria-hidden />
      {statusMeta.label}
    </Badge>
  );
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

function WorkflowTextDisclosure({
  id,
  label,
  text,
  bodyClassName,
  toggleSlot,
}: {
  readonly id: string;
  readonly label: string;
  readonly text: string;
  readonly bodyClassName?: string;
  readonly toggleSlot: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="mt-1">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((current) => !current)}
        className={DISCLOSURE_BUTTON_CLASS}
        data-slot={toggleSlot}
      >
        <ChevronDownIcon
          className={cn(
            "size-3.5 opacity-70 transition-transform duration-200",
            open && "rotate-180",
          )}
          aria-hidden
        />
        <span>{label}</span>
      </button>
      {open ? (
        <WorkflowDisclosureBody
          id={id}
          text={text}
          {...(bodyClassName !== undefined ? { className: bodyClassName } : {})}
        />
      ) : null}
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
  const statusMeta = WORKER_STATUS_META[worker.status] ?? WORKER_STATUS_META.inProgress;
  const metrics = deriveWorkerMetricSegments(worker);
  const label = worker.description ?? worker.subagentType ?? worker.taskType ?? "Task";
  const safeTaskId = worker.taskId.replace(/[^a-zA-Z0-9_-]/g, "-");
  const progressRegionId = `${idPrefix}-progress-${safeTaskId}`;
  const resultRegionId = `${idPrefix}-result-${safeTaskId}`;
  const agentReference = (taskId: string) =>
    `agent ${taskId.length > 16 ? taskId.slice(0, 8) : taskId}`;

  return (
    <article
      className="min-w-0 rounded-md border border-border/60 bg-background/60 px-2 py-1.5"
      data-slot="workflow-worker-card"
      // The sidebar's in-session agent rows locate a run here ("Show in
      // transcript"): the provider's task id is the shared key.
      data-native-agent-task-id={worker.taskId}
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
      {worker.progressSummary ? (
        <WorkflowTextDisclosure
          id={progressRegionId}
          label="Progress"
          text={worker.progressSummary}
          bodyClassName="max-h-40"
          toggleSlot="workflow-worker-progress-toggle"
        />
      ) : null}
      {worker.errorMessage ? (
        <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-5 text-destructive">
          <span className="font-medium">Error: </span>
          {worker.errorMessage}
        </p>
      ) : null}
      {worker.resultSummary ? (
        <WorkflowTextDisclosure
          id={resultRegionId}
          label="Result"
          text={worker.resultSummary}
          bodyClassName="max-h-48"
          toggleSlot="workflow-worker-result-toggle"
        />
      ) : null}
      {worker.retriedByTaskId ? (
        <p className="mt-1 text-[11px] text-muted-foreground/70">
          Retried by{" "}
          <span className="font-medium text-foreground/70" title={worker.retriedByTaskId}>
            {agentReference(worker.retriedByTaskId)}
          </span>
        </p>
      ) : worker.retryOfTaskId ? (
        <p className="mt-1 text-[11px] text-muted-foreground/70">
          Retry of{" "}
          <span className="font-medium text-foreground/70" title={worker.retryOfTaskId}>
            {agentReference(worker.retryOfTaskId)}
          </span>
        </p>
      ) : null}
      {worker.outputFile ? (
        <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground/60">
          Output: {worker.outputFile}
        </p>
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
      <WorkflowRecentToolStatus status={tool.status} />
    </li>
  );
}

// ---------------------------------------------------------------------------
// WorkflowActivityCard — always-expanded inline turn activity card
// ---------------------------------------------------------------------------

/**
 * The card renders inline in the transcript, so its outer height must never
 * change after first mount: LegendList keeps the reader's position stable
 * across data changes but not across row resizes, and a growing card would
 * shove the transcript under the reader. The box is therefore fixed at the
 * height cap from the start; every region below the header lives inside the
 * box's own scroll, so arriving workers, steps, and tool rows scroll within
 * it instead of resizing it.
 */
export const WorkflowActivityCard = memo(function WorkflowActivityCard({
  model,
}: {
  readonly model: WorkflowActivityModel;
}) {
  const reactId = useId();
  const idPrefix = `workflow-activity-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const reasoningRegionId = `${idPrefix}-reasoning`;
  const [reasoningOpen, setReasoningOpen] = useState(false);

  const hasPlan = model.steps.length > 0;
  const hasRenderableContent =
    model.workers.length > 0 ||
    model.recentTools.length > 0 ||
    model.reasoningSummary !== undefined ||
    hasPlan;
  const groups = useMemo(() => deriveWorkflowSelectionGroups(model), [model]);

  if (!hasRenderableContent) {
    return null;
  }

  const title = deriveWorkflowCardTitle(model);
  const counter = hasPlan ? deriveWorkflowStepCounter(model.steps) : null;
  const totalUsageSegments = model.totalUsage ? deriveUsageMetricSegments(model.totalUsage) : [];

  return (
    <div
      className="min-w-0 py-2"
      data-slot="workflow-activity-card"
      data-workflow-activity-turn-id={model.turnId}
    >
      <section
        aria-label={hasPlan ? "Workflow activity" : "Task activity"}
        className="mx-auto flex w-full min-w-0 max-w-3xl flex-col rounded-lg border border-border/80 bg-card/45 px-2.5 py-2"
        style={{ height: "min(26rem, 55vh)" }}
      >
        <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 px-0.5">
          <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground/60">
            {title}
          </p>
          {counter ? (
            <span className="text-[11px] tabular-nums text-muted-foreground/60">{counter}</span>
          ) : null}
          {model.workers.length > 0 ? (
            <span className="text-[11px] tabular-nums text-muted-foreground/60">
              {model.workers.length} {model.workers.length === 1 ? "worker" : "workers"}
            </span>
          ) : null}
          {totalUsageSegments.length > 0 ? (
            <p className="ms-auto flex min-w-0 flex-wrap items-center justify-end gap-x-1.5 text-[11px] tabular-nums text-muted-foreground/60">
              {totalUsageSegments.map((segment, index) => (
                <Fragment key={segment.id}>
                  {index > 0 ? <span aria-hidden="true">·</span> : null}
                  <span>{segment.text}</span>
                </Fragment>
              ))}
            </p>
          ) : null}
        </div>

        {/* Everything below the header lives inside the card's own scroll, so
            arriving workers, steps, and tool rows never resize the box. */}
        <div
          className="mt-1.5 min-h-0 flex-1 overflow-y-auto overscroll-contain pe-0.5"
          data-slot="workflow-activity-details"
        >
          {/* Segmented progress strip (decorative — the step headers carry status) */}
          {hasPlan ? (
            <div className="flex gap-0.5 px-0.5" aria-hidden="true">
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

          {/* Every group's workers stay mounted so the sidebar's in-session
              agent jump can locate their rows anywhere in the card. */}
          {hasPlan ? (
            <ul className="mt-1 space-y-1.5">
              {groups.map((group) => (
                <li key={group.id}>
                  <div className="flex w-full min-w-0 items-center gap-1.5 px-1.5 py-1 text-xs leading-5">
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
                  </div>
                  <div
                    className="ms-5 mt-0.5 space-y-1.5 border-s border-border/60 pb-1 ps-2"
                    data-slot="workflow-worker-list"
                  >
                    {group.workers.length > 0 ? (
                      group.workers.map((worker) => (
                        <WorkflowWorkerCard key={worker.id} worker={worker} idPrefix={idPrefix} />
                      ))
                    ) : (
                      <p className="px-0.5 py-1 text-xs text-muted-foreground/60">
                        {deriveWorkflowEmptyWorkersMessage(group.status)}
                      </p>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          ) : null}

          {/* Plan-less layout: workers listed directly under the Activity heading */}
          {!hasPlan && model.workers.length > 0 ? (
            <div className="mt-1.5 space-y-1.5" data-slot="workflow-worker-list">
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
        </div>
      </section>
    </div>
  );
});
