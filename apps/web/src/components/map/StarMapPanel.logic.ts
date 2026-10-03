import type { WayfinderMap, WayfinderMapsSnapshot, WayfinderNode } from "@t3tools/contracts";

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

/**
 * The message the map's "start as tasks" actions send to the panel's thread.
 * The client does not pick models: the thread's agent reads the map, where a
 * map that routes work by complexity says which model each tier runs on.
 */
export function buildStartTicketsAsTasksPrompt(
  map: Pick<WayfinderMap, "title" | "mapRelativePath">,
  tickets: ReadonlyArray<Pick<WayfinderNode, "ordinal" | "label" | "relativePath">>,
): string {
  const lines = [...tickets]
    .sort((left, right) => left.ordinal - right.ordinal)
    .map((ticket) => `- ${ticket.ordinal}. ${ticket.label} (\`${ticket.relativePath}\`)`);
  const subject = tickets.length === 1 ? "this ticket" : `these ${tickets.length} tickets`;
  return [
    `Start ${subject} from the map "${map.title}" (\`${map.mapRelativePath}\`) as T3 Code tasks, one task per ticket, all in parallel:`,
    "",
    ...lines,
    "",
    "Re-read the map and each ticket first, and skip any ticket that is no longer open and unblocked. Give each task a self-contained prompt built from its ticket.",
    "",
    "Choose each task's model by the ticket's complexity: use the tier or model the ticket names, routed through the map's model rules. Where a ticket names neither, judge its complexity against those rules. Call task_models before creating the tasks; if a model the rules ask for is unavailable, or the map has no routing rules, say so instead of substituting silently. Follow the map's notes on how tickets run, and reply with the model each ticket went to and any ticket you skipped.",
  ].join("\n");
}

/** Tickets picked to start as tasks, owned by the map they were picked on. */
export interface StarMapTicketSelection {
  readonly mapId: string | null;
  readonly ticketIds: ReadonlySet<string>;
}

export const EMPTY_STAR_MAP_TICKET_SELECTION: StarMapTicketSelection = {
  mapId: null,
  ticketIds: new Set(),
};

/**
 * The selection for the open map: empty after a map switch, and only tickets
 * that are still ready, so a choice never comes back without another click.
 * Returns the same object when nothing changed.
 */
export function reconcileTicketSelection(
  selection: StarMapTicketSelection,
  mapId: string | null,
  readyTicketIds: ReadonlySet<string>,
): StarMapTicketSelection {
  if (selection.mapId !== mapId) return { mapId, ticketIds: new Set() };
  const kept = [...selection.ticketIds].filter((id) => readyTicketIds.has(id));
  return kept.length === selection.ticketIds.size ? selection : { mapId, ticketIds: new Set(kept) };
}

export function toggleTicketSelection(
  selection: StarMapTicketSelection,
  ticketId: string,
): StarMapTicketSelection {
  const ticketIds = new Set(selection.ticketIds);
  if (!ticketIds.delete(ticketId)) ticketIds.add(ticketId);
  return { mapId: selection.mapId, ticketIds };
}

/** Drops a sent batch from the selection, leaving picks made since then alone. */
export function removeSubmittedTickets(
  selection: StarMapTicketSelection,
  mapId: string,
  submittedTicketIds: ReadonlyArray<string>,
): StarMapTicketSelection {
  if (selection.mapId !== mapId) return selection;
  const ticketIds = new Set(selection.ticketIds);
  for (const id of submittedTicketIds) ticketIds.delete(id);
  return ticketIds.size === selection.ticketIds.size ? selection : { mapId, ticketIds };
}
