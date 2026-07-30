/**
 * Codex collab-agent lifecycle normalization.
 *
 * Codex spawns in-session agents through the `collabAgentToolCall` item: one
 * item per tool invocation (`spawnAgent`, `sendInput`, `resumeAgent`, `wait`,
 * `closeAgent`), each naming the child threads it addresses in
 * `receiverThreadIds` and reporting their live state in `agentsStates`. See
 * `V2ItemStartedNotification__ThreadItem` in effect-codex-app-server's generated
 * schema for the shape.
 *
 * `agentsStates` is the authoritative lifecycle source, and every collab item
 * restates it for the agents it addresses. Deriving from it — rather than from
 * the child conversations' own `turn/completed` notifications, which is what the
 * runtime used to do — is what makes spawn, progress, completion, failure, and
 * cancellation all observable, and what keeps an agent from being left running
 * forever when its child turn never reports.
 *
 * Everything here is deliberately pure so the bookkeeping is testable without a
 * live app-server: the caller applies `next` atomically and emits `emissions` in
 * order.
 *
 * Codex versions that predate `agentsStates` still work: an addressed receiver
 * with no state entry is admitted as running, and the two settle helpers close
 * it out.
 */
import type { TurnId } from "@t3tools/contracts";

/**
 * The notification shape this module reads. Structural rather than an import of
 * the runtime's own alias, so the module stays free of the session runtime.
 */
export type CodexCollabNotification = {
  readonly method: string;
  readonly params?: unknown;
};

/** What the runtime remembers about one Codex collab agent. */
export interface CollabAgentRecord {
  readonly turnId: TurnId;
  readonly description?: string;
  readonly prompt?: string;
  /** Terminal once settled, so a restated status cannot re-open a closed row. */
  readonly settled: boolean;
  /** Last emitted progress line, so an unchanged status emits nothing. */
  readonly message?: string;
}

/** A `t3/task/*` notification the runtime should emit for a collab agent. */
export type CollabAgentEmission =
  | {
      readonly kind: "started";
      readonly taskId: string;
      readonly turnId: TurnId;
      readonly description?: string;
      readonly prompt?: string;
    }
  | {
      readonly kind: "progress";
      readonly taskId: string;
      readonly turnId: TurnId;
      readonly message: string;
    }
  | {
      readonly kind: "completed";
      readonly taskId: string;
      readonly turnId: TurnId;
      readonly status: "completed" | "failed" | "stopped";
      readonly message?: string;
    };

export interface CollabAgentFoldResult {
  readonly next: ReadonlyMap<string, CollabAgentRecord>;
  readonly emissions: ReadonlyArray<CollabAgentEmission>;
}

/**
 * Map Codex's per-agent status onto the canonical lifecycle.
 *
 * `interrupted`, `shutdown`, and `notFound` are terminal but not failures — the
 * agent stopped rather than erred, and reporting them as failed would be a lie
 * about what happened. Unknown values from a newer Codex are treated as still
 * running, so an unrecognised state never fabricates a terminal row.
 */
export function collabAgentLifecycleStatus(
  status: string | undefined,
): "running" | "completed" | "failed" | "stopped" {
  switch (status) {
    case "completed":
      return "completed";
    case "errored":
      return "failed";
    case "interrupted":
    case "shutdown":
    case "notFound":
      return "stopped";
    default:
      return "running";
  }
}

