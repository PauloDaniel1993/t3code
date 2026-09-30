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
      notify: (leased: boolean) => void;
      visible: boolean;
      ready: boolean;
      leased: boolean;
      distance: number;
      cancel?: () => void;
    }
  >();
  const reconcile = () => {
    const candidates = [...entries.entries()]
      .filter(([, entry]) => entry.ready)
      .sort(
        ([, left], [, right]) =>
          Number(right.visible) - Number(left.visible) || left.distance - right.distance,
      );
    const allowed = new Set(getSidebarThreadIdsToPrewarm(candidates.map(([key]) => key)));
    // Release first, so replacing a lease never briefly exceeds the cap.
    for (const [key, entry] of entries) {
      if (entry.leased && !allowed.has(key)) {
        entry.leased = false;
        entry.notify(false);
      }
    }
    for (const [key, entry] of entries)
      if (!entry.leased && allowed.has(key)) {
        entry.leased = true;
        entry.notify(true);
      }
  };
  return {
    register(key: string, notify: (leased: boolean) => void) {
      const entry = { notify, visible: false, ready: false, leased: false, distance: Infinity };
      entries.set(key, entry);
      return () => {
        const removed = entries.get(key);
        removed?.cancel?.();
        if (removed?.leased) removed.notify(false);
        entries.delete(key);
        reconcile();
      };
    },
    update(key: string, visible: boolean, distance = Infinity) {
      const entry = entries.get(key);
      if (entry === undefined) return;
      entry.distance = distance;
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
