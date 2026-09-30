import type { EnvironmentId } from "@t3tools/contracts";
import { Suspense, lazy } from "react";

const StarMapPanel = lazy(() => import("./StarMapPanel"));

/**
 * The Map right-panel surface. The panel and its stylesheet load on first use, and it is
 * keyed by workspace so switching worktrees starts a fresh map.
 */
export function StarMapSurface(props: { environmentId: EnvironmentId; cwd: string }) {
  return (
    <Suspense fallback={null}>
      <StarMapPanel
        key={`${props.environmentId}:${props.cwd}`}
        environmentId={props.environmentId}
        cwd={props.cwd}
      />
    </Suspense>
  );
}
