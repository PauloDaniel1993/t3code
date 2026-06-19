import {
  DEFAULT_SIDEBAR_ORGANIZATION,
  type SidebarCategory,
  type SidebarOrganization,
} from "@t3tools/contracts/settings";
import { type UiState, resetSidebarOrganizationUiState } from "../../uiStateStore";
import {
  createSidebarCategory,
  createSidebarCategoryId,
  deleteSidebarCategory,
  getSidebarOrderedCategories,
  hideSidebarCategory,
  renameSidebarCategory,
  setSidebarCategoryOrder,
  unhideSidebarCategory,
  validateSidebarCategoryName,
} from "../../sidebarOrganization/categories";

export function getSidebarSettingsCategories(sidebarOrganization: SidebarOrganization): {
  readonly activeCategories: readonly SidebarCategory[];
  readonly hiddenCategories: readonly SidebarCategory[];
} {
  const orderedCategories = getSidebarOrderedCategories(sidebarOrganization);
  return {
    activeCategories: orderedCategories.filter((category) => category.archivedAt === null),
    hiddenCategories: orderedCategories.filter((category) => category.archivedAt !== null),
  };
}

export function createSidebarCategoryFromSettings(input: {
  sidebarOrganization: SidebarOrganization;
  name: string;
  categoryId?: string;
}): {
  readonly sidebarOrganization: SidebarOrganization;
  readonly categoryId: string | null;
  readonly error: string | null;
} {
  const validation = validateSidebarCategoryName({
    sidebarOrganization: input.sidebarOrganization,
    name: input.name,
  });
  if (!validation.isValid) {
    return {
      sidebarOrganization: input.sidebarOrganization,
      categoryId: null,
      error: validation.error,
    };
  }

  const categoryId = input.categoryId ?? createSidebarCategoryId();
  return {
    sidebarOrganization: createSidebarCategory(input.sidebarOrganization, {
      id: categoryId,
      name: validation.normalizedName,
    }),
    categoryId,
    error: null,
  };
}

export function renameSidebarCategoryFromSettings(input: {
  sidebarOrganization: SidebarOrganization;
  categoryId: string;
  name: string;
}): {
  readonly sidebarOrganization: SidebarOrganization;
  readonly normalizedName: string | null;
  readonly error: string | null;
} {
  const validation = validateSidebarCategoryName({
    sidebarOrganization: input.sidebarOrganization,
    name: input.name,
    excludeCategoryId: input.categoryId,
  });
  if (!validation.isValid) {
    return {
      sidebarOrganization: input.sidebarOrganization,
      normalizedName: null,
      error: validation.error,
    };
  }

  return {
    sidebarOrganization: renameSidebarCategory(input.sidebarOrganization, {
      categoryId: input.categoryId,
      name: validation.normalizedName,
    }),
    normalizedName: validation.normalizedName,
    error: null,
  };
}

export function reorderActiveSidebarCategoryByOffset(
  sidebarOrganization: SidebarOrganization,
  input: {
    categoryId: string;
    offset: -1 | 1;
  },
): SidebarOrganization {
  const orderedCategories = getSidebarOrderedCategories(sidebarOrganization);
  const activeCategoryIds = orderedCategories
    .filter((category) => category.archivedAt === null)
    .map((category) => category.id);
  const index = activeCategoryIds.indexOf(input.categoryId);
  const nextIndex = index + input.offset;
  if (index < 0 || nextIndex < 0 || nextIndex >= activeCategoryIds.length) {
    return sidebarOrganization;
  }

  const reorderedActiveCategoryIds = [...activeCategoryIds];
  [reorderedActiveCategoryIds[index], reorderedActiveCategoryIds[nextIndex]] = [
    reorderedActiveCategoryIds[nextIndex]!,
    reorderedActiveCategoryIds[index]!,
  ];

  let activeIndex = 0;
  const nextOrderedCategoryIds = orderedCategories.map((category) =>
    category.archivedAt === null ? reorderedActiveCategoryIds[activeIndex++]! : category.id,
  );
  return setSidebarCategoryOrder(sidebarOrganization, nextOrderedCategoryIds);
}

export function hideSidebarCategoryFromSettings(input: {
  sidebarOrganization: SidebarOrganization;
  categoryId: string;
  archivedAt: string;
}): SidebarOrganization {
  return hideSidebarCategory(input.sidebarOrganization, {
    categoryId: input.categoryId,
    archivedAt: input.archivedAt,
  });
}

export function unhideSidebarCategoryFromSettings(
  sidebarOrganization: SidebarOrganization,
  categoryId: string,
): SidebarOrganization {
  return unhideSidebarCategory(sidebarOrganization, categoryId);
}

export function unhideAllSidebarCategories(
  sidebarOrganization: SidebarOrganization,
): SidebarOrganization {
  return getSidebarOrderedCategories(sidebarOrganization).reduce(
    (nextSidebarOrganization, category) =>
      category.archivedAt === null
        ? nextSidebarOrganization
        : unhideSidebarCategory(nextSidebarOrganization, category.id),
    sidebarOrganization,
  );
}

export function deleteSidebarCategoryFromSettings(
  sidebarOrganization: SidebarOrganization,
  categoryId: string,
): SidebarOrganization {
  return deleteSidebarCategory(sidebarOrganization, categoryId);
}

export function canResetSidebarOrganization(input: {
  sidebarOrganization: SidebarOrganization;
  categoryExpandedById: Readonly<Record<string, boolean>>;
}): boolean {
  return (
    input.sidebarOrganization.categoryOrder.length > 0 ||
    Object.keys(input.sidebarOrganization.categories).length > 0 ||
    Object.keys(input.sidebarOrganization.projectCategoryAssignments).length > 0 ||
    Object.keys(input.categoryExpandedById).length > 0
  );
}

export function resetSidebarOrganizationFromSettings(input: { uiState: UiState }): {
  readonly sidebarOrganization: SidebarOrganization;
  readonly uiState: UiState;
} {
  return {
    sidebarOrganization: DEFAULT_SIDEBAR_ORGANIZATION,
    uiState: resetSidebarOrganizationUiState(input.uiState),
  };
}
