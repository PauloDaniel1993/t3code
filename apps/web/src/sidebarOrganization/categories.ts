import type { SidebarCategory, SidebarOrganization } from "@t3tools/contracts/settings";

export const UNCATEGORIZED_CATEGORY_ID = "__uncategorized__";
export const UNCATEGORIZED_CATEGORY_NAME = "Uncategorized";
export const MAX_SIDEBAR_CATEGORY_NAME_LENGTH = 64;

export function createSidebarCategoryId(now = Date.now(), random = Math.random()): string {
  return `sidebar-category-${now}-${random.toString(16).slice(2)}`;
}

export interface SidebarCategoryNameValidationResult {
  readonly isValid: boolean;
  readonly normalizedName: string;
  readonly error: string | null;
}

function normalizeCategoryNameForComparison(name: string): string {
  return name.trim().toLowerCase();
}

export function normalizeSidebarCategoryName(name: string): string {
  return name.trim();
}

export function validateSidebarCategoryName(input: {
  sidebarOrganization: SidebarOrganization;
  name: string;
  excludeCategoryId?: string | null;
}): SidebarCategoryNameValidationResult {
  const normalizedName = normalizeSidebarCategoryName(input.name);
  if (normalizedName.length === 0) {
    return {
      isValid: false,
      normalizedName,
      error: "Category name is required.",
    };
  }
  if (normalizedName.length > MAX_SIDEBAR_CATEGORY_NAME_LENGTH) {
    return {
      isValid: false,
      normalizedName,
      error: `Category names must be ${MAX_SIDEBAR_CATEGORY_NAME_LENGTH} characters or fewer.`,
    };
  }

  const normalizedComparisonName = normalizeCategoryNameForComparison(normalizedName);
  if (
    normalizedComparisonName === normalizeCategoryNameForComparison(UNCATEGORIZED_CATEGORY_NAME)
  ) {
    return {
      isValid: false,
      normalizedName,
      error: `"${UNCATEGORIZED_CATEGORY_NAME}" is reserved.`,
    };
  }

  for (const category of Object.values(input.sidebarOrganization.categories)) {
    if (category.id === input.excludeCategoryId) {
      continue;
    }
    if (normalizeCategoryNameForComparison(category.name) === normalizedComparisonName) {
      return {
        isValid: false,
        normalizedName,
        error: "Category names must be unique.",
      };
    }
  }

  return {
    isValid: true,
    normalizedName,
    error: null,
  };
}

function cloneCategories(
  categories: SidebarOrganization["categories"],
): Record<string, SidebarCategory> {
  return { ...categories };
}

export function createSidebarCategory(
  sidebarOrganization: SidebarOrganization,
  input: {
    id: string;
    name: string;
    archivedAt?: string | null;
  },
): SidebarOrganization {
  const normalizedName = normalizeSidebarCategoryName(input.name);
  return {
    ...sidebarOrganization,
    categories: {
      ...cloneCategories(sidebarOrganization.categories),
      [input.id]: {
        id: input.id,
        name: normalizedName,
        archivedAt: input.archivedAt ?? null,
      },
    },
    categoryOrder: sidebarOrganization.categoryOrder.includes(input.id)
      ? sidebarOrganization.categoryOrder
      : [...sidebarOrganization.categoryOrder, input.id],
  };
}

export function renameSidebarCategory(
  sidebarOrganization: SidebarOrganization,
  input: {
    categoryId: string;
    name: string;
  },
): SidebarOrganization {
  const category = sidebarOrganization.categories[input.categoryId];
  if (!category) {
    return sidebarOrganization;
  }

  return {
    ...sidebarOrganization,
    categories: {
      ...cloneCategories(sidebarOrganization.categories),
      [input.categoryId]: {
        ...category,
        name: normalizeSidebarCategoryName(input.name),
      },
    },
  };
}

