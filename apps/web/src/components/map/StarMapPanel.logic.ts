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
    case "syncSnapshot":
      return reconcileWithSnapshot(state, action.snapshot);
  }
}
