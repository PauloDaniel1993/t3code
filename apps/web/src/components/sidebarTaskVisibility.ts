import { useEffect, useMemo, useState } from "react";

/** Task detail has no overscan: lease it only while the parent is on screen. */
export function useSidebarTaskVisibility(enabled: boolean) {
  const [row, rowRef] = useState<HTMLElement | null>(null);
  const lease = useMemo(() => ({ row, enabled }), [row, enabled]);
  const [observation, setObservation] = useState<{ lease: typeof lease; visible: boolean } | null>(
    null,
  );
  useEffect(() => {
    if (!enabled || row === null) return;
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      ([entry]) => setObservation({ lease, visible: entry?.isIntersecting === true }),
      {
        root: row.closest<HTMLElement>('[data-slot="scroll-area-viewport"]'),
      },
    );
    observer.observe(row);
    return () => observer.disconnect();
  }, [enabled, row, lease]);
  return {
    visible:
      enabled &&
      (typeof IntersectionObserver === "undefined" ||
        (observation?.lease === lease && observation.visible)),
    rowRef,
  };
}
