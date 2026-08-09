import type { WayfinderMapsSnapshot } from "@t3tools/contracts";

/**
 * Navigation state for the star map panel: a three-level push stack of
 * `Maps → Map → Ticket`. All transitions live here so they stay testable
 * under the Node test harness; the component only dispatches. Actions that
 * change nothing return the same state reference so React can bail out.
 */
export type StarMapPanelLevel = "maps" | "map" | "ticket";

/**
 * Transient, dismissible panel notice. `"map-removed"` is set when a snapshot
 * drops the map the user was looking at: the navigation fall-back alone would
 * be a silent jump to the map list, so the reducer records WHY it happened
 * and the component renders a dismissible banner. Task 9.3.
 */
export type StarMapPanelNotice = "map-removed";

export interface StarMapPanelState {
  readonly level: StarMapPanelLevel;
  readonly selectedMapId: string | null;
  /** Ticket node id within the selected map. */
  readonly selectedTicket: string | null;
  readonly notice: StarMapPanelNotice | null;
}

export type StarMapPanelAction =
  | { readonly type: "selectMap"; readonly mapId: string }
  | { readonly type: "selectTicket"; readonly ticketId: string }
  | { readonly type: "back" }
  | { readonly type: "escape" }
  | { readonly type: "dismissNotice" }
  | { readonly type: "reset" }
  | { readonly type: "syncSnapshot"; readonly snapshot: WayfinderMapsSnapshot };

export const initialStarMapPanelState: StarMapPanelState = {
  level: "maps",
  selectedMapId: null,
  selectedTicket: null,
  notice: null,
};

function goBackOneLevel(state: StarMapPanelState): StarMapPanelState {
  switch (state.level) {
    case "ticket":
      return { ...state, level: "map", selectedTicket: null };
    case "map":
      return { ...state, level: "maps", selectedMapId: null, selectedTicket: null };
    case "maps":
      return state;
  }
}

/**
 * Re-points navigation at a freshly received snapshot. A selected ticket that
 * vanished drops back to the map level rather than rendering an empty detail
 * view; a selected map that vanished (the agent deleted `.plan/<effort>/`)
 * drops back to the map list — where the panel's empty states take over — and
 * raises the `"map-removed"` notice so the jump is explained, not silent.
 */
function reconcileWithSnapshot(
  state: StarMapPanelState,
  snapshot: WayfinderMapsSnapshot,
): StarMapPanelState {
  if (state.selectedMapId === null) return state;
  const selectedMap = snapshot.maps.find((map) => map.id === state.selectedMapId);
  if (!selectedMap) {
    return {
      level: "maps",
      selectedMapId: null,
      selectedTicket: null,
      notice: "map-removed",
    };
  }
  if (state.selectedTicket === null) return state;
  const ticketExists = selectedMap.nodes.some((node) => node.id === state.selectedTicket);
  if (ticketExists) return state;
  return { ...state, level: "map", selectedTicket: null };
}

export function starMapPanelReducer(
  state: StarMapPanelState,
  action: StarMapPanelAction,
): StarMapPanelState {
  switch (action.type) {
    case "selectMap":
      return { level: "map", selectedMapId: action.mapId, selectedTicket: null, notice: null };
    case "selectTicket":
      // A ticket only exists below a map; ignore stray selections at the root.
      if (state.selectedMapId === null) return state;
      return { ...state, level: "ticket", selectedTicket: action.ticketId };
    case "back":
    case "escape":
      return goBackOneLevel(state);
    case "dismissNotice":
      if (state.notice === null) return state;
      return { ...state, notice: null };
    case "reset":
      // Used when the panel switches roots: the map the user was looking at
      // belongs to the old root, and `syncSnapshot` would explain its absence
      // with a "removed from disk" notice that is simply untrue here.
      return state === initialStarMapPanelState ||
        (state.level === "maps" && state.selectedMapId === null && state.notice === null)
        ? state
        : initialStarMapPanelState;
    case "syncSnapshot":
      return reconcileWithSnapshot(state, action.snapshot);
  }
}

/** Which workspace root the panel reads `.plan` from. */
export type StarMapScope = "worktree" | "project";

export interface StarMapScopeInput {
  readonly projectCwd: string;
  /** The thread's worktree, or null when it runs in the project root itself. */
  readonly worktreeCwd: string | null;
  /** The user's persisted choice, or the latched automatic one; null while undecided. */
  readonly scope: StarMapScope | null;
}

export interface StarMapScopeResolution {
  readonly scope: StarMapScope;
  readonly cwd: string;
  /** A scope control only earns its space when the two roots actually differ. */
  readonly canToggle: boolean;
}

/**
 * Resolves the root the panel reads and whether the scope control applies. The
 * thread's own worktree wins by default: it is where the agent is working, and
 * every relative path in the snapshot has to resolve against the same root the
 * ticket detail reads from.
 */
export function resolveStarMapScope(input: StarMapScopeInput): StarMapScopeResolution {
  const { projectCwd, worktreeCwd } = input;
  if (worktreeCwd === null || worktreeCwd === projectCwd) {
    return { scope: "project", cwd: projectCwd, canToggle: false };
  }
  const scope = input.scope ?? "worktree";
  return { scope, cwd: scope === "worktree" ? worktreeCwd : projectCwd, canToggle: true };
}

/**
 * The scope to latch when the user has not chosen one, or null while either
 * snapshot is still loading — the caller keeps waiting rather than latching a
 * guess it would then have to take back under the user. `.plan/` is rarely
 * committed to a feature branch, so an empty worktree beside a populated
 * project root is the one case worth leaving the thread's own root for.
 */
/** Last path segment of a workspace root, for labelling the scope control. */
export function workspaceRootLabel(cwd: string): string {
  const segments = cwd.split(/[\\/]/).filter((segment) => segment.length > 0);
  return segments.at(-1) ?? cwd;
}

export function autoStarMapScope(input: {
  readonly worktreeMapCount: number | null;
  readonly projectMapCount: number | null;
}): StarMapScope | null {
  if (input.worktreeMapCount === null || input.projectMapCount === null) return null;
  return input.worktreeMapCount === 0 && input.projectMapCount > 0 ? "project" : "worktree";
}
