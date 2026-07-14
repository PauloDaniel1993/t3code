import type { SidebarProjectGroupingMode } from "@t3tools/contracts";

export const REPOSITORY_GROUPING_LABEL = "Repository grouping";
export const REPOSITORY_GROUPING_DIALOG_LABEL = "Repository grouping...";

export const REPOSITORY_GROUPING_MODE_LABELS: Record<SidebarProjectGroupingMode, string> = {
  repository: "Group by repository",
  repository_path: "Group by repository path",
  separate: "Keep separate",
};

export function describeRepositoryGroupingMode(mode: SidebarProjectGroupingMode): string {
  switch (mode) {
    case "repository":
      return "Projects from the same repository share one sidebar row.";
    case "repository_path":
      return "Projects group only when both the repository and repo-relative path match.";
    case "separate":
      return "Every project path gets its own sidebar row.";
  }
}
