import { describe, expect, it } from "vite-plus/test";
import {
  type ContextMenuItem,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { DEFAULT_SIDEBAR_ORGANIZATION } from "@t3tools/contracts/settings";
import type { SidebarProjectSnapshot } from "../sidebarProjectGrouping";
import {
  ADD_PROJECT_NEW_CATEGORY_VALUE,
  applyAddProjectCategorySelection,
  buildSidebarProjectContextMenuItems,
  createSidebarCategoryForProject,
  getAddProjectCategoryOptions,
  getSidebarProjectCategoryOptions,
  MOVE_TO_CATEGORY_LABEL,
  NEW_CATEGORY_LABEL,
  REPOSITORY_GROUPING_DIALOG_LABEL,
  REPOSITORY_GROUPING_LABEL,
  reassignSidebarProjectCategory,
  resolveSidebarProjectCategoryValue,
} from "./projectWorkflow";
import { createSidebarCategory, UNCATEGORIZED_CATEGORY_ID } from "./categories";

const environmentId = EnvironmentId.make("env-local");

function makeProjectSnapshot(
  overrides: Partial<SidebarProjectSnapshot> = {},
): SidebarProjectSnapshot {
  const workspaceRoot = overrides.workspaceRoot ?? "/tmp/project";
  const canonicalKey = overrides.repositoryIdentity?.canonicalKey ?? "github.com/example/project";
  const baseProject = {
    id: ProjectId.make("project-1"),
    environmentId,
    title: "Project",
    workspaceRoot,
    repositoryIdentity: {
      canonicalKey,
      locator: {
        source: "git-remote" as const,
        remoteName: "origin",
        remoteUrl: `https://${canonicalKey}.git`,
      },
    },
    defaultModelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    createdAt: "2026-06-19T10:00:00.000Z",
    updatedAt: "2026-06-19T10:00:00.000Z",
    scripts: [],
  };
  const representative = {
    ...baseProject,
    physicalProjectKey: `${baseProject.environmentId}:${workspaceRoot}`,
    environmentLabel: "Local",
  };

  return {
    ...baseProject,
    projectKey: "logical-project-1",
    displayName: "Project",
    groupedProjectCount: 1,
    environmentPresence: "local-only" as const,
    allRemoteMembersAreDesktopLocal: false,
    memberProjects: [representative],
    memberProjectRefs: [],
    remoteEnvironmentLabels: [],
    ...overrides,
  };
}

describe("sidebar project category workflows", () => {
  it("builds row-level category actions without nesting them under member-targeted submenus", () => {
    const leaf = (id: string, label: string): ContextMenuItem<string> => ({ id, label });

    const items = buildSidebarProjectContextMenuItems({
      renameItem: leaf("rename", "Rename"),
      repositoryGroupingItem: leaf("grouping", REPOSITORY_GROUPING_DIALOG_LABEL),
      moveToCategoryItem: leaf("move", MOVE_TO_CATEGORY_LABEL),
      newCategoryItem: leaf("new", NEW_CATEGORY_LABEL),
      copyPathItem: leaf("copy", "Copy Path"),
      revealPathItem: leaf("reveal", "Show in Explorer"),
      removeItem: { ...leaf("remove", "Remove"), destructive: true },
    });

    expect(items.map((item) => item.label)).toEqual([
      "Rename",
      REPOSITORY_GROUPING_DIALOG_LABEL,
      MOVE_TO_CATEGORY_LABEL,
      NEW_CATEGORY_LABEL,
      "Copy Path",
      "Show in Explorer",
      "Remove",
    ]);
    expect(items.find((item) => item.label === MOVE_TO_CATEGORY_LABEL)?.children).toBeUndefined();
    expect(items.find((item) => item.label === NEW_CATEGORY_LABEL)?.children).toBeUndefined();
    expect(REPOSITORY_GROUPING_LABEL).toBe("Repository grouping");
  });

  it("creates a new category from the sidebar workflow and assigns the logical project to it", () => {
    const project = makeProjectSnapshot();

    const result = createSidebarCategoryForProject({
      sidebarOrganization: DEFAULT_SIDEBAR_ORGANIZATION,
      project,
      categoryId: "cat-work",
      name: "  Work  ",
      updatedAt: "2026-06-19T11:00:00.000Z",
    });

    expect(result.error).toBeNull();
    expect(result.sidebarOrganization.categories["cat-work"]).toMatchObject({
      id: "cat-work",
      name: "Work",
    });
    expect(resolveSidebarProjectCategoryValue(result.sidebarOrganization, project)).toBe(
      "cat-work",
    );
  });

  it("reassigns a logical project to an existing category and back to uncategorized", () => {
    const project = makeProjectSnapshot();
    const sidebarOrganization = createSidebarCategory(DEFAULT_SIDEBAR_ORGANIZATION, {
      id: "cat-work",
      name: "Work",
    });

    const assigned = reassignSidebarProjectCategory({
      sidebarOrganization,
      project,
      categoryId: "cat-work",
      updatedAt: "2026-06-19T11:05:00.000Z",
    });
    const uncategorized = reassignSidebarProjectCategory({
      sidebarOrganization: assigned,
      project,
      categoryId: UNCATEGORIZED_CATEGORY_ID,
      updatedAt: "2026-06-19T11:06:00.000Z",
    });

    expect(resolveSidebarProjectCategoryValue(assigned, project)).toBe("cat-work");
    expect(resolveSidebarProjectCategoryValue(uncategorized, project)).toBe(
      UNCATEGORIZED_CATEGORY_ID,
    );
  });

  it("lists uncategorized first and preserves ordered categories for the move dialog", () => {
    const sidebarOrganization = createSidebarCategory(
      createSidebarCategory(DEFAULT_SIDEBAR_ORGANIZATION, {
        id: "cat-b",
        name: "Beta",
      }),
      {
        id: "cat-a",
        name: "Alpha",
      },
    );

    expect(getSidebarProjectCategoryOptions(sidebarOrganization)).toEqual([
      { value: UNCATEGORIZED_CATEGORY_ID, label: "Uncategorized" },
      { value: "cat-b", label: "Beta" },
      { value: "cat-a", label: "Alpha" },
    ]);
  });

  it("lists active categories plus new category for the add-project flow", () => {
    const sidebarOrganization = createSidebarCategory(
      createSidebarCategory(DEFAULT_SIDEBAR_ORGANIZATION, {
        id: "cat-active",
        name: "Active",
      }),
      {
        id: "cat-hidden",
        name: "Hidden",
        archivedAt: "2026-06-19T12:00:00.000Z",
      },
    );

    expect(getAddProjectCategoryOptions(sidebarOrganization)).toEqual([
      { value: UNCATEGORIZED_CATEGORY_ID, label: "Uncategorized" },
      { value: "cat-active", label: "Active" },
      { value: ADD_PROJECT_NEW_CATEGORY_VALUE, label: NEW_CATEGORY_LABEL },
    ]);
  });

  it("assigns an added project to an existing active category", () => {
    const project = makeProjectSnapshot({ repositoryIdentity: null });
    const sidebarOrganization = createSidebarCategory(DEFAULT_SIDEBAR_ORGANIZATION, {
      id: "cat-work",
      name: "Work",
    });

    const result = applyAddProjectCategorySelection({
      sidebarOrganization,
      project,
      selectedCategoryId: "cat-work",
      newCategoryName: "",
      createCategoryId: () => "unused",
      updatedAt: "2026-06-19T12:05:00.000Z",
    });

    expect(result.error).toBeNull();
    expect(resolveSidebarProjectCategoryValue(result.sidebarOrganization, project)).toBe(
      "cat-work",
    );
  });

  it("creates and assigns a new category from the add-project flow", () => {
    const project = makeProjectSnapshot({ repositoryIdentity: null });

    const result = applyAddProjectCategorySelection({
      sidebarOrganization: DEFAULT_SIDEBAR_ORGANIZATION,
      project,
      selectedCategoryId: ADD_PROJECT_NEW_CATEGORY_VALUE,
      newCategoryName: "  Client Work  ",
      createCategoryId: () => "cat-client",
      updatedAt: "2026-06-19T12:10:00.000Z",
    });

    expect(result.error).toBeNull();
    expect(result.sidebarOrganization.categories["cat-client"]).toMatchObject({
      id: "cat-client",
      name: "Client Work",
    });
    expect(resolveSidebarProjectCategoryValue(result.sidebarOrganization, project)).toBe(
      "cat-client",
    );
  });

  it("rejects hidden category assignment from a stale add-project selection", () => {
    const project = makeProjectSnapshot({ repositoryIdentity: null });
    const sidebarOrganization = createSidebarCategory(DEFAULT_SIDEBAR_ORGANIZATION, {
      id: "cat-hidden",
      name: "Hidden",
      archivedAt: "2026-06-19T12:15:00.000Z",
    });

    const result = applyAddProjectCategorySelection({
      sidebarOrganization,
      project,
      selectedCategoryId: "cat-hidden",
      newCategoryName: "",
      createCategoryId: () => "unused",
      updatedAt: "2026-06-19T12:20:00.000Z",
    });

    expect(result.error).toBe("Choose an active category.");
    expect(result.sidebarOrganization).toBe(sidebarOrganization);
  });
});
