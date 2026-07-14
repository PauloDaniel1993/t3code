import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_SIDEBAR_ORGANIZATION,
  type SidebarOrganization,
} from "@t3tools/contracts/settings";
import { EnvironmentId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import {
  createSidebarCategory,
  deleteSidebarCategory,
  hideSidebarCategory,
  MAX_SIDEBAR_CATEGORY_NAME_LENGTH,
  normalizeSidebarCategoryName,
  renameSidebarCategory,
  UNCATEGORIZED_CATEGORY_NAME,
  unhideSidebarCategory,
  validateSidebarCategoryName,
} from "./categories";
import {
  assignSidebarCategory,
  deriveSidebarCategoryAssignmentKey,
  migrateSidebarCategoryAssignments,
  resolveSidebarCategoryAssignment,
} from "./assignments";
import { createSidebarOrganizationPatch } from "./settings";
import type { Project } from "../types";

const primaryEnvironmentId = EnvironmentId.make("env-primary");
const remoteEnvironmentId = EnvironmentId.make("env-remote");

const repositoryIdentity = {
  canonicalKey: "github.com/example/shared-repo",
  locator: {
    source: "git-remote" as const,
    remoteName: "origin",
    remoteUrl: "https://github.com/example/shared-repo.git",
  },
};

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: ProjectId.make("project-1"),
    environmentId: primaryEnvironmentId,
    title: "shared-repo",
    workspaceRoot: "/tmp/shared-repo",
    repositoryIdentity: null,
    defaultModelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scripts: [],
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

describe("sidebarOrganization domain", () => {
  it("creates categories with trimmed names and appends them to category order", () => {
    const sidebarOrganization = addCategory(DEFAULT_SIDEBAR_ORGANIZATION, {
      id: "cat-work",
      name: "  Work  ",
    });

    expect(normalizeSidebarCategoryName("  Work  ")).toBe("Work");
    expect(sidebarOrganization.categories["cat-work"]).toEqual({
      id: "cat-work",
      name: "Work",
      archivedAt: null,
    });
    expect(sidebarOrganization.categoryOrder).toEqual(["cat-work"]);
  });

  it("builds a full-object client settings patch for sidebar organization updates", () => {
    const sidebarOrganization = addCategory(DEFAULT_SIDEBAR_ORGANIZATION, {
      id: "cat-work",
      name: "Work",
    });

    expect(createSidebarOrganizationPatch(sidebarOrganization)).toEqual({
      sidebarOrganization,
    });
  });

  it("rejects duplicate, reserved, and overlong category names", () => {
    const sidebarOrganization = addCategory(DEFAULT_SIDEBAR_ORGANIZATION, {
      id: "cat-work",
      name: "Work",
    });

    expect(
      validateSidebarCategoryName({
        sidebarOrganization,
        name: "  work ",
      }),
    ).toEqual({
      isValid: false,
      normalizedName: "work",
      error: "Category names must be unique.",
    });
    expect(
      validateSidebarCategoryName({
        sidebarOrganization,
        name: UNCATEGORIZED_CATEGORY_NAME,
      }),
    ).toEqual({
      isValid: false,
      normalizedName: UNCATEGORIZED_CATEGORY_NAME,
      error: `"${UNCATEGORIZED_CATEGORY_NAME}" is reserved.`,
    });
    expect(
      validateSidebarCategoryName({
        sidebarOrganization,
        name: "x".repeat(MAX_SIDEBAR_CATEGORY_NAME_LENGTH + 1),
      }),
    ).toEqual({
      isValid: false,
      normalizedName: "x".repeat(MAX_SIDEBAR_CATEGORY_NAME_LENGTH + 1),
      error: `Category names must be ${MAX_SIDEBAR_CATEGORY_NAME_LENGTH} characters or fewer.`,
    });
  });

  it("allows renaming a category when excluding its current id from uniqueness checks", () => {
    const sidebarOrganization = addCategory(DEFAULT_SIDEBAR_ORGANIZATION, {
      id: "cat-work",
      name: "Work",
    });

    expect(
      validateSidebarCategoryName({
        sidebarOrganization,
        name: "  Work ",
        excludeCategoryId: "cat-work",
      }),
    ).toEqual({
      isValid: true,
      normalizedName: "Work",
      error: null,
    });

    expect(
      renameSidebarCategory(sidebarOrganization, {
        categoryId: "cat-work",
        name: "  Deep Work ",
      }).categories["cat-work"]?.name,
    ).toBe("Deep Work");
  });

  it("uses the physical assignment key when repository identity is missing", () => {
    const project = makeProject();

    expect(deriveSidebarCategoryAssignmentKey(project)).toBe(
      `${primaryEnvironmentId}:/tmp/shared-repo`,
    );
  });

  it("uses the canonical repository key for category assignments when available", () => {
    const project = makeProject({ repositoryIdentity });

    expect(deriveSidebarCategoryAssignmentKey(project)).toBe(repositoryIdentity.canonicalKey);
  });

  it("migrates fallback physical assignments to the canonical repository key", () => {
    const project = makeProject({ repositoryIdentity });
    const categoryId = "cat-work";
    const sidebarOrganization = assignSidebarCategory(
      addCategory(DEFAULT_SIDEBAR_ORGANIZATION, {
        id: categoryId,
        name: "Work",
      }),
      {
        assignmentKey: `${primaryEnvironmentId}:/tmp/shared-repo`,
        categoryId,
        updatedAt: "2026-06-19T12:00:00.000Z",
      },
    );

    const migrated = migrateSidebarCategoryAssignments(sidebarOrganization, [project]);
    expect(migrated.projectCategoryAssignments).toEqual({
      [repositoryIdentity.canonicalKey]: {
        categoryId,
        updatedAt: "2026-06-19T12:00:00.000Z",
      },
    });
    expect(resolveSidebarCategoryAssignment(migrated, project)).toEqual({
      categoryId,
      updatedAt: "2026-06-19T12:00:00.000Z",
    });
  });

  it("keeps the latest updated assignment when multiple fallback keys converge on one repository", () => {
    const localProject = makeProject({ repositoryIdentity });
    const remoteProject = makeProject({
      id: ProjectId.make("project-remote"),
      environmentId: remoteEnvironmentId,
      workspaceRoot: "/var/remote/shared-repo",
      repositoryIdentity,
    });
    const sidebarOrganization = addCategory(DEFAULT_SIDEBAR_ORGANIZATION, {
      id: "cat-work",
      name: "Work",
    });
    const assignedOnce = assignSidebarCategory(sidebarOrganization, {
      assignmentKey: `${primaryEnvironmentId}:/tmp/shared-repo`,
      categoryId: "cat-work",
      updatedAt: "2026-06-19T12:00:00.000Z",
    });
    const assignedTwice = assignSidebarCategory(assignedOnce, {
      assignmentKey: `${remoteEnvironmentId}:/var/remote/shared-repo`,
      categoryId: "cat-work",
      updatedAt: "2026-06-19T12:05:00.000Z",
    });

    expect(
      migrateSidebarCategoryAssignments(assignedTwice, [localProject, remoteProject])
        .projectCategoryAssignments,
    ).toEqual({
      [repositoryIdentity.canonicalKey]: {
        categoryId: "cat-work",
        updatedAt: "2026-06-19T12:05:00.000Z",
      },
    });
  });

  it("hides and unhides categories without disturbing their order", () => {
    const sidebarOrganization = addCategory(DEFAULT_SIDEBAR_ORGANIZATION, {
      id: "cat-work",
      name: "Work",
    });

    const hidden = hideSidebarCategory(sidebarOrganization, {
      categoryId: "cat-work",
      archivedAt: "2026-06-19T13:00:00.000Z",
    });
    expect(hidden.categories["cat-work"]?.archivedAt).toBe("2026-06-19T13:00:00.000Z");
    expect(hidden.categoryOrder).toEqual(["cat-work"]);

    const unhidden = unhideSidebarCategory(hidden, "cat-work");
    expect(unhidden.categories["cat-work"]?.archivedAt).toBeNull();
    expect(unhidden.categoryOrder).toEqual(["cat-work"]);
  });

  it("deletes categories and returns assigned projects to uncategorized", () => {
    const project = makeProject({ repositoryIdentity });
    const sidebarOrganization = assignSidebarCategory(
      addCategory(DEFAULT_SIDEBAR_ORGANIZATION, {
        id: "cat-work",
        name: "Work",
      }),
      {
        assignmentKey: repositoryIdentity.canonicalKey,
        categoryId: "cat-work",
        updatedAt: "2026-06-19T14:00:00.000Z",
      },
    );

    const deleted = deleteSidebarCategory(sidebarOrganization, "cat-work");
    expect(deleted.categories).toEqual({});
    expect(deleted.categoryOrder).toEqual([]);
    expect(resolveSidebarCategoryAssignment(deleted, project)).toBeUndefined();
  });
});
