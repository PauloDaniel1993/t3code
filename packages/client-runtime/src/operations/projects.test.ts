import { SourceControlProviderKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";

import {
  findExistingAddProject,
  getCloneDirectoryName,
  getDefaultCloneUrl,
  normalizePastedCloneUrl,
  resolveAddProjectKind,
  listProjectsUsingFolder,
  listProjectFolderOverlaps,
} from "./projects.ts";
import type { EnvironmentProject } from "../state/models.ts";

describe("add project shared logic", () => {
  it("reports secondary overlaps once and omits remote folder entries", () => {
    const plain = { workspaceRoot: "C:/Work/API", title: "API" };
    const linked = {
      workspaceRoot: "C:/Work/UI",
      folders: [{ path: "C:/Work/UI" }, { path: "C:/Work/API" }, { path: "c:/work/api/" }, {}],
    };
    expect(listProjectFolderOverlaps([plain], linked)).toEqual([
      { path: "C:/Work/API", projects: [plain] },
    ]);
  });
  it("routes by server kind, with a file hint only for a missing entry", () => {
    const path = "/work/team.code-workspace";
    expect(
      resolveAddProjectKind(path, {
        name: "team.code-workspace",
        fullPath: path,
        kind: "directory",
      }),
    ).toBe("directory");
    expect(resolveAddProjectKind(path, { name: "team.code-workspace", fullPath: path })).toBe(
      "directory",
    );
    expect(
      resolveAddProjectKind(path, {
        name: "team.code-workspace",
        fullPath: path,
        kind: "workspace-file",
      }),
    ).toBe("workspace-file");
    expect(resolveAddProjectKind("/missing/TEAM.CODE-WORKSPACE", null)).toBe("workspace-file");
    expect(resolveAddProjectKind("/missing/folder", null)).toBe("directory");
    expect(resolveAddProjectKind("/missing/team.code-workspace/", null)).toBe("workspace-file");
    expect(resolveAddProjectKind("/work/team.code-workspace/", null, true)).toBe("directory");
  });
  it("finds plain and linked projects using a folder without treating descendants as overlaps", () => {
    const plain = { workspaceRoot: "C:/Work/API" };
    const linked = {
      workspaceRoot: "C:/Work/UI",
      folders: [{ path: "C:/Work/UI" }, { path: "C:/Work/API" }, {}],
    };
    const nested = { workspaceRoot: "C:/Work/API/nested" };
    expect(listProjectsUsingFolder([plain, linked, nested], "c:/work/api/")).toEqual([
      plain,
      linked,
    ]);
  });

  it("routes owner/repository shorthand to GitHub over HTTPS", () => {
    expect(normalizePastedCloneUrl("imputnet/helium")).toBe(
      "https://github.com/imputnet/helium.git",
    );
    expect(normalizePastedCloneUrl("  pingdotgg/t3code  ")).toBe(
      "https://github.com/pingdotgg/t3code.git",
    );
  });

  it("keeps explicit clone URLs and local paths unchanged", () => {
    expect(normalizePastedCloneUrl("https://gitlab.com/group/project.git")).toBe(
      "https://gitlab.com/group/project.git",
    );
    expect(normalizePastedCloneUrl("git@github.com:owner/repo.git")).toBe(
      "git@github.com:owner/repo.git",
    );
    expect(normalizePastedCloneUrl("group/subgroup/project")).toBe("group/subgroup/project");
    expect(normalizePastedCloneUrl("/srv/git/repo.git")).toBe("/srv/git/repo.git");
  });

  it("uses HTTPS for repositories selected through a provider", () => {
    expect(
      getDefaultCloneUrl({
        provider: SourceControlProviderKind.make("github"),
        url: "https://github.com/imputnet/helium",
        sshUrl: "git@github.com:imputnet/helium.git",
      }),
    ).toBe("https://github.com/imputnet/helium");
    expect(
      getDefaultCloneUrl({
        provider: SourceControlProviderKind.make("forgejo"),
        url: "https://forgejo.example.test:8443/owner/repo.git",
        sshUrl: "ssh://git@forgejo.example.test:2222/owner/repo.git",
      }),
    ).toBe("https://forgejo.example.test:8443/owner/repo.git");
  });

  it("derives the clone folder name from any pasted clone URL", () => {
    expect(getCloneDirectoryName("https://github.com/owner/repo.git")).toBe("repo");
    expect(getCloneDirectoryName("https://github.com/owner/repo")).toBe("repo");
    expect(getCloneDirectoryName("https://github.com/owner/repo/")).toBe("repo");
    expect(getCloneDirectoryName("git@github.com:owner/repo.git")).toBe("repo");
    expect(getCloneDirectoryName("ssh://git@github.com:22/owner/repo.git")).toBe("repo");
    expect(getCloneDirectoryName("https://user@bitbucket.org/owner/repo.git")).toBe("repo");
    expect(getCloneDirectoryName("https://dev.azure.com/org/project/_git/repo")).toBe("repo");
    expect(getCloneDirectoryName("https://github.com/owner/repo.git?ref=main#readme")).toBe("repo");
    expect(getCloneDirectoryName("/srv/git/repo.git")).toBe("repo");
    expect(getCloneDirectoryName("C:\\src\\repo.git")).toBe("repo");
    expect(getCloneDirectoryName("git@github.com:repo.git")).toBe("repo");
    expect(getCloneDirectoryName("  https://github.com/owner/repo.git  ")).toBe("repo");
  });

  it("keeps a numeric repository name that sits on a path", () => {
    expect(getCloneDirectoryName("https://github.com/acme/123.git")).toBe("123");
    expect(getCloneDirectoryName("https://github.com/acme/123")).toBe("123");
    expect(getCloneDirectoryName("git@github.com:acme/123.git")).toBe("123");
  });

  it("finds existing projects by normalized path in the target environment", () => {
    const env = EnvironmentId.make("env");
    const other = EnvironmentId.make("other");
    const projects: EnvironmentProject[] = [
      {
        environmentId: other,
        id: ProjectId.make("same-path-other-env"),
        title: "Other",
        workspaceRoot: "/repo",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        repositoryIdentity: null,
        defaultModelSelection: null,
        scripts: [],
      },
      {
        environmentId: env,
        id: ProjectId.make("project"),
        title: "Repo",
        workspaceRoot: "/repo/",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        repositoryIdentity: null,
        defaultModelSelection: null,
        scripts: [],
      },
    ];

    expect(findExistingAddProject({ projects, environmentId: env, path: "/repo" })?.id).toBe(
      "project",
    );
  });
});