function trimOptional(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The item on an `item/started` / `item/completed`, if the method carries one. */
function readItem(notification: CodexCollabNotification): Record<string, unknown> | undefined {
  if (notification.method !== "item/started" && notification.method !== "item/completed") {
    return undefined;
  }
  return asRecord(asRecord(notification.params)?.item);
}

/** The thread a notification belongs to, which for a spawn is the spawner's. */
function readNotificationThread(notification: CodexCollabNotification): string | undefined {
  return trimOptional(asRecord(notification.params)?.threadId);
}

/** The `collabAgentToolCall` item, if this notification carries one. */
function readCollabItem(notification: CodexCollabNotification):
  | {
      readonly receiverThreadIds: ReadonlyArray<string>;
      readonly agentsStates: Record<string, unknown>;
      readonly prompt: string | undefined;
    }
  | undefined {
  const item = readItem(notification);
  if (item === undefined || item.type !== "collabAgentToolCall") return undefined;
  const receiverThreadIds = Array.isArray(item.receiverThreadIds)
    ? item.receiverThreadIds.filter((entry): entry is string => typeof entry === "string")
    : [];
  return {
    receiverThreadIds,
    agentsStates: asRecord(item.agentsStates) ?? {},
    prompt: trimOptional(item.prompt),
  };
}

/**
 * The root of Codex's agent-path hierarchy. A `subAgentActivity` whose path is
 * exactly this describes the top-level conversation, not a spawned agent — child
 * agents report back to the parent with `agentPath: "/root"`.
 */
const CODEX_AGENT_ROOT_PATH = "/root";

/**
 * The `subAgentActivity` item, if this notification carries one.
 *
 * This is how current Codex reports its in-session agents, and the reason the
 * sidebar stayed empty: `collabAgentToolCall` — the only shape the runtime used
 * to understand — is never emitted by these versions.
 *
 * Observed sequence for a three-agent fan-out (Codex app-server, gpt-5.6):
 *   item/completed  item.kind=started      agentPath=/root/<name>  agentThreadId=<child>
 *   turn/started    threadId=<child>
 *   item/completed  item.kind=interacted   agentPath=/root         agentThreadId=<parent>
 *   turn/completed  threadId=<child>
 * The spawn arrives on the parent's thread and carries the parent's turn id, so
 * `agentThreadId` is a stable per-agent task id and `agentPath`'s last segment is
 * the agent's name.
 */
function readSubAgentItem(notification: CodexCollabNotification):
  | {
      readonly agentThreadId: string;
      readonly kind: string | undefined;
      readonly name: string | undefined;
    }
  | undefined {
  const item = readItem(notification);
  if (item === undefined || item.type !== "subAgentActivity") return undefined;
  const agentThreadId = trimOptional(item.agentThreadId);
  if (agentThreadId === undefined) return undefined;
  const agentPath = trimOptional(item.agentPath);
  // `/root/reviewer` names the agent "reviewer"; a bare `/root` names no agent.
  const name =
    agentPath === undefined || agentPath === CODEX_AGENT_ROOT_PATH
      ? undefined
      : trimOptional(agentPath.split("/").findLast((segment) => segment.trim().length > 0));
  return { agentThreadId, kind: trimOptional(item.kind), name };
}

/**
 * Fold a `subAgentActivity` notification into the agent set.
 *
 * Only `kind: "started"` admits an agent. `interacted` means the child handed
 * control back and carries no reportable detail — the child's own
 * `turn/completed` settles it — and `interrupted` is a cancellation.
 */
function applyCodexSubAgentNotification(
  current: ReadonlyMap<string, CollabAgentRecord>,
  notification: CodexCollabNotification,
  parentTurnId: TurnId | undefined,
): CollabAgentFoldResult {
  const item = readSubAgentItem(notification);
  if (item === undefined) return { next: current, emissions: [] };

  if (item.kind === "interrupted") {
    const record = current.get(item.agentThreadId);
    if (record === undefined || record.settled) return { next: current, emissions: [] };
    const next = new Map(current);
    next.set(item.agentThreadId, { ...record, settled: true });
    return {
      next,
      emissions: [
        {
          kind: "completed",
          taskId: item.agentThreadId,
          turnId: record.turnId,
          status: "stopped",
        },
      ],
    };
  }

  if (item.kind !== "started") return { next: current, emissions: [] };
  // `agentPath: "/root"` with `kind: "started"` would be the conversation itself.
  if (item.name === undefined) return { next: current, emissions: [] };
  if (current.has(item.agentThreadId)) return { next: current, emissions: [] };
  if (parentTurnId === undefined) return { next: current, emissions: [] };
  // A spawn observed on a thread that is itself one of our agents is a nested
  // sub-sub-agent. The sidebar models one level, so it is not a parent row.
  const onThread = readNotificationThread(notification);
  if (onThread !== undefined && current.has(onThread)) {
    return { next: current, emissions: [] };
  }

  const next = new Map(current);
  next.set(item.agentThreadId, {
    turnId: parentTurnId,
    description: item.name,
    settled: false,
  });
  return {
    next,
    emissions: [
      {
        kind: "started",
        taskId: item.agentThreadId,
        turnId: parentTurnId,
        description: item.name,
      },
    ],
  };
}

/**
 * Fold one notification into the collab-agent set, returning the emissions it
 * implies.
 *
 * Both Codex agent shapes are handled here — `subAgentActivity` (current) and
 * `collabAgentToolCall` (the collab tool) — so a version emitting either, or
 * both, converges on the same canonical lifecycle.
 */
export function applyCodexCollabNotification(
  current: ReadonlyMap<string, CollabAgentRecord>,
  notification: CodexCollabNotification,
  parentTurnId: TurnId | undefined,
): CollabAgentFoldResult {
  const subAgent = applyCodexSubAgentNotification(current, notification, parentTurnId);
  if (subAgent.emissions.length > 0 || subAgent.next !== current) return subAgent;

  const item = readCollabItem(notification);
  if (item === undefined) return { next: current, emissions: [] };

  const next = new Map(current);
  const emissions: Array<CollabAgentEmission> = [];

  for (const receiverThreadId of item.receiverThreadIds) {
    const existing = next.get(receiverThreadId);
    // A receiver first seen without a parent turn cannot be attributed, and
    // guessing a turn would hang the row off the wrong response.
    const turnId = existing?.turnId ?? parentTurnId;
    if (turnId === undefined) continue;

    if (existing === undefined) {
      // Admitted on first sight through ANY collab tool, not just `spawnAgent`:
      // a resumed thread's first observation of an agent is often a `wait`.
      emissions.push({
        kind: "started",
        taskId: receiverThreadId,
        turnId,
        ...(item.prompt === undefined ? {} : { description: item.prompt, prompt: item.prompt }),
      });
      next.set(receiverThreadId, {
        turnId,
        ...(item.prompt === undefined ? {} : { description: item.prompt, prompt: item.prompt }),
        settled: false,
      });
    }

    const record = next.get(receiverThreadId);
    if (record === undefined || record.settled) continue;

    const state = asRecord(item.agentsStates[receiverThreadId]);
    const message = trimOptional(state?.message);
    const lifecycle = collabAgentLifecycleStatus(
      typeof state?.status === "string" ? state.status : undefined,
    );

    if (lifecycle === "running") {
      // Only a changed message is progress; restating the same line on every
      // `wait` would append an identical activity row per poll.
      if (message !== undefined && message !== record.message) {
        emissions.push({ kind: "progress", taskId: receiverThreadId, turnId, message });
        next.set(receiverThreadId, { ...record, message });
      }
      continue;
    }

    emissions.push({
      kind: "completed",
      taskId: receiverThreadId,
      turnId,
      status: lifecycle,
      ...(message === undefined ? {} : { message }),
    });
    next.set(receiverThreadId, {
      ...record,
      settled: true,
      ...(message === undefined ? {} : { message }),
    });
  }

  return { next, emissions };
}

/**
 * Settle every agent still running on a turn that has ended.
 *
 * Without this an agent whose terminal state never arrives — because the parent
 * turn ended first, or because a pre-`agentsStates` Codex never reported one —
 * keeps a spinner in the sidebar indefinitely. `stopped` rather than `completed`:
 * the run ended with the turn, and claiming success would invent an outcome.
 */
export function settleCodexCollabAgentsForTurn(
  current: ReadonlyMap<string, CollabAgentRecord>,
  turnId: TurnId,
): CollabAgentFoldResult {
  const next = new Map(current);
  const emissions: Array<CollabAgentEmission> = [];
  for (const [taskId, record] of current) {
    if (record.settled || record.turnId !== turnId) continue;
    emissions.push({ kind: "completed", taskId, turnId, status: "stopped" });
    next.set(taskId, { ...record, settled: true });
  }
  return { next, emissions };
}

/** Settle one agent from its child conversation's own `turn/completed`. */
export function settleCodexCollabAgentByThread(
  current: ReadonlyMap<string, CollabAgentRecord>,
  taskId: string,
): CollabAgentFoldResult {
  const record = current.get(taskId);
  if (record === undefined || record.settled) return { next: current, emissions: [] };
  const next = new Map(current);
  next.set(taskId, { ...record, settled: true });
  return {
    next,
    emissions: [{ kind: "completed", taskId, turnId: record.turnId, status: "completed" }],
  };
}

/** The `t3/task/*` provider-event shape for one emission. */
export function codexCollabEmissionEvent(emission: CollabAgentEmission): {
  readonly method: string;
  readonly turnId: TurnId;
  readonly payload: Record<string, unknown>;
} {
  switch (emission.kind) {
    case "started":
      return {
        method: "t3/task/started",
        turnId: emission.turnId,
        payload: {
          taskId: emission.taskId,
          ...(emission.description === undefined ? {} : { description: emission.description }),
          ...(emission.prompt === undefined ? {} : { prompt: emission.prompt }),
        },
      };
    case "progress":
      return {
        method: "t3/task/progress",
        turnId: emission.turnId,
        payload: { taskId: emission.taskId, summary: emission.message },
      };
    case "completed":
      return {
        method: "t3/task/completed",
        turnId: emission.turnId,
        payload: {
          taskId: emission.taskId,
          status: emission.status,
          ...(emission.message === undefined ? {} : { summary: emission.message }),
        },
      };
  }
}
