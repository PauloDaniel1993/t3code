import type { SidebarOrganization } from "@t3tools/contracts/settings";
import type { SidebarProjectSnapshot } from "../sidebarProjectGrouping";
import { resolveSidebarCategoryAssignment } from "./assignments";
import {
  getSidebarOrderedCategories,
  UNCATEGORIZED_CATEGORY_ID,
  UNCATEGORIZED_CATEGORY_NAME,
} from "./categories";

export interface SidebarCategoryGroup {
  readonly categoryId: string;
  readonly name: string;
  readonly archivedAt: string | null;
  readonly projects: readonly SidebarProjectSnapshot[];
  readonly isTemporarilyRevealed: boolean;
  readonly isUncategorized: boolean;
}

export function buildSidebarCategoryGroups(input: {
  projects: readonly SidebarProjectSnapshot[];
  sidebarOrganization: SidebarOrganization;
  activeRouteProjectKey: string | null;
}): SidebarCategoryGroup[] {
  const projectsByCategoryId = new Map<string, SidebarProjectSnapshot[]>();
  const uncategorizedProjects: SidebarProjectSnapshot[] = [];

  for (const project of input.projects) {
    const assignment = resolveSidebarCategoryAssignment(input.sidebarOrganization, project);
    if (!assignment) {
      uncategorizedProjects.push(project);
      continue;
    }

    const categoryProjects = projectsByCategoryId.get(assignment.categoryId);
    if (categoryProjects) {
      categoryProjects.push(project);
    } else {
      projectsByCategoryId.set(assignment.categoryId, [project]);
    }
  }

  const groups: SidebarCategoryGroup[] = [];
  for (const category of getSidebarOrderedCategories(input.sidebarOrganization)) {
    const categoryId = category.id;
    const projects = projectsByCategoryId.get(categoryId) ?? [];
    const isTemporarilyRevealed =
      category.archivedAt !== null &&
      input.activeRouteProjectKey !== null &&
      projects.some((project) => project.projectKey === input.activeRouteProjectKey);

    if (category.archivedAt !== null && !isTemporarilyRevealed) {
      continue;
    }

    groups.push({
      categoryId: category.id,
      name: category.name,
      archivedAt: category.archivedAt,
      projects,
      isTemporarilyRevealed,
      isUncategorized: false,
    });
  }

  groups.push({
    categoryId: UNCATEGORIZED_CATEGORY_ID,
    name: UNCATEGORIZED_CATEGORY_NAME,
    archivedAt: null,
    projects: uncategorizedProjects,
    isTemporarilyRevealed: false,
    isUncategorized: true,
  });

  return groups;
}

export function resolveSidebarCategoryGroupExpanded(
  categoryExpandedById: Readonly<Record<string, boolean>>,
  group: SidebarCategoryGroup,
): boolean {
  if (group.isTemporarilyRevealed) {
    return true;
  }

  return categoryExpandedById[group.categoryId] ?? true;
}

export function getVisibleProjectsForSidebarCategoryGroups(input: {
  groups: readonly SidebarCategoryGroup[];
  categoryExpandedById: Readonly<Record<string, boolean>>;
}): SidebarProjectSnapshot[] {
  return input.groups.flatMap((group) =>
    resolveSidebarCategoryGroupExpanded(input.categoryExpandedById, group) ? group.projects : [],
  );
}
