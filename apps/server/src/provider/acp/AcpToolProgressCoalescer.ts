/**
 * Retains one latest update per tool; first, status changes, and terminals pass.
 * State lasts for the owning turn: evicting pending values loses last states,
 * and evicting terminal tombstones lets stale updates reopen completed tools.
 */
export function makeAcpToolProgressCoalescer<A>(
  options: {
    readonly intervalMs?: number;
  } = {},
) {
  const intervalMs = options.intervalMs ?? 100;
  const entries = new Map<
    string,
    {
      lastEmittedAt: number;
      status: string | undefined;
      pending?: A;
    }
  >();

  const offer = (key: string, value: A, status: string | undefined, now: number): boolean => {
    const previous = entries.get(key);
    if (
      status === "completed" ||
      status === "failed" ||
      status === "interrupted" ||
      status === "cancelled"
    ) {
      entries.delete(key);
      entries.set(key, { lastEmittedAt: now, status });
      return true;
    }
    if (
      previous?.status === "completed" ||
      previous?.status === "failed" ||
      previous?.status === "interrupted" ||
      previous?.status === "cancelled"
    )
      return false;
    if (
      previous === undefined ||
      previous.status !== status ||
      now - previous.lastEmittedAt >= intervalMs
    ) {
      entries.delete(key);
      entries.set(key, { lastEmittedAt: now, status });
      return true;
    }
    previous.pending = value;
    return false;
  };

  const flush = (now: number, all = false): Array<A> => {
    const pending: Array<A> = [];
    for (const entry of entries.values()) {
      if (entry.pending === undefined || (!all && now - entry.lastEmittedAt < intervalMs)) continue;
      pending.push(entry.pending);
      delete entry.pending;
      entry.lastEmittedAt = now;
    }
    return pending;
  };

  return { offer, flush };
}
