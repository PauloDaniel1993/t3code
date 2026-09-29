/** Retains one latest update per tool; first, status changes, and terminal states pass immediately. */
export function makeAcpToolProgressCoalescer<A>(
  options: {
    readonly intervalMs?: number;
    readonly capacity?: number;
  } = {},
) {
  const intervalMs = options.intervalMs ?? 100;
  const capacity = options.capacity ?? 256;
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
      if (entries.size > capacity) entries.delete(entries.keys().next().value!);
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
      if (entries.size > capacity) entries.delete(entries.keys().next().value!);
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
    if (all) entries.clear();
    return pending;
  };

  return { offer, flush };
}
