import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Identifies which workspace root to read maps from. Callers pass the same
 * `thread.worktreePath ?? project.workspaceRoot` they use for VCS status, so a
 * worktree thread resolves its map and its ticket links against one root.
 */
export const WayfinderMapsInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
});
export type WayfinderMapsInput = typeof WayfinderMapsInput.Type;

/**
 * Malformed markdown degrades to lints, never to an error. These failures are
 * the genuine faults instead: the workspace root could not be resolved, or a
 * discovered path escaped it. `ws.ts` maps the server-side `WorkspacePaths`
 * errors onto this enum, the same way `projectEntriesFailureContext` does, so
 * the contracts package stays free of any server import.
 */
export const WayfinderMapsFailure = Schema.Literals([
  "workspace_root_not_found",
  "workspace_root_create_failed",
  "workspace_root_stat_failed",
  "workspace_root_not_directory",
  "workspace_path_outside_root",
]);
export type WayfinderMapsFailure = typeof WayfinderMapsFailure.Type;

export class WayfinderMapsError extends Schema.TaggedErrorClass<WayfinderMapsError>()(
  "WayfinderMapsError",
  {
    cwd: Schema.optional(TrimmedNonEmptyString),
    failure: Schema.optional(WayfinderMapsFailure),
    normalizedCwd: Schema.optional(TrimmedNonEmptyString),
    detail: Schema.optional(TrimmedNonEmptyString),
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export const WayfinderNode = Schema.Struct({
  id: Schema.String,
  ordinal: NonNegativeInt,
  label: Schema.String,
  relativePath: Schema.String,
  type: Schema.String,
  status: Schema.Literals(["open", "claimed", "resolved", "out_of_scope"]),
  isFrontier: Schema.Boolean,
  isUndermined: Schema.Boolean,
  claimedBy: Schema.NullOr(Schema.String),
  rank: NonNegativeInt,
  cyclic: Schema.Boolean,
});
export type WayfinderNode = typeof WayfinderNode.Type;

export const WayfinderEdge = Schema.Struct({
  from: Schema.String,
  to: Schema.String,
  kind: Schema.Literals(["blocks", "undermines"]),
});
export type WayfinderEdge = typeof WayfinderEdge.Type;

export const WayfinderFogEntry = Schema.Struct({
  title: Schema.String,
  description: Schema.String,
  clearsWith: Schema.NullOr(Schema.String),
});
export type WayfinderFogEntry = typeof WayfinderFogEntry.Type;

export const WayfinderLint = Schema.Struct({
  code: Schema.Literals([
    "malformed_frontmatter",
    "malformed_map_metadata",
    "unresolved_blocker",
    "snapshot_truncated",
    "map_truncated",
    "ticket_truncated",
  ]),
  message: Schema.String,
  mapId: Schema.optionalKey(Schema.String),
  ticketId: Schema.optionalKey(Schema.String),
});
export type WayfinderLint = typeof WayfinderLint.Type;

export const WayfinderMap = Schema.Struct({
  id: Schema.String,
  // Diagnostic only — no client may branch on this. "plain-lines" is the
  // wayfinder skill's local-markdown tracker (`Type:` / `Status:` /
  // `Blocked by:` lines under `.scratch/<effort>/issues/`).
  dialect: Schema.Literals(["frontmatter", "field-lines", "plain-lines"]),
  title: Schema.String,
  mapRelativePath: Schema.String,
  destination: Schema.String,
  notes: Schema.Array(Schema.String),
  nodes: Schema.Array(WayfinderNode),
  edges: Schema.Array(WayfinderEdge),
  fog: Schema.Array(WayfinderFogEntry),
  decisions: Schema.Array(Schema.String),
  outOfScope: Schema.Array(Schema.String),
  counts: Schema.Struct({
    total: NonNegativeInt,
    open: NonNegativeInt,
    claimed: NonNegativeInt,
    resolved: NonNegativeInt,
    outOfScope: NonNegativeInt,
    frontier: NonNegativeInt,
  }),
  truncated: Schema.Boolean,
});
export type WayfinderMap = typeof WayfinderMap.Type;

export const WayfinderMapsSnapshot = Schema.Struct({
  maps: Schema.Array(WayfinderMap),
  lints: Schema.Array(WayfinderLint),
  truncated: Schema.Boolean,
});
export type WayfinderMapsSnapshot = typeof WayfinderMapsSnapshot.Type;
