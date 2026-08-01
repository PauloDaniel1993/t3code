import { describe, expect, it } from "vite-plus/test";

import {
  hitTestStarMapLabels,
  placeStarMapLabels,
  STAR_MAP_LABEL_CHAR_WIDTH,
  STAR_MAP_LABEL_OFFSET_X,
  STAR_MAP_NARROW_LABEL_THRESHOLD,
  type StarMapLabelNode,
} from "./starMapLabels";

function labelNode(
  ordinal: number,
  x: number,
  y: number,
  label = `Ticket ${ordinal}`,
): StarMapLabelNode {
  return { id: `t${ordinal}`, ordinal, label, x, y };
}

describe("placeStarMapLabels", () => {
  it("anchors each label right of its star, centered vertically", () => {
    const [placement] = placeStarMapLabels({
      nodes: [labelNode(3, 100, 200)],
      viewportWidth: 500,
    });
    expect(placement).toEqual({
      id: "t3",
      text: "Ticket 3",
      x: 100 + STAR_MAP_LABEL_OFFSET_X,
      y: 200,
      degraded: false,
      suppressed: false,
    });
  });

  it("is deterministic and independent of input order", () => {
    const nodes = [labelNode(1, 10, 10), labelNode(2, 40, 40), labelNode(3, 70, 70)];
    const first = placeStarMapLabels({ nodes, viewportWidth: 500 });
    const second = placeStarMapLabels({ nodes: nodes.toReversed(), viewportWidth: 500 });
    expect(second).toEqual(first);
    expect(placeStarMapLabels({ nodes, viewportWidth: 500 })).toEqual(first);
  });

  it("suppresses the higher ticket number when labels collide", () => {
    const placements = placeStarMapLabels({
      nodes: [labelNode(7, 100, 100), labelNode(2, 104, 102)],
      viewportWidth: 500,
    });
    const byId = new Map(placements.map((placement) => [placement.id, placement]));
    expect(byId.get("t2")?.suppressed).toBe(false);
    expect(byId.get("t7")?.suppressed).toBe(true);
  });

  it("keeps far-apart labels visible", () => {
    const placements = placeStarMapLabels({
      nodes: [labelNode(1, 0, 0), labelNode(2, 300, 300), labelNode(3, -300, -300)],
      viewportWidth: 800,
    });
    expect(placements.every((placement) => !placement.suppressed)).toBe(true);
  });

  it("accounts for label text width when testing collisions", () => {
    // The boxes do not overlap vertically-offset neighbors but a long label on
    // the lower ticket reaches across the higher ticket's box.
    const longLabel = "A considerably long decision title";
    const placements = placeStarMapLabels({
      nodes: [
        labelNode(1, 0, 0, longLabel),
        labelNode(2, longLabel.length * STAR_MAP_LABEL_CHAR_WIDTH - 10, 4),
      ],
      viewportWidth: 800,
    });
    const byId = new Map(placements.map((placement) => [placement.id, placement]));
    expect(byId.get("t1")?.suppressed).toBe(false);
    expect(byId.get("t2")?.suppressed).toBe(true);
  });

  it("degrades to ticket numbers below the narrow-label threshold", () => {
    const nodes = [labelNode(12, 50, 50, "Some long ticket title")];
    const placements = placeStarMapLabels({
      nodes,
      viewportWidth: STAR_MAP_NARROW_LABEL_THRESHOLD - 1,
    });
    expect(placements[0]).toMatchObject({ text: "12", degraded: true, suppressed: false });
  });

  it("shows full labels at and above the threshold", () => {
    const placements = placeStarMapLabels({
      nodes: [labelNode(12, 50, 50, "Some long ticket title")],
      viewportWidth: STAR_MAP_NARROW_LABEL_THRESHOLD,
    });
    expect(placements[0]).toMatchObject({ text: "Some long ticket title", degraded: false });
  });

  it("returns placements in ascending ticket order regardless of input order", () => {
    const placements = placeStarMapLabels({
      nodes: [labelNode(9, 0, 0), labelNode(1, 200, 200), labelNode(5, 400, 400)],
      viewportWidth: 800,
    });
    expect(placements.map((placement) => placement.id)).toEqual(["t1", "t5", "t9"]);
  });

  describe("hitTestStarMapLabels", () => {
    const nodes: ReadonlyArray<StarMapLabelNode> = [
      { id: "t1", ordinal: 1, label: "Pick the store", x: 100, y: 100 },
      { id: "t2", ordinal: 2, label: "Measure the cost", x: 100, y: 106 },
    ];
    const placements = placeStarMapLabels({ nodes, viewportWidth: 800 });
    const visible = placements.find((placement) => !placement.suppressed)!;
    const hidden = placements.find((placement) => placement.suppressed);

    it("hits a ticket by its drawn label, not just its star", () => {
      const inside = {
        x: visible.x + visible.text.length * STAR_MAP_LABEL_CHAR_WIDTH - 1,
        y: visible.y,
      };
      expect(hitTestStarMapLabels(placements, inside)).toBe(visible.id);
    });

    it("misses to the left of the label, where the star's own tolerance applies", () => {
      expect(hitTestStarMapLabels(placements, { x: visible.x - 2, y: visible.y })).toBeNull();
    });

    it("never hits a suppressed label, because it is not drawn", () => {
      if (hidden === undefined) return;
      const inside = { x: hidden.x + 1, y: hidden.y };
      expect(hitTestStarMapLabels(placements, inside)).not.toBe(hidden.id);
    });
  });
});
