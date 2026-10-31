import { Workflow } from "lucide-react";

export const FLOW_SURFACE = {
  title: "Flow",
  icon: Workflow,
  emptyState: {
    label: "Flow",
    description: "Design and monitor project flows.",
    icon: Workflow,
    shortcut: "W",
    disabledReason: "Available when a project is open.",
  },
  menu: {
    label: "Flow",
    icon: Workflow,
    shortcut: "W",
    disabledReason: "Available when a project is open.",
  },
} as const;
