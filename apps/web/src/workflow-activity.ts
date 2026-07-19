import type { OrchestrationThreadActivity, TaskUsageSnapshot, TurnId } from "@t3tools/contracts";

import {
  compareActivitiesByOrder,
  deriveTaskLifecycles,
  type WorkLogToolLifecycleStatus,
} from "./session-logic";

export const MAX_RECENT_WORKFLOW_TOOLS = 8;

export type WorkflowPlanStepStatus = "pending" | "inProgress" | "completed";

export interface WorkflowActivityWorker {
  id: string;
  taskId: string;
  turnId: TurnId;
  startedAt: string;
  updatedAt: string;
  status: WorkLogToolLifecycleStatus;
  stepId?: string;
  stepIndex?: number;
  stepLabel?: string;
  startPlanActivityId?: string;
  startPlanSequence?: number;
  toolUseId?: string;
  description?: string;
  taskType?: string;
  subagentType?: string;
  workflowName?: string;
  prompt?: string;
  usage?: TaskUsageSnapshot;
  progressSummary?: string;
  resultSummary?: string;
  outputFile?: string;
  skipTranscript?: boolean;
  lastToolName?: string;
}

export interface WorkflowActivityStep {
  id: string;
  index: number;
  label: string;
  status: WorkflowPlanStepStatus;
  sourcePlanActivityId: string;
  sourcePlanSequence?: number;
  historical?: boolean;
  workers: WorkflowActivityWorker[];
}

export interface WorkflowOtherActivityGroup {
  id: string;
  label: "Other activity";
  workers: WorkflowActivityWorker[];
}

export interface WorkflowRecentTool {
  id: string;
  activityId: string;
  createdAt: string;
  status: "inProgress";
  toolUseId?: string;
  parentToolUseId?: string | null;
  taskId?: string;
  toolName?: string;
  summary?: string;
  elapsedSeconds?: number;
}

export interface WorkflowActivityModel {
  turnId: TurnId;
  planActivityId?: string;
  planExplanation?: string | null;
  steps: WorkflowActivityStep[];
  historicalSteps: WorkflowActivityStep[];
  otherActivity: WorkflowOtherActivityGroup | null;
  workers: WorkflowActivityWorker[];
  totalUsage?: TaskUsageSnapshot;
  reasoningSummary?: string;
  recentTools: WorkflowRecentTool[];
}

interface PlanSnapshot {
  activity: OrchestrationThreadActivity;
  explanation?: string | null;
  steps: Array<{
    index: number;
    label: string;
    status: WorkflowPlanStepStatus;
  }>;
}

interface WorkerAssociation {
  stepId?: string;
  stepIndex?: number;
  stepLabel?: string;
  startPlanActivityId?: string;
  startPlanSequence?: number;
}

interface RecentToolAccumulator extends WorkflowRecentTool {
  orderActivity: OrchestrationThreadActivity;
}

