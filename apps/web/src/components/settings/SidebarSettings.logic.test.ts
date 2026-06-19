import {
  DEFAULT_SIDEBAR_ORGANIZATION,
  type SidebarOrganization,
} from "@t3tools/contracts/settings";
import { describe, expect, it } from "vite-plus/test";
import {
  canResetSidebarOrganization,
  createSidebarCategoryFromSettings,
  deleteSidebarCategoryFromSettings,
  getSidebarSettingsCategories,
  hideSidebarCategoryFromSettings,
  renameSidebarCategoryFromSettings,
  reorderActiveSidebarCategoryByOffset,
  resetSidebarOrganizationFromSettings,
  unhideAllSidebarCategories,
  unhideSidebarCategoryFromSettings,
} from "./SidebarSettings.logic";

function withCategory(
  sidebarOrganization: SidebarOrganization,
  input: {
    id: string;
    name: string;
  },
): SidebarOrganization {
  const result = createSidebarCategoryFromSettings({
    sidebarOrganization,
    categoryId: input.id,
    name: input.name,
  });
  if (result.error) {
    throw new Error(result.error);
  }
  return result.sidebarOrganization;
}

describe("SidebarSettings logic", () => {
  it("renames a category and rejects duplicate names", () => {
    const sidebarOrganization = withCategory(
      withCategory(DEFAULT_SIDEBAR_ORGANIZATION, { id: "cat-work", name: "Work" }),
      { id: "cat-personal", name: "Personal" },
    );

    expect(
      renameSidebarCategoryFromSettings({
        sidebarOrganization,
        categoryId: "cat-work",
        name: "Deep Work",
      }),
    ).toMatchObject({
      normalizedName: "Deep Work",
      error: null,
    });
    expect(
      renameSidebarCategoryFromSettings({
        sidebarOrganization,
        categoryId: "cat-work",
        name: " personal ",
      }),
    ).toMatchObject({
      normalizedName: null,
      error: "Category names must be unique.",
    });
  });

  it("hides, unhides, and unhides all categories while preserving ordering", () => {
    const sidebarOrganization = withCategory(
      withCategory(DEFAULT_SIDEBAR_ORGANIZATION, { id: "cat-work", name: "Work" }),
      { id: "cat-personal", name: "Personal" },
    );

    const hidden = hideSidebarCategoryFromSettings({
      sidebarOrganization,
      categoryId: "cat-work",
      archivedAt: "2026-06-19T15:00:00.000Z",
    });
    expect(
      getSidebarSettingsCategories(hidden).hiddenCategories.map((category) => category.id),
    ).toEqual(["cat-work"]);

    const unhidden = unhideSidebarCategoryFromSettings(hidden, "cat-work");
    expect(
      getSidebarSettingsCategories(unhidden).activeCategories.map((category) => category.id),
    ).toEqual(["cat-work", "cat-personal"]);

    const hiddenAgain = hideSidebarCategoryFromSettings({
      sidebarOrganization: hidden,
      categoryId: "cat-personal",
      archivedAt: "2026-06-19T15:05:00.000Z",
    });
    expect(
      getSidebarSettingsCategories(unhideAllSidebarCategories(hiddenAgain)).hiddenCategories,
    ).toEqual([]);
  });

  it("deletes categories and removes assignments to them", () => {
    const sidebarOrganization = {
      ...withCategory(DEFAULT_SIDEBAR_ORGANIZATION, { id: "cat-work", name: "Work" }),
      projectCategoryAssignments: {
        "github.com/example/project": {
          categoryId: "cat-work",
          updatedAt: "2026-06-19T16:00:00.000Z",
        },
      },
    };

    const deleted = deleteSidebarCategoryFromSettings(sidebarOrganization, "cat-work");
    expect(deleted.categories).toEqual({});
    expect(deleted.projectCategoryAssignments).toEqual({});
  });

  it("reorders active categories without collapsing hidden-category slots", () => {
    const sidebarOrganization = hideSidebarCategoryFromSettings({
      sidebarOrganization: {
        ...withCategory(
          withCategory(withCategory(DEFAULT_SIDEBAR_ORGANIZATION, { id: "cat-a", name: "Alpha" }), {
            id: "cat-b",
            name: "Beta",
          }),
          { id: "cat-c", name: "Gamma" },
        ),
        categoryOrder: ["cat-a", "cat-b", "cat-c"],
      },
      categoryId: "cat-b",
      archivedAt: "2026-06-19T16:05:00.000Z",
    });

    const reordered = reorderActiveSidebarCategoryByOffset(sidebarOrganization, {
      categoryId: "cat-c",
      offset: -1,
    });

    expect(reordered.categoryOrder).toEqual(["cat-c", "cat-b", "cat-a"]);
    expect(
      getSidebarSettingsCategories(reordered).activeCategories.map((category) => category.id),
    ).toEqual(["cat-c", "cat-a"]);
  });

  it("detects reset state and clears only category expansion state", () => {
    expect(
      canResetSidebarOrganization({
        sidebarOrganization: DEFAULT_SIDEBAR_ORGANIZATION,
        categoryExpandedById: {},
      }),
    ).toBe(false);

    const reset = resetSidebarOrganizationFromSettings({
      uiState: {
        categoryExpandedById: { "cat-work": false },
        projectExpandedById: { "project-1": false },
        projectOrder: ["project-1"],
        threadLastVisitedAtById: {},
        threadChangedFilesExpandedById: {},
        defaultAdvertisedEndpointKey: null,
      },
    });

    expect(reset.sidebarOrganization).toEqual(DEFAULT_SIDEBAR_ORGANIZATION);
    expect(reset.uiState.categoryExpandedById).toEqual({});
    expect(reset.uiState.projectExpandedById).toEqual({ "project-1": false });
    expect(reset.uiState.projectOrder).toEqual(["project-1"]);
  });
});
