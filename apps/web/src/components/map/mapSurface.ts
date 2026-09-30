import { Map as MapIcon } from "lucide-react";

/**
 * How the Map surface presents itself in the right panel's launcher, add menu and tab. Kept
 * here so `RightPanelTabs` only registers the entries instead of owning the copy.
 */
export const MAP_SURFACE = {
  title: "Map",
  icon: MapIcon,
  /** Entry in the empty-state launcher. */
  emptyState: {
    label: "Map",
    description: "See this project's tickets and blockers as a star map.",
    icon: MapIcon,
    // Device owns M, so the map takes S (for star map).
    shortcut: "S",
    disabledReason: "Available when a project is open.",
  },
  /** Entry in the add-surface menu. */
  menu: {
    label: "Map",
    icon: MapIcon,
    shortcut: "S",
    disabledReason: "Maps are only available when a project is open.",
  },
} as const;
