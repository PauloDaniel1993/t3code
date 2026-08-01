/**
 * Presentation logic for in-session agent rows in the sidebar task group.
 *
 * In-session agents are a provider's own subagents. They belong to the turn
 * that spawned them, not to the thread, so the sidebar groups them per turn to
 * mirror the transcript's workflow card — one group here, one card there.
 *
 * Kept separate from the components so the rules — how groups are labelled,
 * which ones open, what a row says — are testable without rendering.
 */
import type { ThreadNativeAgent, ThreadNativeAgentUsage } from "@t3tools/contracts";

export interface NativeAgentTurnGroup {
  /** `null` when the provider reported the run without a turn. */
  readonly turnId: string | null;
  /** Stable key for React and for expand/collapse state. */
  readonly key: string;
  readonly agents: ReadonlyArray<ThreadNativeAgent>;
  readonly runningCount: number;
  readonly finishedCount: number;
  readonly failedCount: number;
  /** Newest `updatedAt` in the group; drives ordering and the relative label. */
  readonly latestAt: string;
  /** The most recent group, which is the one the user is usually watching. */
  readonly isLatest: boolean;
}

/**
 * Group agents by their turn, newest group last so the list reads
 * chronologically and the live work sits nearest the composer.
 */
export function groupNativeAgentsByTurn(
  agents: ReadonlyArray<ThreadNativeAgent>,
): ReadonlyArray<NativeAgentTurnGroup> {
  if (agents.length === 0) return [];

  const byTurn = new Map<string, ThreadNativeAgent[]>();
  for (const agent of agents) {
    // A missing turn cannot be merged with another missing turn — two
    // unattributed runs from different turns would collapse into one group.
    // Keying on the task id keeps each in its own.
    const key = agent.turnId ?? `untracked:${agent.taskId}`;
    const existing = byTurn.get(key);
    if (existing === undefined) byTurn.set(key, [agent]);
    else existing.push(agent);
  }

  const groups = [...byTurn.entries()].map(([key, groupAgents]) => {
    const sorted = [...groupAgents].sort((left, right) =>
      left.startedAt === right.startedAt
        ? left.taskId.localeCompare(right.taskId)
        : left.startedAt.localeCompare(right.startedAt),
    );
    return {
      turnId: sorted[0]?.turnId ?? null,
      key,
      agents: sorted,
      runningCount: sorted.filter((agent) => agent.status === "running").length,
      finishedCount: sorted.filter((agent) => agent.status === "finished").length,
      failedCount: sorted.filter((agent) => agent.status === "failed").length,
      latestAt: sorted.reduce(
        (latest, agent) => (agent.updatedAt > latest ? agent.updatedAt : latest),
        sorted[0]?.updatedAt ?? "",
      ),
    };
  });

  groups.sort((left, right) => left.latestAt.localeCompare(right.latestAt));
  const latestKey = groups.at(-1)?.key;
  return groups.map((group) => ({ ...group, isLatest: group.key === latestKey }));
}

/**
 * A group's header label.
 *
 * Deliberately relative rather than a turn ordinal ("Turn 4"): a turn id is
 * opaque, the sidebar reads a shell snapshot with no turn list to count
 * against, and any ordinal we invented would renumber under compaction. "Latest
 * turn" is also the more useful thing to know at a glance.
 */
export function formatNativeAgentGroupLabel(input: {
  readonly group: NativeAgentTurnGroup;
  readonly nowMs: number;
}): string {
  const count = input.group.agents.length;
  const noun = count === 1 ? "agent" : "agents";
  if (input.group.isLatest) return `Latest turn · ${count} ${noun}`;
  const elapsed = formatElapsedSince(input.group.latestAt, input.nowMs);
  return elapsed === null ? `Earlier turn · ${count} ${noun}` : `${elapsed} ago · ${count} ${noun}`;
}

function formatElapsedSince(isoOrMs: string | number, nowMs: number): string | null {
  const atMs = typeof isoOrMs === "number" ? isoOrMs : Date.parse(isoOrMs);
  if (!Number.isFinite(atMs)) return null;
  const seconds = Math.max(0, Math.floor((nowMs - atMs) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * Whether a group starts expanded.
 *
 * Any group with live work opens, regardless of age. Hiding a running agent
 * behind a collapse is the one failure this grouping could introduce — it would
 * be strictly worse than the transcript card it replaces, where the work is at
 * least visible in place.
 */
export function nativeAgentGroupStartsExpanded(group: NativeAgentTurnGroup): boolean {
  return group.runningCount > 0 || group.isLatest;
}

/** Row elapsed: time since it started while running, total runtime once stopped. */
export function formatNativeAgentElapsed(input: {
  readonly agent: ThreadNativeAgent;
  readonly nowMs: number;
}): string {
  const startedAtMs = Date.parse(input.agent.startedAt);
  if (!Number.isFinite(startedAtMs)) return "";
  const endedAtMs =
    input.agent.status === "running" ? input.nowMs : Date.parse(input.agent.updatedAt);
  if (!Number.isFinite(endedAtMs)) return "";
  return formatElapsedSince(startedAtMs, endedAtMs) ?? "";
}

/**
 * The one-line status shown in the peek header.
 *
 * `durationMs` is preferred once a run has finished because it is the
 * provider's own measurement; the wall-clock fallback covers providers that do
 * not report it.
 */
export function formatNativeAgentStatusLine(input: {
  readonly agent: ThreadNativeAgent;
  readonly nowMs: number;
}): string {
  const elapsed = formatNativeAgentElapsed(input);
  switch (input.agent.status) {
    case "running":
      return elapsed.length > 0 ? `Running · ${elapsed}` : "Running";
    case "failed":
      return elapsed.length > 0 ? `Failed · after ${elapsed}` : "Failed";
    case "finished":
      return elapsed.length > 0 ? `Finished · ran ${elapsed}` : "Finished";
  }
}

/**
 * Usage chips, omitting every counter the provider did not report. Each field of
 * `ThreadNativeAgentUsage` is independently optional, so a partial triple is
 * normal and must not render as a zero.
 */
export function formatNativeAgentUsage(
  usage: ThreadNativeAgentUsage | undefined,
): ReadonlyArray<string> {
  if (usage === undefined) return [];
  const parts: string[] = [];
  if (usage.totalTokens !== undefined) parts.push(`${formatTokens(usage.totalTokens)} tok`);
  if (usage.toolUses !== undefined) {
    parts.push(`${usage.toolUses} ${usage.toolUses === 1 ? "tool" : "tools"}`);
  }
  return parts;
}

function formatTokens(total: number): string {
  if (total < 1_000) return String(total);
  const thousands = total / 1_000;
  return thousands < 100 ? `${thousands.toFixed(1)}k` : `${Math.round(thousands)}k`;
}

/**
 * What the peek body shows beneath the prompt.
 *
 * There is no transcript behind an in-session agent — only a rolling progress
 * line, a result, or an error. A running agent that has not reported progress
 * yet says so rather than rendering an empty panel.
 */
export function resolveNativeAgentBody(agent: ThreadNativeAgent): {
  readonly tone: "progress" | "result" | "error" | "pending";
  readonly text: string;
} {
  if (agent.status === "failed") {
    return {
      tone: "error",
      text: agent.errorMessage ?? "The agent failed without reporting a reason.",
    };
  }
  if (agent.status === "finished") {
    return {
      tone: "result",
      text: agent.resultSummary ?? "Finished without reporting a summary.",
    };
  }
  if (agent.progressSummary !== undefined) {
    return { tone: "progress", text: agent.progressSummary };
  }
  return { tone: "pending", text: "No progress reported yet." };
}
