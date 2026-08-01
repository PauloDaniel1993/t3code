import type { WayfinderMap, WayfinderMapsSnapshot, WayfinderNode } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  initialStarMapPanelState,
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