export function deriveWorkflowActivityModel(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  activeTurnId: TurnId | string | null | undefined,
  options?: { readonly maxRecentTools?: number },
): WorkflowActivityModel | null {
  if (!activeTurnId) {
    return null;
  }
  const turnId = activeTurnId as TurnId;
  const ordered = activities
    .filter((activity) => activity.turnId === turnId)
    .toSorted(compareActivitiesByOrder);
  if (ordered.length === 0) {
    return null;
  }

  const lifecycles = deriveTaskLifecycles(ordered).toSorted((left, right) =>
    compareActivitiesByOrder(left.firstActivity, right.firstActivity),
  );
  const firstActivityIdByTaskId = new Map(
    lifecycles.map((lifecycle) => [lifecycle.taskId, lifecycle.firstActivity.id] as const),
  );
  const associationByTaskId = new Map<string, WorkerAssociation>();
  let latestPlan: PlanSnapshot | null = null;
  let reasoningSummary: string | undefined;

  for (const activity of ordered) {
    const plan = parsePlanSnapshot(activity);
    if (plan) {
      latestPlan = plan;
    }

    const taskId = extractActivityTaskId(activity);
    if (
      taskId &&
      firstActivityIdByTaskId.get(taskId) === activity.id &&
      !associationByTaskId.has(taskId)
    ) {
      associationByTaskId.set(taskId, associateWorkerAtStart(turnId, latestPlan));
    }

    if (activity.kind === "turn.reasoning.summary") {
      const candidate = asTrimmedString(asRecord(activity.payload)?.reasoningSummary);
      if (candidate) {
        reasoningSummary = candidate;
      }
    }
  }

  const workers = lifecycles.map((lifecycle) => {
    const association = associationByTaskId.get(lifecycle.taskId) ?? {};
    const entry = lifecycle.entry;
    return {
      id: lifecycle.taskId,
      taskId: lifecycle.taskId,
      turnId,
      startedAt: lifecycle.firstActivity.createdAt,
      updatedAt: lifecycle.latestActivity.createdAt,
      status: entry.toolLifecycleStatus ?? "inProgress",
      ...association,
      ...(entry.toolUseId !== undefined ? { toolUseId: entry.toolUseId } : {}),
      ...(entry.description !== undefined ? { description: entry.description } : {}),
      ...(entry.taskType !== undefined ? { taskType: entry.taskType } : {}),
      ...(entry.subagentType !== undefined ? { subagentType: entry.subagentType } : {}),
      ...(entry.workflowName !== undefined ? { workflowName: entry.workflowName } : {}),
      ...(entry.prompt !== undefined ? { prompt: entry.prompt } : {}),
      ...(entry.usage !== undefined ? { usage: entry.usage } : {}),
      ...(entry.progressSummary !== undefined ? { progressSummary: entry.progressSummary } : {}),
      ...(entry.resultSummary !== undefined ? { resultSummary: entry.resultSummary } : {}),
      ...(entry.outputFile !== undefined ? { outputFile: entry.outputFile } : {}),
      ...(entry.skipTranscript !== undefined ? { skipTranscript: entry.skipTranscript } : {}),
      ...(entry.lastToolName !== undefined ? { lastToolName: entry.lastToolName } : {}),
    } satisfies WorkflowActivityWorker;
  });

  const steps = latestPlan
    ? latestPlan.steps.map<WorkflowActivityStep>((step) => ({
        id: workflowStepId(turnId, step.index),
        index: step.index,
        label: step.label,
        status: step.status,
        sourcePlanActivityId: latestPlan.activity.id,
        ...(latestPlan.activity.sequence !== undefined
          ? { sourcePlanSequence: latestPlan.activity.sequence }
          : {}),
        workers: [],
      }))
    : [];
  const historicalStepsById = new Map<string, WorkflowActivityStep>();
  const otherWorkers: WorkflowActivityWorker[] = [];

  for (const worker of workers) {
    if (worker.stepIndex === undefined || worker.stepLabel === undefined || !worker.stepId) {
      otherWorkers.push(worker);
      continue;
    }
    const currentStep = steps.find((step) => step.index === worker.stepIndex);
    if (currentStep && currentStep.id === worker.stepId && currentStep.label === worker.stepLabel) {
      currentStep.workers.push(worker);
      continue;
    }

    const historicalId = `${worker.stepId}:plan:${worker.startPlanActivityId ?? "legacy"}`;
    let historicalStep = historicalStepsById.get(historicalId);
    if (!historicalStep) {
      historicalStep = {
        id: historicalId,
        index: worker.stepIndex,
        label: worker.stepLabel,
        status: "inProgress",
        sourcePlanActivityId: worker.startPlanActivityId ?? "",
        ...(worker.startPlanSequence !== undefined
          ? { sourcePlanSequence: worker.startPlanSequence }
          : {}),
        historical: true,
        workers: [],
      };
      historicalStepsById.set(historicalId, historicalStep);
    }
    historicalStep.workers.push(worker);
  }

  const historicalSteps = [...historicalStepsById.values()];
  const otherActivity =
    otherWorkers.length > 0
      ? {
          id: `${turnId}:other-activity`,
          label: "Other activity" as const,
          workers: otherWorkers,
        }
      : null;
  const recentTools = deriveRecentWorkflowTools(
    ordered,
    normalizeRecentToolLimit(options?.maxRecentTools),
  );
  const totalUsage = sumWorkerUsage(workers);
  const hasMeaningfulContent =
    steps.length > 0 ||
    historicalSteps.length > 0 ||
    workers.length > 0 ||
    recentTools.length > 0 ||
    reasoningSummary !== undefined;
  if (!hasMeaningfulContent) {
    return null;
  }

  return {
    turnId,
    ...(latestPlan ? { planActivityId: latestPlan.activity.id } : {}),
    ...(latestPlan && latestPlan.explanation !== undefined
      ? { planExplanation: latestPlan.explanation }
      : {}),
    steps,
    historicalSteps,
    otherActivity,
    workers,
    ...(totalUsage !== null ? { totalUsage } : {}),
    ...(reasoningSummary !== undefined ? { reasoningSummary } : {}),
    recentTools,
  };
}

function parsePlanSnapshot(activity: OrchestrationThreadActivity): PlanSnapshot | null {
  if (activity.kind !== "turn.plan.updated") {
    return null;
  }
  const payload = asRecord(activity.payload);
  if (!Array.isArray(payload?.plan)) {
    return null;
  }
  const steps: PlanSnapshot["steps"] = [];
  for (const [index, value] of payload.plan.entries()) {
    const step = asRecord(value);
    const label = asTrimmedString(step?.step);
    if (!label) {
      continue;
    }
    steps.push({
      index,
      label,
      status: normalizePlanStepStatus(step?.status),
    });
  }
  const explanation =
    payload.explanation === null ? null : (asTrimmedString(payload.explanation) ?? undefined);
  return {
    activity,
    ...(explanation !== undefined ? { explanation } : {}),
    steps,
  };
}

function normalizePlanStepStatus(value: unknown): WorkflowPlanStepStatus {
  return value === "completed" || value === "inProgress" ? value : "pending";
}

