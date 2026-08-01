/**
 * Presentation logic for the in-session agent UI that sits around the rows
 * themselves: the parent row's group chip, the peek window's chips, and the
 * retry linkage lines.
 *
 * The rules about grouping, labels, and bodies live in
 * `nativeAgents.ts`; these are the rules that file does not
 * cover, kept separate for the same reason — testable without rendering.
 */
import type { ThreadNativeAgent } from "@t3tools/contracts";

import { formatNativeAgentUsage } from "./nativeAgents.ts";

/**
 * The parent row's collapse chip. The group mixes two kinds of work — real
 * sub-thread tasks and in-session agents — so the count names each kind rather
 * than summing them into a number that implies they are interchangeable.
 */
export function formatTaskGroupChipLabel(input: {
  readonly taskCount: number;
  readonly nativeAgentCount: number;
}): string {
  const parts: string[] = [];
  if (input.taskCount > 0) {
    parts.push(`${input.taskCount} ${input.taskCount === 1 ? "task" : "tasks"}`);
  }
  if (input.nativeAgentCount > 0) {
    parts.push(`${input.nativeAgentCount} ${input.nativeAgentCount === 1 ? "agent" : "agents"}`);
  }
  return parts.join(" · ");
}

export interface NativeAgentPeekChip {
  readonly id: string;
  readonly label: string;
  /** The kind chip is the affordance honesty; the rest are neutral facts. */
  readonly tone: "kind" | "neutral";
}

/**
 * Chips for the peek window, in order: the kind word first (it is the one
 * thing the user must read before expecting thread-like behaviour), then the
 * provider's subagent type, then whatever usage counters were reported.
 * Missing fields are omitted, never rendered as zeros or placeholders.
 */
export function resolveNativeAgentPeekChips(
  agent: ThreadNativeAgent,
): ReadonlyArray<NativeAgentPeekChip> {
  const chips: NativeAgentPeekChip[] = [{ id: "kind", label: "in-session agent", tone: "kind" }];
  if (agent.subagentType !== undefined) {
    chips.push({ id: "subagent-type", label: agent.subagentType, tone: "neutral" });
  }
  for (const [index, label] of formatNativeAgentUsage(agent.usage).entries()) {
    chips.push({ id: `usage-${index}`, label, tone: "neutral" });
  }
  return chips;
}

export interface NativeAgentRetryLink {
  /** Which direction of the linkage this line describes. */
  readonly direction: "retryOf" | "retriedBy";
  readonly targetTaskId: string;
  /** The other run, when it is still part of the thread's live picture. */
  readonly target: ThreadNativeAgent | null;
  readonly label: string;
}

/**
 * The retry lines shown in the peek. Both directions can be set at once (a
 * retry that was itself retried), and each line points at the other run.
 *
 * The other run may already be gone — the thread's `nativeAgents` set is
 * bounded, and a settled run from an older turn drops out of it. The line is
 * still honest then, but there is nothing left to swap the peek to, so
 * `target` is null and the line renders inert.
 */
export function resolveNativeAgentRetryLinks(
  agent: ThreadNativeAgent,
  agents: ReadonlyArray<ThreadNativeAgent>,
): ReadonlyArray<NativeAgentRetryLink> {
  const links: NativeAgentRetryLink[] = [];
  if (agent.retryOfTaskId !== undefined) {
    const target = agents.find((other) => other.taskId === agent.retryOfTaskId) ?? null;
    links.push({
      direction: "retryOf",
      targetTaskId: agent.retryOfTaskId,
      target,
      label: `Retry of ${target?.description ?? "an earlier run"}`,
    });
  }
  if (agent.retriedByTaskId !== undefined) {
    const target = agents.find((other) => other.taskId === agent.retriedByTaskId) ?? null;
    links.push({
      direction: "retriedBy",
      targetTaskId: agent.retriedByTaskId,
      target,
      label: `Retried by ${target?.description ?? "a later run"}`,
    });
  }
  return links;
}
