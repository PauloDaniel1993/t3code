import { msg } from "gt-react";
import { Map as MapIcon } from "lucide-react";

/**
 * How the Map surface presents itself in the right panel's launcher, add menu and tab. Kept
 * here so `RightPanelTabs` only registers the entries instead of owning the copy.
 */
export const MAP_SURFACE = {
  title: msg("Map", { $context: "noun, wayfinder map" }),
  icon: MapIcon,
  /** Entry in the empty-state launcher. */
  emptyState: {
    label: msg("Map", { $context: "noun, wayfinder map" }),
    description: msg("See this project's tickets and blockers as a star map."),
    icon: MapIcon,
    // Device owns M, so the map takes S (for star map).
    shortcut: "S",
    disabledReason: msg("Available when a project is open."),
  },
  /** Entry in the add-surface menu. */
  menu: {
    label: msg("Map", { $context: "noun, wayfinder map" }),
    icon: MapIcon,
    shortcut: "S",
    disabledReason: msg("Maps are only available when a project is open."),
  },
} as const;
