import { getSidebarThreadIdsToPrewarm } from "./Sidebar.logic";

export interface SidebarTaskLeaseClock {
  after: (ms: number, callback: () => void) => () => void;
}
export const sidebarTaskLeaseClock: SidebarTaskLeaseClock = {
  after: (ms, callback) => {
    const timer = setTimeout(callback, ms);
    return () => clearTimeout(timer);
  },
};

/** Reuse upstream's prewarm shortlist/cap (3). Visible groups outrank release grace. */
export function createSidebarTaskLeases(clock = sidebarTaskLeaseClock) {
  const entries = new Map<
    string,
    {
      subscribers: Map<(leased: boolean) => void, () => number>;
      visible: boolean;
      ready: boolean;
      leased: boolean;
      top: number;
      cancel?: () => void;
    }
  >();
  const reconcile = () => {
    const candidates = [...entries.entries()]
      .filter(([, entry]) => entry.ready)
      .sort(
        ([, left], [, right]) =>
          Number(right.visible) - Number(left.visible) || left.top - right.top,
      );
    const allowed = new Set(getSidebarThreadIdsToPrewarm(candidates.map(([key]) => key)));
    // Release first, so replacing a lease never briefly exceeds the cap.
    for (const [key, entry] of entries) {
      if (entry.leased && !allowed.has(key)) {
        entry.leased = false;
        for (const notify of entry.subscribers.keys()) notify(false);
      }
    }
    for (const [key, entry] of entries)
      if (!entry.leased && allowed.has(key)) {
        entry.leased = true;
        for (const notify of entry.subscribers.keys()) notify(true);
      }
  };
  return {
    register(key: string, notify: (leased: boolean) => void, position = () => Infinity) {
      let entry = entries.get(key);
      if (entry === undefined) {
        entry = {
          subscribers: new Map(),
          visible: false,
          ready: false,
          leased: false,
          top: Infinity,
        };
        entries.set(key, entry);
      }
      entry.subscribers.set(notify, position);
      if (entry.leased) notify(true);
      return () => {
        entry.subscribers.delete(notify);
        if (entry.leased) notify(false);
        if (entry.subscribers.size === 0) {
          entry.cancel?.();
          entries.delete(key);
        }
        reconcile();
      };
    },
    // Measure only on scrolling/visibility changes, keeping the shortlist stable at rest.
    refreshPositions() {
      for (const entry of entries.values()) {
        if (entry.visible)
          entry.top = Math.min(...[...entry.subscribers.values()].map((position) => position()));
      }
      reconcile();
    },
    update(key: string, visible: boolean, top = Infinity) {
      const entry = entries.get(key);
      if (entry === undefined) return;
      entry.top = top;
      if (visible === entry.visible) {
        if (entry.ready) reconcile();
        return;
      }
      const wasReady = entry.ready;
      entry.cancel?.();
      entry.visible = visible;
      if (visible) {
        if (!entry.leased) {
          entry.ready = false;
          entry.cancel = clock.after(250, () => {
            entry.ready = true;
            reconcile();
          });
        }
      } else if (entry.leased) {
        entry.cancel = clock.after(4000, () => {
          entry.ready = false;
          reconcile();
        });
      } else entry.ready = false;
      if (entry.ready || wasReady) reconcile();
    },
  };
}

export const sidebarTaskLeases = createSidebarTaskLeases();
