import { GitBranch } from "lucide-react";

export const FLOW_SURFACE = {
  title: "Flow",
  icon: GitBranch,
  emptyState: {
    label: "Flow",
    description: "Design and monitor project flows.",
    icon: GitBranch,
    shortcut: "W",
    disabledReason: "Available when a project is open.",
  },
  menu: {
    label: "Flow",
    icon: GitBranch,
    shortcut: "W",
    disabledReason: "Available when a project is open.",
  },
} as const;
