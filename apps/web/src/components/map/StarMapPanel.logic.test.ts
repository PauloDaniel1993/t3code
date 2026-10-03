import type { WayfinderMap, WayfinderMapsSnapshot, WayfinderNode } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_STAR_MAP_TICKET_SELECTION,
  buildStartTicketsAsTasksPrompt,
  initialStarMapPanelState,
  reconcileTicketSelection,
  removeSubmittedTickets,
  toggleTicketSelection,
  starMapPanelReducer,
  type StarMapPanelState,
} from "./StarMapPanel.logic";

function makeNode(id: string, ordinal: number): WayfinderNode {
  return {
    id,
    ordinal,
    label: `Ticket ${id}`,
    relativePath: `.plan/effort/tickets/${id}.md`,
    type: "ticket",
    status: "open",
    isFrontier: false,
    isUndermined: false,
    claimedBy: null,
    rank: 0,
    cyclic: false,
  };
}

function makeMap(id: string, nodeIds: ReadonlyArray<string>): WayfinderMap {
  return {
    id,
    dialect: "frontmatter",
    title: `Map ${id}`,
    mapRelativePath: `.plan/${id}/map.md`,
    destination: "",
    notes: [],
    nodes: nodeIds.map((nodeId, index) => makeNode(nodeId, index + 1)),
    edges: [],
    fog: [],
    decisions: [],
    outOfScope: [],
    counts: {
      total: nodeIds.length,
      open: nodeIds.length,
      claimed: 0,
      resolved: 0,
      outOfScope: 0,
      frontier: 0,
    },
    truncated: false,
  };
}

function makeSnapshot(...maps: ReadonlyArray<WayfinderMap>): WayfinderMapsSnapshot {
  return { maps, lints: [], truncated: false };
}

const atTicketLevel: StarMapPanelState = {
  level: "ticket",
  selectedMapId: "effort-a",
  selectedTicket: "01",
  notice: null,
};

const atMapLevel: StarMapPanelState = {
  level: "map",
  selectedMapId: "effort-a",
  selectedTicket: null,
  notice: null,
};

const afterMapRemoved: StarMapPanelState = {
  ...initialStarMapPanelState,
  notice: "map-removed",
};

describe("starMapPanelReducer", () => {
  describe("back transitions", () => {
    it("moves from ticket back to its map, clearing the ticket", () => {
      expect(starMapPanelReducer(atTicketLevel, { type: "back" })).toEqual(atMapLevel);
    });

    it("moves from a map back to the map list, clearing the selection", () => {
      expect(starMapPanelReducer(atMapLevel, { type: "back" })).toEqual(initialStarMapPanelState);
    });

    it("is a no-op at the map list", () => {
      expect(starMapPanelReducer(initialStarMapPanelState, { type: "back" })).toBe(
        initialStarMapPanelState,
      );
    });
  });

  describe("escape transitions", () => {
    it("moves from ticket back to its map without leaving the panel", () => {
      expect(starMapPanelReducer(atTicketLevel, { type: "escape" })).toEqual(atMapLevel);
    });

    it("moves from a map back to the map list", () => {
      expect(starMapPanelReducer(atMapLevel, { type: "escape" })).toEqual(initialStarMapPanelState);
    });

    it("is a no-op at the map list so the panel can let Escape propagate", () => {
      expect(starMapPanelReducer(initialStarMapPanelState, { type: "escape" })).toBe(
        initialStarMapPanelState,
      );
    });
  });

  describe("level pushes", () => {
    it("selecting a map pushes the map level", () => {
      expect(
        starMapPanelReducer(initialStarMapPanelState, { type: "selectMap", mapId: "effort-a" }),
      ).toEqual(atMapLevel);
    });

    it("selecting a ticket pushes the ticket level", () => {
      expect(starMapPanelReducer(atMapLevel, { type: "selectTicket", ticketId: "01" })).toEqual(
        atTicketLevel,
      );
    });

    it("ignores a ticket selection with no map selected", () => {
      expect(
        starMapPanelReducer(initialStarMapPanelState, { type: "selectTicket", ticketId: "01" }),
      ).toBe(initialStarMapPanelState);
    });

    it("selecting another map resets the ticket selection", () => {
      expect(starMapPanelReducer(atTicketLevel, { type: "selectMap", mapId: "effort-b" })).toEqual({
        level: "map",
        selectedMapId: "effort-b",
        selectedTicket: null,
        notice: null,
      });
    });
  });

  describe("snapshot reconciliation", () => {
    it("clears the selection and returns to the map level when the selected ticket vanishes", () => {
      const snapshot = makeSnapshot(makeMap("effort-a", ["02", "03"]));
      expect(starMapPanelReducer(atTicketLevel, { type: "syncSnapshot", snapshot })).toEqual(
        atMapLevel,
      );
    });

    it("keeps the selection when the snapshot still contains the selected ticket", () => {
      const snapshot = makeSnapshot(makeMap("effort-a", ["01", "02"]));
      expect(starMapPanelReducer(atTicketLevel, { type: "syncSnapshot", snapshot })).toBe(
        atTicketLevel,
      );
    });

    it("returns to the map list with the map-removed notice when the selected map vanishes", () => {
      const snapshot = makeSnapshot(makeMap("effort-b", ["01"]));
      expect(starMapPanelReducer(atTicketLevel, { type: "syncSnapshot", snapshot })).toEqual(
        afterMapRemoved,
      );
      expect(starMapPanelReducer(atMapLevel, { type: "syncSnapshot", snapshot })).toEqual(
        afterMapRemoved,
      );
    });

    it("returns to the map list when the snapshot becomes empty, so the no-map empty state shows", () => {
      const snapshot = makeSnapshot();
      const next = starMapPanelReducer(atTicketLevel, { type: "syncSnapshot", snapshot });
      expect(next).toEqual(afterMapRemoved);
      expect(next.level).toBe("maps");
    });

    it("does not raise the notice when only a ticket vanishes", () => {
      const snapshot = makeSnapshot(makeMap("effort-a", ["02"]));
      const next = starMapPanelReducer(atTicketLevel, { type: "syncSnapshot", snapshot });
      expect(next.notice).toBeNull();
    });

    it("clears the notice when the user picks another map", () => {
      expect(
        starMapPanelReducer(afterMapRemoved, { type: "selectMap", mapId: "effort-b" }),
      ).toEqual({ level: "map", selectedMapId: "effort-b", selectedTicket: null, notice: null });
    });

    it("is a no-op when nothing is selected", () => {
      const snapshot = makeSnapshot(makeMap("effort-a", ["01"]));
      expect(
        starMapPanelReducer(initialStarMapPanelState, { type: "syncSnapshot", snapshot }),
      ).toBe(initialStarMapPanelState);
    });
  });

  describe("dismissNotice", () => {
    it("clears a raised notice", () => {
      expect(starMapPanelReducer(afterMapRemoved, { type: "dismissNotice" })).toEqual(
        initialStarMapPanelState,
      );
    });

    it("is a no-op when no notice is raised", () => {
      expect(starMapPanelReducer(initialStarMapPanelState, { type: "dismissNotice" })).toBe(
        initialStarMapPanelState,
      );
    });
  });
});

