import {
  OrchestratorMcpFailure,
  type ForkTaskStatus,
  type ForkTaskSummary,
  NodeId,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadProjection,
  type OrchestratorMcpDelegateTaskResult,
  type OrchestratorMcpTaskListInput,
  type OrchestratorMcpTaskListResult,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export type TaskParentProjection = Pick<
  OrchestrationV2ThreadProjection,
  "runs" | "subagents" | "contextTransfers"
>;

export const TASK_LIST_SUMMARY_MAX_CHARS = 2_000;
const TRUNCATION_MARKER = "\n[shortened; task_status returns full text]";
export const TASK_LIST_SUMMARY_MIN_CHARS = 100 + TRUNCATION_MARKER.length;
// Budget the complete MCP envelope (both text and structuredContent), pessimistically
// treating every UTF-8 byte as a token, below Claude Code's ~25k-token ceiling.
export const TASK_LIST_RESPONSE_MAX_BYTES = 24_000;

function summaryPreview(summary: string, maxChars: number) {
  return summary.length > maxChars
    ? summary.slice(0, Math.max(0, maxChars - TRUNCATION_MARKER.length)) + TRUNCATION_MARKER
    : summary;
}

export function forkTaskStatus(
  status: OrchestratorMcpDelegateTaskResult["status"],
): ForkTaskStatus {
  switch (status) {
    case "completed":
      return "finished";
    case "interrupted":
      return "cancelled";
    case "waiting":
      return "running";
    default:
      return status;
  }
}

function forkResult(
  summary: string,
  status: OrchestratorMcpDelegateTaskResult["status"],
  maxChars = Infinity,
) {
  const truncated = summary.length > maxChars;
  return {
    outcome:
      status === "completed"
        ? ("succeeded" as const)
        : status === "failed"
          ? ("failed" as const)
          : ("cancelled" as const),
    summary: summaryPreview(summary, maxChars),
    summaryTruncated: truncated,
    summaryChars: summary.length,
  };
}

function clipResult<T extends { summary: string; summaryTruncated: boolean }>(
  result: T | null,
  maxChars: number,
) {
  return result === null
    ? result
    : {
        ...result,
        summary: summaryPreview(result.summary, maxChars),
        summaryTruncated: result.summaryTruncated || result.summary.length > maxChars,
      };
}

export function summarizeForkTask(
  task: OrchestrationV2Subagent,
  status: OrchestratorMcpDelegateTaskResult,
  maxChars = Infinity,
): ForkTaskSummary {
  return {
    threadId: status.childThreadId,
    taskId: status.taskId,
    title: (task.title ?? task.prompt).slice(0, 120),
    status: forkTaskStatus(status.status),
    createdBy: task.createdBy === "user" ? "user" : "agent",
    context: { kind: "none" },
    createdAt: DateTime.formatIso(task.startedAt ?? task.updatedAt),
    result:
      status.summary === null
        ? null
        : {
            ...forkResult(status.summary, status.status, maxChars),
            completedAt: DateTime.formatIso(task.completedAt ?? task.updatedAt),
          },
  };
}

const Cursor = Schema.Struct({ createdAt: Schema.Number, taskId: NodeId });
const decodeCursor = Schema.decodeUnknownEffect(Schema.fromJsonString(Cursor));
const encodeCursor = Schema.encodeSync(Schema.fromJsonString(Cursor));

function advanceCursor(entries: readonly { createdAt: number; task: OrchestrationV2Subagent }[]) {
  const last = entries[entries.length - 1]!;
  return { createdAt: last.createdAt, taskId: last.task.id };
}

export function taskListResponseBytes(result: OrchestratorMcpTaskListResult) {
  return Buffer.byteLength(
    JSON.stringify({
      isError: false,
      structuredContent: result,
      content: [{ type: "text", text: JSON.stringify(result) }],
    }),
    "utf8",
  );
}

/** Newest creation first, then ID. A cursor continues strictly after the last
 * shown entry, including timestamp ties. Refresh without a cursor for newer tasks.
 * Status changes never reorder a task; refresh without a cursor to revisit them.
 * Reads never acknowledge delivery. */
export const listOwnedTasks = Effect.fn("OrchestratorTaskList.listOwnedTasks")(function* (
  threadId: ThreadId,
  input: OrchestratorMcpTaskListInput,
  parent: TaskParentProjection,
  readTask: (
    taskId: NodeId,
    parent: TaskParentProjection,
  ) => Effect.Effect<OrchestratorMcpDelegateTaskResult, OrchestratorMcpFailure>,
) {
  const owned = parent.subagents
    .filter(
      (task) =>
        task.origin === "app_owned" && task.threadId === threadId && task.childThreadId !== null,
    )
    .map((task) => ({
      task,
      createdAt: DateTime.toEpochMillis(
        task.startedAt ??
          parent.contextTransfers.find(
            (transfer) =>
              transfer.type === "subagent_spawn" && transfer.targetThreadId === task.childThreadId,
          )?.createdAt ??
          task.updatedAt,
      ),
    }))
    .toSorted(
      (left, right) =>
        right.createdAt - left.createdAt || left.task.id.localeCompare(right.task.id),
    );
  const invalidCursor = () =>
    new OrchestratorMcpFailure({
      code: "invalid_request",
      message:
        "Task-list cursor does not identify tasks owned by this thread. Restart task_list without a cursor.",
    });
  const cursor =
    input.cursor === undefined
      ? undefined
      : yield* decodeCursor(input.cursor).pipe(Effect.mapError(invalidCursor));
  if (
    cursor !== undefined &&
    !owned.some((entry) => entry.task.id === cursor.taskId && entry.createdAt === cursor.createdAt)
  )
    return yield* invalidCursor();
  const remaining = owned.filter(
    (entry) =>
      cursor === undefined ||
      entry.createdAt < cursor.createdAt ||
      (entry.createdAt === cursor.createdAt && entry.task.id.localeCompare(cursor.taskId) > 0),
  );
  const matching: {
    entry: (typeof owned)[number];
    item: OrchestratorMcpTaskListResult["tasks"][number];
  }[] = [];
  const fits = (result: OrchestratorMcpTaskListResult) =>
    taskListResponseBytes(result) <= TASK_LIST_RESPONSE_MAX_BYTES &&
    (result.nextCursor?.length ?? 0) <= 8_000;
  let hasMore = false;
  for (const entry of remaining) {
    const { task } = entry;
    // Published terminal status is authoritative in the parent. Child state is
    // still needed for matches, including pending follow-ups and later results.
    if (
      input.status !== undefined &&
      (task.status === "completed" ||
        task.status === "failed" ||
        task.status === "cancelled" ||
        task.status === "interrupted") &&
      forkTaskStatus(task.status) !== input.status
    )
      continue;
    const status = yield* readTask(task.id, parent).pipe(Effect.result);
    let item: OrchestratorMcpTaskListResult["tasks"][number] | undefined;
    if (status._tag === "Failure") {
      item = {
        threadId: task.childThreadId!,
        taskId: task.id,
        title: (task.title ?? task.prompt).slice(0, 120),
        status: "unreadable",
        createdBy: task.createdBy === "user" ? "user" : "agent",
        context: { kind: "none" },
        createdAt: DateTime.formatIso(task.startedAt ?? task.updatedAt),
        result: null,
        error: `Could not read this child (${status.failure.code}); use task_status for this taskId.`,
      };
    } else if (
      status._tag === "Success" &&
      (input.status === undefined || forkTaskStatus(status.success.status) === input.status)
    ) {
      const value = status.success;
      item = {
        ...summarizeForkTask(task, value, TASK_LIST_SUMMARY_MAX_CHARS),
        ...(value.workState === "waiting_for_children" ? { workState: value.workState } : {}),
        ...(value.hasPendingChildRuns ? { hasPendingChildRuns: true } : {}),
        ...(value.latestTerminalRunId === value.childRunId ||
        value.latestTerminalRunId === null ||
        value.latestTerminalSummary === null
          ? {}
          : {
              latestTerminalRunId: value.latestTerminalRunId,
              latestTerminalResult: forkResult(
                value.latestTerminalSummary,
                value.latestTerminalStatus ?? value.status,
                TASK_LIST_SUMMARY_MAX_CHARS,
              ),
            }),
      };
    }
    if (item !== undefined) {
      matching.push({ entry, item });
      // One matching lookahead establishes a non-empty continuation; never read
      // the remaining tail after the limit or minimum-preview budget is full.
      if (
        matching.length > (input.limit ?? Infinity) ||
        !fits(page(matching.length, TASK_LIST_SUMMARY_MIN_CHARS, true))
      ) {
        hasMore = true;
        break;
      }
    }
  }
  if (matching.length === 0) return { parentThreadId: threadId, tasks: [], nextCursor: null };

  function page(
    count: number,
    previewChars: number,
    more = hasMore,
  ): OrchestratorMcpTaskListResult {
    const selected = matching.slice(0, count);
    return {
      parentThreadId: threadId,
      tasks: selected.map(({ item }) => ({
        ...item,
        result: clipResult(item.result, previewChars),
        ...(item.latestTerminalResult === undefined
          ? {}
          : {
              latestTerminalResult: clipResult(item.latestTerminalResult, previewChars)!,
            }),
      })),
      nextCursor:
        count === matching.length && !more
          ? null
          : encodeCursor(advanceCursor(selected.map(({ entry }) => entry))),
    };
  }
  let count = Math.min(input.limit ?? matching.length, matching.length);
  // First shorten every preview to try to fit all matches, then page only when
  // the compact metadata and minimum previews still exceed the envelope budget.
  if (!fits(page(count, TASK_LIST_SUMMARY_MIN_CHARS))) {
    let lower = 1;
    let upper = count - 1;
    count = 0;
    while (lower <= upper) {
      const candidate = Math.floor((lower + upper) / 2);
      if (fits(page(candidate, TASK_LIST_SUMMARY_MIN_CHARS))) {
        count = candidate;
        lower = candidate + 1;
      } else upper = candidate - 1;
    }
  }
  if (count === 0)
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message:
        "Task metadata exceeds the task_list response budget. Read this task through task_status, or restart task_list without a cursor.",
    });
  let lower = TASK_LIST_SUMMARY_MIN_CHARS;
  let upper = TASK_LIST_SUMMARY_MAX_CHARS;
  let result = page(count, lower);
  while (lower <= upper) {
    const previewChars = Math.floor((lower + upper) / 2);
    const candidate = page(count, previewChars);
    if (fits(candidate)) {
      result = candidate;
      lower = previewChars + 1;
    } else upper = previewChars - 1;
  }
  return result;
});
