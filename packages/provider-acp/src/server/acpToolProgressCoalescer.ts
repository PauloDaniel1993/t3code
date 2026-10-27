const isTerminal = (status: string | undefined) =>
  status === "completed" ||
  status === "failed" ||
  status === "interrupted" ||
  status === "cancelled";

/**
 * Keep state for the whole turn: dropping pending values loses final progress,
 * and dropping terminal tombstones lets stale updates reopen completed tools.
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

  /** Returns what to deliver now, in order: nothing while held or stale. */
  const offer = (key: string, value: A, status: string | undefined, now: number): Array<A> => {
    const previous = entries.get(key);
    if (!isTerminal(status) && isTerminal(previous?.status)) return [];
    if (
      previous !== undefined &&
      !isTerminal(status) &&
      previous.status === status &&
      now - previous.lastEmittedAt < intervalMs
    ) {
      previous.pending = value;
      return [];
    }
    const held = previous?.status !== status ? previous?.pending : undefined;
    entries.delete(key);
    entries.set(key, { lastEmittedAt: now, status });
    return held === undefined ? [value] : [held, value];
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
