import { type WayfinderMapsFailure, WayfinderMapsError } from "@t3tools/contracts";

import type * as WayfinderMaps from "./WayfinderMaps.ts";

function failureContext(error: WayfinderMaps.WayfinderMapsError): {
  readonly failure: WayfinderMapsFailure;
  readonly normalizedCwd?: string;
  readonly detail?: string;
} {
  switch (error._tag) {
    case "WayfinderMapsCapacityError":
      return { failure: "capacity_reached" };
    case "WorkspaceRootNotExistsError":
      return {
        failure: "workspace_root_not_found",
        normalizedCwd: error.normalizedWorkspaceRoot,
      };
    case "WorkspaceRootCreateFailedError":
      return {
        failure: "workspace_root_create_failed",
        normalizedCwd: error.normalizedWorkspaceRoot,
      };
    case "WorkspaceRootStatFailedError":
      return {
        failure: "workspace_root_stat_failed",
        normalizedCwd: error.normalizedWorkspaceRoot,
        detail: error.phase,
      };
    case "WorkspaceRootNotDirectoryError":
      return {
        failure: "workspace_root_not_directory",
        normalizedCwd: error.normalizedWorkspaceRoot,
      };
    case "WorkspacePathOutsideRootError":
      return { failure: "workspace_path_outside_root" };
    default: {
      const unhandled: never = error;
      throw new Error(`Unhandled Wayfinder maps error: ${String(unhandled)}`);
    }
  }
}

/** Maps the reader's failures onto the wire error clients decode. */
export function toWayfinderMapsRpcError(
  cwd: string,
  cause: WayfinderMaps.WayfinderMapsError,
): WayfinderMapsError {
  return new WayfinderMapsError({
    cwd,
    ...failureContext(cause),
    message: cause.message,
    cause,
  });
}
