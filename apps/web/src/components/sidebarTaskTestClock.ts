import type { SidebarTaskLeaseClock } from "./sidebarTaskLeases";

/** Deterministic dwell/grace clock: tests never wait on wall time. */
export class SidebarTaskTestClock implements SidebarTaskLeaseClock {
  private now = 0;
  private pending = new Map<() => void, number>();
  after = (ms: number, callback: () => void) => {
    this.pending.set(callback, this.now + ms);
    return () => {
      this.pending.delete(callback);
    };
  };
  advance(ms: number) {
    const end = this.now + ms;
    while (true) {
      const next = [...this.pending].sort(([, left], [, right]) => left - right)[0];
      if (next === undefined || next[1] > end) break;
      this.now = next[1];
      this.pending.delete(next[0]);
      next[0]();
    }
    this.now = end;
  }
}
