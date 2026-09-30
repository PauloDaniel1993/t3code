import { useEffect, useState } from "react";
import { sidebarTaskLeases } from "./sidebarTaskLeases";

/** Observe expanded groups, not parent cards. A lease survives short viewport exits. */
export function useSidebarTaskVisibility(enabled: boolean, key: string) {
  const [row, rowRef] = useState<HTMLElement | null>(null);
  const [visibility, setVisibility] = useState<{ row: HTMLElement; visible: boolean } | null>(null);
  const [leased, setLeased] = useState(false);
  useEffect(() => sidebarTaskLeases.register(key, setLeased), [key]);
  useEffect(() => {
    if (!enabled || row === null) {
      sidebarTaskLeases.update(key, false);
      return;
    }
    const update = (onScreen: boolean, distance = 0) => {
      setVisibility((previous) =>
        previous?.row === row && previous.visible === onScreen
          ? previous
          : { row, visible: onScreen },
      );
      sidebarTaskLeases.update(key, onScreen, distance);
    };
    if (typeof IntersectionObserver === "undefined") {
      update(true);
      return () => sidebarTaskLeases.update(key, false);
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        const bounds = entry?.boundingClientRect;
        const viewport = entry?.rootBounds;
        const distance =
          bounds === undefined || viewport == null
            ? 0
            : Math.abs((bounds.top + bounds.bottom - viewport.top - viewport.bottom) / 2);
        update(entry?.isIntersecting === true, distance);
      },
      { root: row.closest<HTMLElement>('[data-slot="scroll-area-viewport"]') },
    );
    observer.observe(row.closest<HTMLElement>("li") ?? row);
    return () => {
      observer.disconnect();
      sidebarTaskLeases.update(key, false);
    };
  }, [enabled, row, key]);
  return {
    visible: enabled && visibility?.row === row && visibility?.visible === true,
    leased,
    rowRef,
  };
}
