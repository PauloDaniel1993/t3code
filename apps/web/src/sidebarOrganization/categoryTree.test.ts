import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_SIDEBAR_ORGANIZATION,
  type SidebarOrganization,
} from "@t3tools/contracts/settings";
import { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import type { SidebarProjectSnapshot } from "../sidebarProjectGrouping";
import { assignSidebarCategory } from "./assignments";
import {
  buildSidebarCategoryGroups,
  getVisibleProjectsForSidebarCategoryGroups,
} from "./categoryTree";
import { createSidebarCategory, UNCATEGORIZED_CATEGORY_ID } from "./categories";

const environmentId = EnvironmentId.make("env-local");

function makeProjectSnapshot(
  overrides: Partial<SidebarProjectSnapshot> = {},
): SidebarProjectSnapshot {
  const baseProject = {
    id: ProjectId.make("project-1"),
    environmentId,
    title: "Project",
    workspaceRoot: "/tmp/project-1",
    repositoryIdentity: {
      canonicalKey: "github.com/example/project-1",
      locator: {
        source: "git-remote" as const,
        remoteName: "origin",
        remoteUrl: "https://github.com/example/project-1.git",
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
    physicalProjectKey: `${baseProject.environmentId}:${baseProject.workspaceRoot}`,
    environmentLabel: "Local",
  };

  return {
    ...baseProject,
    projectKey: "logical-project-1",
    displayName: "Project",
    groupedProjectCount: 1,
    environmentPresence: "local-only",
    allRemoteMembersAreDesktopLocal: false,
    memberProjects: [representative],
    memberProjectRefs: [],
    remoteEnvironmentLabels: [],
    ...overrides,
  };
}

function addCategory(
  sidebarOrganization: SidebarOrganization,
  input: {
    id: string;
    name: string;
    archivedAt?: string | null;
  },
): SidebarOrganization {
  return createSidebarCategory(sidebarOrganization, input);
}

describe("buildSidebarCategoryGroups", () => {
  it("groups assigned projects under their categories and unassigned projects under uncategorized", () => {
    const workProject = makeProjectSnapshot({
      id: ProjectId.make("project-work"),
      projectKey: "logical-work",
      workspaceRoot: "/tmp/work",
      title: "Work",
      repositoryIdentity: {
        canonicalKey: "github.com/example/work",
        locator: {
          source: "git-remote" as const,
          remoteName: "origin",
          remoteUrl: "https://github.com/example/work.git",
        },
      },
    });
    const uncategorizedProject = makeProjectSnapshot({
      id: ProjectId.make("project-free"),
      projectKey: "logical-free",
      workspaceRoot: "/tmp/free",
      title: "Free",
      repositoryIdentity: {
        canonicalKey: "github.com/example/free",
        locator: {
          source: "git-remote" as const,
          remoteName: "origin",
          remoteUrl: "https://github.com/example/free.git",
        },
      },
    });
    const sidebarOrganization = assignSidebarCategory(
      addCategory(DEFAULT_SIDEBAR_ORGANIZATION, {
        id: "cat-work",
        name: "Work",
      }),
      {
        assignmentKey: "github.com/example/work",
        categoryId: "cat-work",
        updatedAt: "2026-06-19T10:05:00.000Z",
      },
    );

    const groups = buildSidebarCategoryGroups({
      projects: [workProject, uncategorizedProject],
      sidebarOrganization,
      activeRouteProjectKey: null,
    });

    expect(
      groups.map((group) => [
        group.categoryId,
        group.projects.map((project) => project.projectKey),
      ]),
    ).toEqual([
      ["cat-work", ["logical-work"]],
      [UNCATEGORIZED_CATEGORY_ID, ["logical-free"]],
    ]);
  });

  it("keeps empty custom categories visible in the sidebar tree", () => {
    const sidebarOrganization = addCategory(DEFAULT_SIDEBAR_ORGANIZATION, {
      id: "cat-empty",
      name: "Empty",
    });

    const groups = buildSidebarCategoryGroups({
      projects: [],
      sidebarOrganization,
      activeRouteProjectKey: null,
    });

    expect(groups.find((group) => group.categoryId === "cat-empty")).toMatchObject({
      name: "Empty",
      projects: [],
    });
  });

  it("filters hidden categories from the normal tree until the active route needs them", () => {
    const hiddenProject = makeProjectSnapshot({
      projectKey: "logical-hidden",
      repositoryIdentity: {
        canonicalKey: "github.com/example/hidden",
        locator: {
          source: "git-remote" as const,
          remoteName: "origin",
          remoteUrl: "https://github.com/example/hidden.git",
        },
      },
    });
    const sidebarOrganization = assignSidebarCategory(
      addCategory(DEFAULT_SIDEBAR_ORGANIZATION, {
        id: "cat-hidden",
        name: "Hidden",
        archivedAt: "2026-06-19T11:00:00.000Z",
      }),
      {
        assignmentKey: "github.com/example/hidden",
        categoryId: "cat-hidden",
        updatedAt: "2026-06-19T11:05:00.000Z",
      },
    );

    const hiddenGroups = buildSidebarCategoryGroups({
      projects: [hiddenProject],
      sidebarOrganization,
      activeRouteProjectKey: null,
    });
    const revealedGroups = buildSidebarCategoryGroups({
      projects: [hiddenProject],
      sidebarOrganization,
      activeRouteProjectKey: "logical-hidden",
    });

    expect(hiddenGroups.some((group) => group.categoryId === "cat-hidden")).toBe(false);
    expect(revealedGroups.find((group) => group.categoryId === "cat-hidden")).toMatchObject({
      isTemporarilyRevealed: true,
      projects: [hiddenProject],
    });
  });
});

describe("getVisibleProjectsForSidebarCategoryGroups", () => {
  it("hides descendant projects for collapsed categories while preserving other categories", () => {
    const firstProject = makeProjectSnapshot({
      projectKey: "logical-alpha",
      repositoryIdentity: {
        canonicalKey: "github.com/example/alpha",
        locator: {
          source: "git-remote" as const,
          remoteName: "origin",
          remoteUrl: "https://github.com/example/alpha.git",
        },
      },
    });
    const secondProject = makeProjectSnapshot({
      projectKey: "logical-beta",
      repositoryIdentity: {
        canonicalKey: "github.com/example/beta",
        locator: {
          source: "git-remote" as const,
          remoteName: "origin",
          remoteUrl: "https://github.com/example/beta.git",
        },
      },
    });
    const sidebarOrganization = assignSidebarCategory(
      assignSidebarCategory(
        addCategory(
          addCategory(DEFAULT_SIDEBAR_ORGANIZATION, {
            id: "cat-alpha",
            name: "Alpha",
          }),
          {
            id: "cat-beta",
            name: "Beta",
          },
        ),
        {
          assignmentKey: "github.com/example/alpha",
          categoryId: "cat-alpha",
          updatedAt: "2026-06-19T12:00:00.000Z",
        },
      ),
      {
        assignmentKey: "github.com/example/beta",
        categoryId: "cat-beta",
        updatedAt: "2026-06-19T12:01:00.000Z",
      },
    );

    const groups = buildSidebarCategoryGroups({
      projects: [firstProject, secondProject],
      sidebarOrganization,
      activeRouteProjectKey: null,
    });

    expect(
      getVisibleProjectsForSidebarCategoryGroups({
        groups,
        categoryExpandedById: {
          "cat-alpha": false,
        },
      }).map((project) => project.projectKey),
    ).toEqual(["logical-beta"]);
  });

  it("forces temporarily revealed hidden categories to stay visible even when collapsed in UI state", () => {
    const hiddenProject = makeProjectSnapshot({
      projectKey: "logical-hidden",
      repositoryIdentity: {
        canonicalKey: "github.com/example/hidden",
        locator: {
          source: "git-remote" as const,
          remoteName: "origin",
          remoteUrl: "https://github.com/example/hidden.git",
        },
      },
    });
    const sidebarOrganization = assignSidebarCategory(
      addCategory(DEFAULT_SIDEBAR_ORGANIZATION, {
        id: "cat-hidden",
        name: "Hidden",
        archivedAt: "2026-06-19T13:00:00.000Z",
      }),
      {
        assignmentKey: "github.com/example/hidden",
        categoryId: "cat-hidden",
        updatedAt: "2026-06-19T13:05:00.000Z",
      },
    );
    const groups = buildSidebarCategoryGroups({
      projects: [hiddenProject],
      sidebarOrganization,
      activeRouteProjectKey: "logical-hidden",
    });

    expect(
      getVisibleProjectsForSidebarCategoryGroups({
        groups,
        categoryExpandedById: {
          "cat-hidden": false,
        },
      }).map((project) => project.projectKey),
    ).toEqual(["logical-hidden"]);
  });
});
