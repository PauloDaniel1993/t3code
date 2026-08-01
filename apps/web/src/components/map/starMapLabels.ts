/**
 * Deterministic screen-space label placement for the star map. Text is never
 * measured (that would need a canvas); widths are estimated from a fixed
 * per-character width so placement is pure, reproducible, and testable in
 * Node. Labels sit at a fixed offset right of their star; collisions are
 * resolved greedily in ascending ticket order, so the lower ticket number
 * always wins and the same input yields the same set of visible labels.
 *
 * Below `STAR_MAP_NARROW_LABEL_THRESHOLD` every label degrades to its ticket
 * number — the panel that narrow has no room for titles.
 */

export const STAR_MAP_NARROW_LABEL_THRESHOLD = 300;

/** Pixels between the star center and the left edge of its label. */
export const STAR_MAP_LABEL_OFFSET_X = 10;
/** Estimated width per character at the label font size. */
export const STAR_MAP_LABEL_CHAR_WIDTH = 7;
export const STAR_MAP_LABEL_HEIGHT = 16;
/** Extra gap treated as part of each label box when testing collisions. */
const COLLISION_GAP = 2;

export interface StarMapLabelNode {
  readonly id: string;
  /** The ticket number, used for ordering and for degraded label text. */
  readonly ordinal: number;
  readonly label: string;
  /** Star position in screen pixels. */
  readonly x: number;
  readonly y: number;
}

export interface StarMapLabelPlacement {
  readonly id: string;
  /** The text to draw — the label, or the ticket number when degraded. */
  readonly text: string;
  /** Left edge of the text in screen pixels. */
  readonly x: number;
  /** Vertical center of the text in screen pixels (draw with a middle baseline). */
  readonly y: number;
  /** True when this placement shows the ticket number instead of the label. */
  readonly degraded: boolean;
  /** True when this label lost a collision and must not be drawn. */
  readonly suppressed: boolean;
}

interface LabelBox {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/** The drawn box of a placement, in screen pixels. Shared by layout and hit-testing. */
export function labelBox(placement: StarMapLabelPlacement): LabelBox {
  return {
    minX: placement.x,
    minY: placement.y - STAR_MAP_LABEL_HEIGHT / 2,
    maxX: placement.x + placement.text.length * STAR_MAP_LABEL_CHAR_WIDTH,
    maxY: placement.y + STAR_MAP_LABEL_HEIGHT / 2,
  };
}

/**
 * The ticket whose label covers `screenPoint`, or null. A suppressed label is
 * not drawn, so it must not be clickable either — what you can hit is exactly
 * what you can see. Ties go to the earlier placement, matching draw order.
 */
export function hitTestStarMapLabels(
  placements: ReadonlyArray<StarMapLabelPlacement>,
  screenPoint: { readonly x: number; readonly y: number },
): string | null {
  for (const placement of placements) {
    if (placement.suppressed) continue;
    const box = labelBox(placement);
    if (
      screenPoint.x >= box.minX &&
      screenPoint.x <= box.maxX &&
      screenPoint.y >= box.minY &&
      screenPoint.y <= box.maxY
    ) {
      return placement.id;
    }
  }
  return null;
}

function boxesCollide(left: LabelBox, right: LabelBox): boolean {
  return (
    left.minX < right.maxX + COLLISION_GAP &&
    left.maxX + COLLISION_GAP > right.minX &&
    left.minY < right.maxY + COLLISION_GAP &&
    left.maxY + COLLISION_GAP > right.minY
  );
}

export function placeStarMapLabels(input: {
  readonly nodes: ReadonlyArray<StarMapLabelNode>;
  /** Canvas width in CSS pixels; below the threshold labels degrade. */
  readonly viewportWidth: number;
}): ReadonlyArray<StarMapLabelPlacement> {
  const degraded = input.viewportWidth < STAR_MAP_NARROW_LABEL_THRESHOLD;
  const ordered = [...input.nodes].sort(
    (left, right) =>
      left.ordinal - right.ordinal || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
  );

  const visibleBoxes: Array<LabelBox> = [];
  return ordered.map((node) => {
    const text = degraded ? String(node.ordinal) : node.label;
    const box: LabelBox = {
      minX: node.x + STAR_MAP_LABEL_OFFSET_X,
      minY: node.y - STAR_MAP_LABEL_HEIGHT / 2,
      maxX: node.x + STAR_MAP_LABEL_OFFSET_X + text.length * STAR_MAP_LABEL_CHAR_WIDTH,
      maxY: node.y + STAR_MAP_LABEL_HEIGHT / 2,
    };
    const suppressed = visibleBoxes.some((visible) => boxesCollide(box, visible));
    if (!suppressed) {
      visibleBoxes.push(box);
    }
    return { id: node.id, text, x: box.minX, y: node.y, degraded, suppressed };
  });
}
