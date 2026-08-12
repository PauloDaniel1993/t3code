import type { WayfinderMap, WayfinderMapsSnapshot, WayfinderNode } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  autoStarMapScope,
  initialStarMapPanelState,
  resolveStarMapScope,
  starMapPanelReducer,
  workspaceRootLabel,
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

  describe("reset", () => {
    it("drops the whole navigation stack when the panel switches roots", () => {
      expect(starMapPanelReducer(atTicketLevel, { type: "reset" })).toEqual(
        initialStarMapPanelState,
      );
    });

    it("clears a map-removed notice that belonged to the previous root", () => {
      expect(starMapPanelReducer(afterMapRemoved, { type: "reset" })).toEqual(
        initialStarMapPanelState,
      );
    });

    it("is a no-op at the map list, so the mount-time reset changes nothing", () => {
      expect(starMapPanelReducer(initialStarMapPanelState, { type: "reset" })).toBe(
        initialStarMapPanelState,
      );
    });
  });
});

const roots = { projectCwd: "/repo", worktreeCwd: "/repo/.t3/worktrees/feature-a" };

describe("resolveStarMapScope", () => {
  it("reads the project root and hides the control when the thread has no worktree", () => {
    expect(resolveStarMapScope({ projectCwd: "/repo", worktreeCwd: null, scope: null })).toEqual({
      scope: "project",
      cwd: "/repo",
      canToggle: false,
    });
  });

  it("hides the control when the worktree path is the project root itself", () => {
    expect(
      resolveStarMapScope({ projectCwd: "/repo", worktreeCwd: "/repo", scope: "worktree" }),
    ).toEqual({ scope: "project", cwd: "/repo", canToggle: false });
  });

  it("defaults an undecided worktree thread to its own root", () => {
    expect(resolveStarMapScope({ ...roots, scope: null })).toEqual({
      scope: "worktree",
      cwd: roots.worktreeCwd,
      canToggle: true,
    });
  });

  it("reads the project root when that is the chosen scope", () => {
    expect(resolveStarMapScope({ ...roots, scope: "project" })).toEqual({
      scope: "project",
      cwd: "/repo",
      canToggle: true,
    });
  });
});

describe("autoStarMapScope", () => {
  it("waits while either snapshot is still loading", () => {
    expect(autoStarMapScope({ worktreeMapCount: null, projectMapCount: 3 })).toBeNull();
    expect(autoStarMapScope({ worktreeMapCount: 0, projectMapCount: null })).toBeNull();
  });

  it("falls back to the project root only when the worktree is empty and it is not", () => {
    expect(autoStarMapScope({ worktreeMapCount: 0, projectMapCount: 3 })).toBe("project");
  });

  it("keeps the thread's own root whenever the worktree has maps", () => {
    expect(autoStarMapScope({ worktreeMapCount: 1, projectMapCount: 9 })).toBe("worktree");
  });

  it("keeps the thread's own root when neither has maps, so the empty state names it", () => {
    expect(autoStarMapScope({ worktreeMapCount: 0, projectMapCount: 0 })).toBe("worktree");
  });
});

describe("workspaceRootLabel", () => {
  it("labels a root by its last segment on either path separator", () => {
    expect(workspaceRootLabel("/repo/.t3/worktrees/feature-a")).toBe("feature-a");
    expect(workspaceRootLabel("C:\\repo\\.t3\\worktrees\\feature-a")).toBe("feature-a");
  });

  it("ignores a trailing separator", () => {
    expect(workspaceRootLabel("/repo/feature-a/")).toBe("feature-a");
  });
});