function associateWorkerAtStart(turnId: TurnId, plan: PlanSnapshot | null): WorkerAssociation {
  const activeStep = plan?.steps.find((step) => step.status === "inProgress");
  if (!plan || !activeStep) {
    return {};
  }
  return {
    stepId: workflowStepId(turnId, activeStep.index),
    stepIndex: activeStep.index,
    stepLabel: activeStep.label,
    startPlanActivityId: plan.activity.id,
    ...(plan.activity.sequence !== undefined ? { startPlanSequence: plan.activity.sequence } : {}),
  };
}

function workflowStepId(turnId: TurnId, index: number): string {
  return `${turnId}:step:${index}`;
}

function deriveRecentWorkflowTools(
  orderedActivities: ReadonlyArray<OrchestrationThreadActivity>,
  limit: number,
): WorkflowRecentTool[] {
  if (limit === 0) {
    return [];
  }
  const toolsByKey = new Map<string, RecentToolAccumulator>();
  for (const activity of orderedActivities) {
    if (activity.kind !== "tool.progress") {
      continue;
    }
    const payload = asRecord(activity.payload);
    const toolUseId = asTrimmedString(payload?.toolUseId);
    const key = toolUseId ? `tool:${toolUseId}` : `activity:${activity.id}`;
    const previous = toolsByKey.get(key);
    const next: RecentToolAccumulator = {
      id: key,
      activityId: activity.id,
      createdAt: activity.createdAt,
      status: "inProgress",
      orderActivity: activity,
      ...(previous?.toolUseId !== undefined ? { toolUseId: previous.toolUseId } : {}),
      ...(previous?.parentToolUseId !== undefined
        ? { parentToolUseId: previous.parentToolUseId }
        : {}),
      ...(previous?.taskId !== undefined ? { taskId: previous.taskId } : {}),
      ...(previous?.toolName !== undefined ? { toolName: previous.toolName } : {}),
      ...(previous?.summary !== undefined ? { summary: previous.summary } : {}),
      ...(previous?.elapsedSeconds !== undefined
        ? { elapsedSeconds: previous.elapsedSeconds }
        : {}),
    };
    if (toolUseId) {
      next.toolUseId = toolUseId;
    }
    if (payload && "parentToolUseId" in payload) {
      const parentToolUseId = payload.parentToolUseId;
      if (parentToolUseId === null) {
        next.parentToolUseId = null;
      } else {
        const normalizedParent = asTrimmedString(parentToolUseId);
        if (normalizedParent) {
          next.parentToolUseId = normalizedParent;
        }
      }
    }
    const taskId = asTrimmedString(payload?.taskId);
    if (taskId) {
      next.taskId = taskId;
    }
    const toolName = asTrimmedString(payload?.toolName);
    if (toolName) {
      next.toolName = toolName;
    }
    const summary = asTrimmedString(payload?.summary) ?? asTrimmedString(activity.summary);
    if (summary) {
      next.summary = summary;
    }
    const elapsedSeconds = normalizeNonNegativeFiniteNumber(payload?.elapsedSeconds);
    if (elapsedSeconds !== null) {
      next.elapsedSeconds = elapsedSeconds;
    }
    toolsByKey.set(key, next);
  }

  return [...toolsByKey.values()]
    .toSorted((left, right) => compareActivitiesByOrder(left.orderActivity, right.orderActivity))
    .slice(-limit)
    .map(({ orderActivity: _orderActivity, ...tool }) => tool);
}

function normalizeRecentToolLimit(value: number | undefined): number {
  if (value === undefined) {
    return MAX_RECENT_WORKFLOW_TOOLS;
  }
  if (!Number.isFinite(value)) {
    return MAX_RECENT_WORKFLOW_TOOLS;
  }
  return Math.max(0, Math.floor(value));
}

function sumWorkerUsage(workers: ReadonlyArray<WorkflowActivityWorker>): TaskUsageSnapshot | null {
  let hasTotalTokens = false;
  let hasToolUses = false;
  let hasDurationMs = false;
  let totalTokens = 0;
  let toolUses = 0;
  let durationMs = 0;
  for (const worker of workers) {
    if (worker.usage?.totalTokens !== undefined) {
      hasTotalTokens = true;
      totalTokens += worker.usage.totalTokens;
    }
    if (worker.usage?.toolUses !== undefined) {
      hasToolUses = true;
      toolUses += worker.usage.toolUses;
    }
    if (worker.usage?.durationMs !== undefined) {
      hasDurationMs = true;
      durationMs += worker.usage.durationMs;
    }
  }
  if (!hasTotalTokens && !hasToolUses && !hasDurationMs) {
    return null;
  }
  return {
    ...(hasTotalTokens ? { totalTokens } : {}),
    ...(hasToolUses ? { toolUses } : {}),
    ...(hasDurationMs ? { durationMs } : {}),
  };
}

function extractActivityTaskId(activity: OrchestrationThreadActivity): string | null {
  if (
    activity.kind !== "task.started" &&
    activity.kind !== "task.progress" &&
    activity.kind !== "task.completed"
  ) {
    return null;
  }
  return asTrimmedString(asRecord(activity.payload)?.taskId);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeNonNegativeFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
