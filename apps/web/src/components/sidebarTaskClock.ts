import { useSyncExternalStore } from "react";

let now = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  if (timer === undefined) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      for (const notify of listeners) notify();
    }, 5000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      clearInterval(timer);
      timer = undefined;
    }
  };
};
const snapshot = () => now;

/** Only rollups subscribe, so ordinary parent rows never receive the five-second tick. */
export function useSidebarTaskClock() {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