describe("buildStartTicketsAsTasksPrompt", () => {
  const map = { title: "V2 integration", mapRelativePath: ".scratch/v2/map.md" };

  it("lists the tickets in ordinal order with their files", () => {
    const prompt = buildStartTicketsAsTasksPrompt(map, [
      { ordinal: 12, label: "Port tasks", relativePath: ".scratch/v2/issues/12.md" },
      { ordinal: 3, label: "Brief adapters", relativePath: ".scratch/v2/issues/03.md" },
    ]);
    expect(prompt).toContain(
      'these 2 tickets from the map "V2 integration" (`.scratch/v2/map.md`)',
    );
    expect(prompt.indexOf("- 3. Brief adapters (`.scratch/v2/issues/03.md`)")).toBeLessThan(
      prompt.indexOf("- 12. Port tasks (`.scratch/v2/issues/12.md`)"),
    );
    expect(prompt).toContain("task_models");
  });

  it("names a single ticket in the singular", () => {
    const prompt = buildStartTicketsAsTasksPrompt(map, [
      { ordinal: 1, label: "Only", relativePath: "a.md" },
    ]);
    expect(prompt).toContain("Start this ticket from the map");
  });
});

describe("ticket selection", () => {
  const ready = (...ids: ReadonlyArray<string>) => new Set(ids);

  it("forgets map A's picks after switching to B and back", () => {
    let selection = reconcileTicketSelection(EMPTY_STAR_MAP_TICKET_SELECTION, "a", ready("01"));
    selection = toggleTicketSelection(selection, "01");
    selection = reconcileTicketSelection(selection, "b", ready("02"));
    selection = reconcileTicketSelection(selection, "a", ready("01"));
    expect([...selection.ticketIds]).toEqual([]);
  });

  it("does not bring back a pick once its ticket stopped being ready", () => {
    let selection = toggleTicketSelection(
      reconcileTicketSelection(EMPTY_STAR_MAP_TICKET_SELECTION, "a", ready("01", "02")),
      "01",
    );
    selection = reconcileTicketSelection(selection, "a", ready("02"));
    selection = reconcileTicketSelection(selection, "a", ready("01", "02"));
    expect([...selection.ticketIds]).toEqual([]);
  });

  it("returns the same selection when nothing changed", () => {
    const selection = toggleTicketSelection(
      reconcileTicketSelection(EMPTY_STAR_MAP_TICKET_SELECTION, "a", ready("01")),
      "01",
    );
    expect(reconcileTicketSelection(selection, "a", ready("01", "02"))).toBe(selection);
  });

  it("removes only the sent batch, keeping picks made while it was in flight", () => {
    let selection = reconcileTicketSelection(
      EMPTY_STAR_MAP_TICKET_SELECTION,
      "a",
      ready("01", "02"),
    );
    selection = toggleTicketSelection(toggleTicketSelection(selection, "01"), "02");
    expect([...removeSubmittedTickets(selection, "a", ["01"]).ticketIds]).toEqual(["02"]);
    const onOtherMap = toggleTicketSelection(
      reconcileTicketSelection(selection, "b", ready("05")),
      "05",
    );
    expect(removeSubmittedTickets(onOtherMap, "a", ["01", "02"])).toBe(onOtherMap);
  });
});
