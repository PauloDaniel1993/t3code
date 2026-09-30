import { useEffect, useState } from "react";
import { sidebarTaskLeases } from "./sidebarTaskLeases";

const scrollRoots = new Map<HTMLElement, { users: number; release: () => void }>();

/** One geometry refresh per scroll frame, shared by all expanded groups in a viewport. */
function observeScroll(root: HTMLElement | null) {
  if (root === null) return () => {};
  const existing = scrollRoots.get(root);
  if (existing !== undefined) existing.users++;
  else {
    let frame: number | undefined;
    const scroll = () => {
      if (frame !== undefined) return;
      frame = requestAnimationFrame(() => {
        frame = undefined;
        sidebarTaskLeases.refreshPositions();
      });
    };
    root.addEventListener("scroll", scroll, { passive: true });
    scrollRoots.set(root, {
      users: 1,
      release: () => {
        root.removeEventListener("scroll", scroll);
        if (frame !== undefined) cancelAnimationFrame(frame);
      },
    });
  }
  return () => {
    const entry = scrollRoots.get(root);
    if (entry !== undefined && --entry.users === 0) {
      entry.release();
      scrollRoots.delete(root);
    }
  };
}

/** Observe expanded groups, not parent cards. A lease survives short viewport exits. */
export function useSidebarTaskVisibility(enabled: boolean, key: string) {
  const [row, rowRef] = useState<HTMLElement | null>(null);
  const [visibility, setVisibility] = useState<{ row: HTMLElement; visible: boolean } | null>(null);
  const [leased, setLeased] = useState(false);
  useEffect(
    () =>
      sidebarTaskLeases.register(key, setLeased, () =>
        row === null
          ? Infinity
          : (row.closest<HTMLElement>("li") ?? row).getBoundingClientRect().top,
      ),
    [key, row],
  );
  useEffect(() => {
    if (!enabled || row === null) {
      sidebarTaskLeases.update(key, false);
      return;
    }
    const viewport = row.closest<HTMLElement>('[data-slot="scroll-area-viewport"]');
    const target = row.closest<HTMLElement>("li") ?? row;
    const update = (onScreen: boolean, top = 0) => {
      setVisibility((previous) =>
        previous?.row === row && previous.visible === onScreen
          ? previous
          : { row, visible: onScreen },
      );
      sidebarTaskLeases.update(key, onScreen, top);
    };
    if (typeof IntersectionObserver === "undefined") {
      update(true);
      return () => sidebarTaskLeases.update(key, false);
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        update(entry?.isIntersecting === true, entry?.boundingClientRect?.top ?? 0);
      },
      { root: viewport },
    );
    observer.observe(target);
    const releaseScroll = observeScroll(viewport);
    return () => {
      observer.disconnect();
      releaseScroll();
      sidebarTaskLeases.update(key, false);
    };
  }, [enabled, row, key]);
  return {
    visible: enabled && visibility?.row === row && visibility?.visible === true,
    leased,
    rowRef,
  };
}
