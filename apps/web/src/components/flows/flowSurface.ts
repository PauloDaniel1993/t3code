import { msg } from "gt-react";
import { Workflow } from "lucide-react";

export const FLOW_SURFACE = {
  title: msg("Flow"),
  icon: Workflow,
  emptyState: {
    label: msg("Flow", { $context: "noun, the Flow panel" }),
    description: msg("Design and monitor project flows."),
    icon: Workflow,
    shortcut: "W",
    disabledReason: msg("Available when a project is open."),
  },
  menu: {
    label: msg("Flow", { $context: "noun, the Flow panel" }),
    icon: Workflow,
    shortcut: "W",
    disabledReason: msg("Available when a project is open."),
  },
} as const;