export function hideSidebarCategory(
  sidebarOrganization: SidebarOrganization,
  input: {
    categoryId: string;
    archivedAt: string;
  },
): SidebarOrganization {
  const category = sidebarOrganization.categories[input.categoryId];
  if (!category || category.archivedAt === input.archivedAt) {
    return sidebarOrganization;
  }

  return {
    ...sidebarOrganization,
    categories: {
      ...cloneCategories(sidebarOrganization.categories),
      [input.categoryId]: {
        ...category,
        archivedAt: input.archivedAt,
      },
    },
  };
}

export function unhideSidebarCategory(
  sidebarOrganization: SidebarOrganization,
  categoryId: string,
): SidebarOrganization {
  const category = sidebarOrganization.categories[categoryId];
  if (!category || category.archivedAt === null) {
    return sidebarOrganization;
  }

  return {
    ...sidebarOrganization,
    categories: {
      ...cloneCategories(sidebarOrganization.categories),
      [categoryId]: {
        ...category,
        archivedAt: null,
      },
    },
  };
}

export function setSidebarCategoryOrder(
  sidebarOrganization: SidebarOrganization,
  orderedCategoryIds: ReadonlyArray<string>,
): SidebarOrganization {
  const seen = new Set<string>();
  const nextOrder: string[] = [];
  for (const categoryId of orderedCategoryIds) {
    if (seen.has(categoryId) || !sidebarOrganization.categories[categoryId]) {
      continue;
    }
    seen.add(categoryId);
    nextOrder.push(categoryId);
  }
  for (const categoryId of sidebarOrganization.categoryOrder) {
    if (seen.has(categoryId) || !sidebarOrganization.categories[categoryId]) {
      continue;
    }
    seen.add(categoryId);
    nextOrder.push(categoryId);
  }
  for (const categoryId of Object.keys(sidebarOrganization.categories)) {
    if (seen.has(categoryId)) {
      continue;
    }
    seen.add(categoryId);
    nextOrder.push(categoryId);
  }

  return {
    ...sidebarOrganization,
    categoryOrder: nextOrder,
  };
}

export function deleteSidebarCategory(
  sidebarOrganization: SidebarOrganization,
  categoryId: string,
): SidebarOrganization {
  if (!sidebarOrganization.categories[categoryId]) {
    return sidebarOrganization;
  }

  const categories = cloneCategories(sidebarOrganization.categories);
  delete categories[categoryId];

  const projectCategoryAssignments: Record<string, { categoryId: string; updatedAt: string }> = {};
  for (const [projectKey, assignment] of Object.entries(
    sidebarOrganization.projectCategoryAssignments,
  )) {
    if (assignment.categoryId === categoryId) {
      continue;
    }
    projectCategoryAssignments[projectKey] = assignment;
  }

  return {
    ...sidebarOrganization,
    categories,
    categoryOrder: sidebarOrganization.categoryOrder.filter(
      (orderedCategoryId) => orderedCategoryId !== categoryId,
    ),
    projectCategoryAssignments,
  };
}

export function getSidebarActiveCategories(
  sidebarOrganization: SidebarOrganization,
): ReadonlyArray<SidebarCategory> {
  return Object.values(sidebarOrganization.categories).filter(
    (category) => category.archivedAt === null,
  );
}

export function getSidebarHiddenCategories(
  sidebarOrganization: SidebarOrganization,
): ReadonlyArray<SidebarCategory> {
  return Object.values(sidebarOrganization.categories).filter(
    (category) => category.archivedAt !== null,
  );
}

export function getSidebarOrderedCategories(
  sidebarOrganization: SidebarOrganization,
): ReadonlyArray<SidebarCategory> {
  const orderedCategories: SidebarCategory[] = [];
  const seen = new Set<string>();

  for (const categoryId of sidebarOrganization.categoryOrder) {
    const category = sidebarOrganization.categories[categoryId];
    if (!category || seen.has(categoryId)) {
      continue;
    }
    seen.add(categoryId);
    orderedCategories.push(category);
  }

  const remainingCategories = Object.values(sidebarOrganization.categories)
    .filter((category) => !seen.has(category.id))
    .toSorted(
      (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
    );

  return [...orderedCategories, ...remainingCategories];
}
