import type { ContextMenuItem } from "@t3tools/contracts";
import type { SidebarOrganization } from "@t3tools/contracts/settings";
import type { SidebarProjectSnapshot } from "../sidebarProjectGrouping";
import {
  assignSidebarCategory,
  deriveSidebarCategoryAssignmentKey,
  resolveSidebarCategoryAssignment,
} from "./assignments";
import {
  createSidebarCategory,
  getSidebarOrderedCategories,
  UNCATEGORIZED_CATEGORY_ID,
  UNCATEGORIZED_CATEGORY_NAME,
  validateSidebarCategoryName,
} from "./categories";

export const REPOSITORY_GROUPING_LABEL = "Repository grouping";
export const REPOSITORY_GROUPING_DIALOG_LABEL = "Repository grouping...";
export const MOVE_TO_CATEGORY_LABEL = "Move to category...";
export const NEW_CATEGORY_LABEL = "New category...";

export function buildSidebarProjectContextMenuItems<T extends string>(input: {
  renameItem: ContextMenuItem<T>;
  repositoryGroupingItem: ContextMenuItem<T>;
  moveToCategoryItem: ContextMenuItem<T>;
  newCategoryItem: ContextMenuItem<T>;
  copyPathItem: ContextMenuItem<T>;
  removeItem: ContextMenuItem<T>;
}): readonly ContextMenuItem<T>[] {
  return [
    input.renameItem,
    input.repositoryGroupingItem,
    input.moveToCategoryItem,
    input.newCategoryItem,
    input.copyPathItem,
    input.removeItem,
  ];
}

export function getSidebarProjectCategoryOptions(
  sidebarOrganization: SidebarOrganization,
): ReadonlyArray<{ readonly value: string; readonly label: string }> {
  return [
    {
      value: UNCATEGORIZED_CATEGORY_ID,
      label: UNCATEGORIZED_CATEGORY_NAME,
    },
    ...getSidebarOrderedCategories(sidebarOrganization).map((category) => ({
      value: category.id,
      label: category.archivedAt ? `${category.name} (Hidden)` : category.name,
    })),
  ];
}

export function resolveSidebarProjectCategoryValue(
  sidebarOrganization: SidebarOrganization,
  project: SidebarProjectSnapshot,
): string {
  return (
    resolveSidebarCategoryAssignment(sidebarOrganization, project)?.categoryId ??
    UNCATEGORIZED_CATEGORY_ID
  );
}

export function reassignSidebarProjectCategory(input: {
  sidebarOrganization: SidebarOrganization;
  project: SidebarProjectSnapshot;
  categoryId: string;
  updatedAt: string;
}): SidebarOrganization {
  return assignSidebarCategory(input.sidebarOrganization, {
    assignmentKey: deriveSidebarCategoryAssignmentKey(input.project),
    categoryId: input.categoryId === UNCATEGORIZED_CATEGORY_ID ? null : input.categoryId,
    updatedAt: input.updatedAt,
  });
}

export function createSidebarCategoryForProject(input: {
  sidebarOrganization: SidebarOrganization;
  project: SidebarProjectSnapshot;
  categoryId: string;
  name: string;
  updatedAt: string;
}): {
  readonly sidebarOrganization: SidebarOrganization;
  readonly error: string | null;
} {
  const validation = validateSidebarCategoryName({
    sidebarOrganization: input.sidebarOrganization,
    name: input.name,
  });
  if (!validation.isValid) {
    return {
      sidebarOrganization: input.sidebarOrganization,
      error: validation.error,
    };
  }

  const withCategory = createSidebarCategory(input.sidebarOrganization, {
    id: input.categoryId,
    name: validation.normalizedName,
  });

  return {
    sidebarOrganization: reassignSidebarProjectCategory({
      sidebarOrganization: withCategory,
      project: input.project,
      categoryId: input.categoryId,
      updatedAt: input.updatedAt,
    }),
    error: null,
  };
}
