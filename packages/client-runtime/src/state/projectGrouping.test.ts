import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentProject } from "./models.ts";
import { chooseLoadBalancedEnvironment } from "../load-balancing.ts";
import {
  buildProjectGroups,
  deriveLogicalProjectKeyFromSettings,
  derivePhysicalProjectKey,
  deriveProjectGroupingOverrideKey,
  getProjectOrderKey,
  resolveScratchProjectScopeKey,
  sortProjectsByGroupOrder,
  type ProjectGroupingSettings,
} from "./projectGrouping.ts";

const environmentId = EnvironmentId.make("environment");

describe("load balancing shared project machines", () => {
  const now = 100_000;
  const resources = {
    sampledAt: now,
    cpuUtilization: 0.2,
    cpuCount: 8,
    availableMemoryBytes: 8_000,
    totalMemoryBytes: 16_000,
  };

  it("compares three machines using free capacity and preference", () => {
    const candidates = [
      { environmentId: "busy", resources: { ...resources, cpuUtilization: 0.9 }, weight: 1 },
      { environmentId: "idle", resources, weight: 1 },
      { environmentId: "preferred", resources: { ...resources, cpuCount: 4 }, weight: 3 },
    ];
    expect(chooseLoadBalancedEnvironment(candidates, now)).toBe("preferred");
    expect(chooseLoadBalancedEnvironment(candidates.slice(0, 2), now)).toBe("idle");
  });

  it("rejects stale, unknown, excluded and saturated machines", () => {
    expect(
      chooseLoadBalancedEnvironment(
        [
          {
            environmentId: "stale",
            resources: { ...resources, sampledAt: now - 15_001 },
            weight: 1,
          },
          { environmentId: "unknown", resources: null, weight: 1 },
          {
            environmentId: "no-cpu-sample",
            resources: { ...resources, cpuUtilization: null },
            weight: 1,
          },
          { environmentId: "excluded", resources, weight: 0 },
          {
            environmentId: "cpu-full",
            resources: { ...resources, cpuUtilization: 0.95 },
            weight: 1,
          },
          {
            environmentId: "memory-full",
            resources: { ...resources, availableMemoryBytes: 100 },
            weight: 1,
          },
        ],
        now,
      ),
    ).toBeNull();
  });

  it("uses client receipt time when host clocks differ", () => {
    const candidate = {
      environmentId: "different-clock",
      resources: { ...resources, sampledAt: now + 60_000 },
      receivedAt: now,
      weight: 1,
    };
    expect(chooseLoadBalancedEnvironment([candidate], now)).toBe("different-clock");
    expect(chooseLoadBalancedEnvironment([candidate], now + 15_001)).toBeNull();
  });
});
const repositoryIdentity = {
  canonicalKey: "github.com/t3tools/t3code",
  locator: {
    source: "git-remote" as const,
    remoteName: "upstream",
    remoteUrl: "https://github.com/t3tools/t3code.git",
  },
  provider: "github",
  owner: "t3tools",
  name: "t3code",
  displayName: "T3 Code",
};

function makeProject(
  id: string,
  workspaceRoot: string,
  overrides: Partial<EnvironmentProject> = {},
): EnvironmentProject {
  return {
    environmentId,
    id: ProjectId.make(id),
    title: id,
    workspaceRoot,
    repositoryIdentity,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

function settings(
  mode: ProjectGroupingSettings["sidebarProjectGroupingMode"],
  overrides: ProjectGroupingSettings["sidebarProjectGroupingOverrides"] = {},
): ProjectGroupingSettings {
  return {
    sidebarProjectGroupingMode: mode,
    sidebarProjectGroupingOverrides: overrides,
  };
}

describe("buildProjectGroups", () => {
  it.each(["repository", "repository_path", "separate"] as const)(
    "keeps scratch project ownership separate by default in %s mode",
    (mode) => {
      const projects = [
        makeProject("scratch-local", "/local/scratch", {
          isScratch: true,
          repositoryIdentity: null,
        }),
        makeProject("scratch-remote", "/remote/scratch", {
          environmentId: EnvironmentId.make("remote"),
          isScratch: true,
          repositoryIdentity: null,
        }),
      ];
      const groups = buildProjectGroups({ projects, settings: settings(mode) });
      expect(groups.map((group) => group.key)).toEqual(projects.map(derivePhysicalProjectKey));
      expect(groups.map((group) => group.memberProjectRefs)).toEqual(
        projects.map((project) => [
          { environmentId: project.environmentId, projectId: project.id },
        ]),
      );
      expect(
        buildProjectGroups({ projects, settings: settings(mode), groupScratchProjects: true }),
      ).toHaveLength(1);
    },
  );

  it.each(["repository", "repository_path", "separate"] as const)(
    "migrates a pre-config %s scratch selection and retains it after the original host is removed",
    (mode) => {
      const local = makeProject("scratch-local", "/local/repo/scratch", {
        repositoryIdentity: { ...repositoryIdentity, rootPath: "/local/repo" },
      });
      const remote = makeProject("scratch-remote", "/remote/scratch", {
        environmentId: EnvironmentId.make("remote"),
        repositoryIdentity: null,
        isScratch: true,
      });
      const groupingSettings = settings(mode);
      const selectedBeforeConfig = deriveLogicalProjectKeyFromSettings(local, groupingSettings);
      const loaded = [{ ...local, isScratch: true as const }, remote];
      const migrated = resolveScratchProjectScopeKey(
        selectedBeforeConfig,
        loaded,
        groupingSettings,
      );
      const scratchKey = buildProjectGroups({
        projects: loaded,
        settings: groupingSettings,
        groupScratchProjects: true,
      })[0]!.key;
      expect(migrated).toBe(scratchKey);
      expect(resolveScratchProjectScopeKey(migrated, [remote], groupingSettings)).toBe(scratchKey);
      expect(
        buildProjectGroups({
          projects: [remote],
          settings: groupingSettings,
          groupScratchProjects: true,
        })[0]?.memberProjectRefs,
      ).toEqual([{ environmentId: remote.environmentId, projectId: remote.id }]);
    },
  );

  it("retains a repository filter that still belongs to an ordinary project", () => {
    const scratch = makeProject("scratch", "/scratch", { isScratch: true });
    const ordinary = makeProject("ordinary", "/ordinary");
    const key = deriveLogicalProjectKeyFromSettings(ordinary, settings("repository"));
    expect(resolveScratchProjectScopeKey(key, [scratch, ordinary])).toBe(key);
  });

  it.each(["repository", "repository_path", "separate"] as const)(
    "coalesces scratch homes in %s mode without merging ordinary same-title projects",
    (mode) => {
      const remoteEnvironmentId = EnvironmentId.make("remote");
      const projects = [
        makeProject("scratch-local", "/local/scratch", {
          title: "No project",
          isScratch: true,
          repositoryIdentity: null,
        }),
        makeProject("scratch-remote", "/remote/scratch", {
          title: "No project",
          environmentId: remoteEnvironmentId,
          isScratch: true,
        }),
        makeProject("scratch-duplicate", "/remote/scratch/", {
          title: "No project",
          environmentId: remoteEnvironmentId,
          isScratch: true,
          repositoryIdentity: null,
          updatedAt: "2026-07-02T00:00:00.000Z",
        }),
        makeProject("ordinary", "/ordinary", { title: "No project" }),
        makeProject("reserved-collision", "/other", {
          title: "No project",
          repositoryIdentity: { ...repositoryIdentity, canonicalKey: "\0no-project" },
        }),
      ];
      const groups = buildProjectGroups({
        projects,
        groupScratchProjects: true,
        settings: settings(mode, { [derivePhysicalProjectKey(projects[0]!)]: "separate" }),
        preferredEnvironmentId: remoteEnvironmentId,
      });
      expect(groups).toHaveLength(3);
      const scratch = groups.find((group) => group.representative.isScratch)!;
      expect(scratch.label).toBe("No project");
      expect(scratch.representative.id).toBe(projects[2]?.id);
      expect(scratch.members).toHaveLength(2);
      expect(scratch.memberProjectRefs).toEqual(
        projects.slice(0, 3).map((project) => ({
          environmentId: project.environmentId,
          projectId: project.id,
        })),
      );
      expect(resolveScratchProjectScopeKey(derivePhysicalProjectKey(projects[1]!), projects)).toBe(
        scratch.key,
      );
      expect(resolveScratchProjectScopeKey(derivePhysicalProjectKey(projects[3]!), projects)).toBe(
        derivePhysicalProjectKey(projects[3]!),
      );
      expect(groups.filter((group) => !group.representative.isScratch)).toHaveLength(2);
    },
  );

  it("preserves every physical clone as a selectable member in repository modes", () => {
    const projects = [
      makeProject("t3code", "/work/t3code"),
      makeProject("t3code-2", "/work/t3code-2"),
      makeProject("t3code-3", "/work/t3code-3"),
    ];

    for (const mode of ["repository", "repository_path"] as const) {
      const groups = buildProjectGroups({ projects, settings: settings(mode) });
      expect(groups).toHaveLength(1);
      expect(groups[0]?.members.map((member) => member.project.id)).toEqual([
        "t3code",
        "t3code-2",
        "t3code-3",
      ]);
      expect(groups[0]?.memberProjectRefs).toHaveLength(3);
    }
  });

  it("keeps a fork apart from its upstream checkout and labels it by its own remote", () => {
    const fork = makeProject("fork", "/work/t3code-fork", {
      repositoryIdentity: {
        ...repositoryIdentity,
        origin: {
          canonicalKey: "github.com/julius/t3code-fork",
          displayName: "julius/t3code-fork",
        },
      },
    });
    const forkWorktree = makeProject("fork-2", "/work/t3code-fork-2", {
      repositoryIdentity: fork.repositoryIdentity,
    });
    const projects = [makeProject("t3code", "/work/t3code"), fork, forkWorktree];

    const groups = buildProjectGroups({ projects, settings: settings("repository") });
    expect(groups.map((group) => group.key)).toEqual([
      "github.com/t3tools/t3code",
      "github.com/julius/t3code-fork",
    ]);
    expect(groups[1]?.members.map((member) => member.project.id)).toEqual(["fork", "fork-2"]);
    expect(groups[1]?.label).toBe("julius/t3code-fork");
  });

  it("applies a physical-project override without dropping its siblings", () => {
    const first = makeProject("t3code", "/work/t3code");
    const second = makeProject("t3code-2", "/work/t3code-2");
    const third = makeProject("t3code-3", "/work/t3code-3");
    const groups = buildProjectGroups({
      projects: [first, second, third],
      settings: settings("repository", {
        [derivePhysicalProjectKey(second)]: "separate",
      }),
    });

    expect(groups).toHaveLength(2);
    expect(groups.flatMap((group) => group.members.map((member) => member.project.id))).toEqual([
      "t3code",
      "t3code-3",
      "t3code-2",
    ]);
  });

  it("dedupes stale registrations at one physical path using the freshest project", () => {
    const stale = makeProject("stale", "/work/t3code", {
      repositoryIdentity: null,
      updatedAt: "2026-07-01T00:00:00.000Z",
    });
    const fresh = makeProject("fresh", "/work/t3code/", {
      updatedAt: "2026-07-02T00:00:00.000Z",
    });

    const groups = buildProjectGroups({
      projects: [stale, fresh],
      settings: settings("repository"),
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.members).toHaveLength(1);
    expect(groups[0]?.representative.id).toBe("fresh");
    expect(groups[0]?.memberProjectRefs).toHaveLength(2);
  });

  it("uses the freshest winner's repository identity when stale duplicates disagree", () => {
    const staleIdentity = {
      ...repositoryIdentity,
      canonicalKey: "github.com/t3tools/old-repository",
      name: "old-repository",
      displayName: "Old Repository",
    };
    const stale = makeProject("stale", "/work/t3code", {
      repositoryIdentity: staleIdentity,
      updatedAt: "2026-07-01T00:00:00.000Z",
    });
    const fresh = makeProject("fresh", "/work/t3code/", {
      updatedAt: "2026-07-02T00:00:00.000Z",
    });
    const sibling = makeProject("sibling", "/work/t3code-2");

    const groups = buildProjectGroups({
      projects: [stale, fresh, sibling],
      settings: settings("repository"),
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.members.map((member) => member.project.id)).toEqual(["fresh", "sibling"]);
  });

  it("uses the freshest identity-bearing duplicate when the winner lacks identity", () => {
    const staleIdentity = {
      ...repositoryIdentity,
      canonicalKey: "github.com/t3tools/old-repository",
      name: "old-repository",
      displayName: "Old Repository",
    };
    const staleIdentified = makeProject("stale-identified", "/work/t3code", {
      repositoryIdentity: staleIdentity,
      updatedAt: "2026-07-01T00:00:00.000Z",
    });
    const freshIdentified = makeProject("fresh-identified", "/work/t3code/", {
      updatedAt: "2026-07-02T00:00:00.000Z",
    });
    const winner = makeProject("winner", "/work/t3code", {
      repositoryIdentity: null,
      updatedAt: "2026-07-03T00:00:00.000Z",
    });
    const sibling = makeProject("sibling", "/work/t3code-2");

    const groups = buildProjectGroups({
      projects: [staleIdentified, freshIdentified, winner, sibling],
      settings: settings("repository"),
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.members.map((member) => member.project.id)).toEqual(["winner", "sibling"]);
  });
});

describe("workspace-file project grouping", () => {
  const remoteEnvironmentId = EnvironmentId.make("remote-environment");

  it("keeps plain project keys unchanged when the workspace file is absent or null", () => {
    const plain = makeProject("plain", "/work/t3code/");
    expect(derivePhysicalProjectKey(plain)).toBe("environment:/work/t3code");
    expect(derivePhysicalProjectKey({ ...plain, workspaceFile: null })).toBe(
      derivePhysicalProjectKey(plain),
    );
  });

  it("keys linked projects by the normalized workspace file rather than the primary folder", () => {
    const linked = makeProject("linked", "C:/work/t3code", {
      workspaceFile: "C:/work/T3.code-workspace",
    });
    const refreshed = {
      ...linked,
      workspaceRoot: "C:/work/another-primary",
      workspaceFile: "c:\\work\\t3.code-workspace",
    };
    expect(derivePhysicalProjectKey(refreshed)).toBe(derivePhysicalProjectKey(linked));
    expect(derivePhysicalProjectKey({ ...linked, environmentId: remoteEnvironmentId })).not.toBe(
      derivePhysicalProjectKey(linked),
    );
    expect(
      derivePhysicalProjectKey({ ...linked, workspaceFile: "C:/other/T3.code-workspace" }),
    ).not.toBe(derivePhysicalProjectKey(linked));
  });

  it("distinguishes a workspace file from a plain directory with the same path", () => {
    const plain = makeProject("plain", "/work/t3.code-workspace");
    const linked = makeProject("linked", "/work/t3code", {
      workspaceFile: plain.workspaceRoot,
    });
    expect(derivePhysicalProjectKey(linked)).not.toBe(derivePhysicalProjectKey(plain));
  });

  it.each(["repository", "repository_path", "separate"] as const)(
    "preserves plain and linked projects sharing a primary folder in %s mode",
    (mode) => {
      const projects = [
        makeProject("plain", "/work/t3code"),
        makeProject("linked", "/work/t3code", { workspaceFile: "/work/t3.code-workspace" }),
        makeProject("other-linked", "/work/t3code", {
          workspaceFile: "/work/other.code-workspace",
        }),
      ];
      const groups = buildProjectGroups({ projects, settings: settings(mode) });
      expect(groups).toHaveLength(3);
      expect(groups.flatMap((group) => group.members.map((member) => member.project.id))).toEqual([
        "plain",
        "linked",
        "other-linked",
      ]);
      expect(groups.map((group) => group.memberProjectRefs)).toEqual(
        projects.map((project) => [
          { environmentId: project.environmentId, projectId: project.id },
        ]),
      );
    },
  );

  it.each(["repository", "repository_path"] as const)(
    "groups matching file names and primary repository identities across environments in %s mode",
    (mode) => {
      const local = makeProject("local", "/work/t3code/apps/web", {
        workspaceFile: "/work/t3.code-workspace",
        repositoryIdentity: { ...repositoryIdentity, rootPath: "/work/t3code" },
      });
      const remote = makeProject("remote", "C:/src/t3code/apps/web", {
        environmentId: remoteEnvironmentId,
        workspaceFile: "C:\\workspaces\\t3.code-workspace",
        repositoryIdentity: { ...repositoryIdentity, rootPath: "C:/src/t3code" },
      });
      const groups = buildProjectGroups({
        projects: [local, remote],
        settings: settings(mode),
        preferredEnvironmentId: remoteEnvironmentId,
      });
      expect(groups).toHaveLength(1);
      expect(groups[0]?.members.map((member) => member.project.id)).toEqual(["local", "remote"]);
      expect(groups[0]?.memberProjectRefs).toHaveLength(2);
      expect(groups[0]?.representative).toBe(remote);
    },
  );

  it("retains repository-relative primary paths when grouping linked projects by repository and path", () => {
    const linked = makeProject("linked", "/work/t3code/apps/web", {
      workspaceFile: "/work/t3.code-workspace",
      repositoryIdentity: { ...repositoryIdentity, rootPath: "/work/t3code" },
    });
    const remote = makeProject("remote", "C:/src/t3code/packages/shared", {
      environmentId: remoteEnvironmentId,
      workspaceFile: "C:/src/t3.code-workspace",
      repositoryIdentity: { ...repositoryIdentity, rootPath: "C:/src/t3code" },
    });
    const projects = [linked, remote];
    expect(buildProjectGroups({ projects, settings: settings("repository") })).toHaveLength(1);
    expect(buildProjectGroups({ projects, settings: settings("repository_path") })).toHaveLength(2);
  });

  it("preserves physical clones of matching linked projects in the same environment", () => {
    const projects = [
      makeProject("first", "/work/t3code", { workspaceFile: "/work/t3.code-workspace" }),
      makeProject("second", "/other/t3code", { workspaceFile: "/other/t3.code-workspace" }),
    ];
    const groups = buildProjectGroups({ projects, settings: settings("repository") });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.members.map((member) => member.project.id)).toEqual(["first", "second"]);
    expect(groups[0]?.memberProjectRefs).toHaveLength(2);
  });

  it.each(["repository", "repository_path"] as const)(
    "keeps different file names, primary identities, and plain projects separate in %s mode",
    (mode) => {
      const linked = makeProject("linked", "/work/t3code", {
        workspaceFile: "/work/t3.code-workspace",
      });
      const projects = [
        linked,
        makeProject("different-name", "/remote/t3code", {
          environmentId: remoteEnvironmentId,
          workspaceFile: "/remote/other.code-workspace",
        }),
        makeProject("different-repository", "/remote/other", {
          environmentId: remoteEnvironmentId,
          workspaceFile: "/remote/t3.code-workspace",
          repositoryIdentity: { ...repositoryIdentity, canonicalKey: "github.com/t3tools/other" },
        }),
        makeProject("plain", "/remote/plain", { environmentId: remoteEnvironmentId }),
      ];
      expect(buildProjectGroups({ projects, settings: settings(mode) })).toHaveLength(4);
    },
  );

  it("keeps matching files without primary repository identities physically scoped", () => {
    const linked = makeProject("linked", "/work/t3code", {
      workspaceFile: "/work/t3.code-workspace",
      repositoryIdentity: null,
    });
    const remote = { ...linked, id: ProjectId.make("remote"), environmentId: remoteEnvironmentId };
    const groups = buildProjectGroups({
      projects: [linked, remote],
      settings: settings("repository"),
    });
    expect(groups.map((group) => group.key)).toEqual([
      derivePhysicalProjectKey(linked),
      derivePhysicalProjectKey(remote),
    ]);
  });

  it.each(["repository", "repository_path"] as const)(
    "preserves backslashes in POSIX workspace-file names in %s mode",
    (mode) => {
      const linked = makeProject("linked", "/work/t3code", {
        workspaceFile: "/work/alpha\\t3.code-workspace",
      });
      const remote = makeProject("remote", "/remote/t3code", {
        environmentId: remoteEnvironmentId,
        workspaceFile: "/remote/t3.code-workspace",
      });
      expect(
        buildProjectGroups({ projects: [linked, remote], settings: settings(mode) }),
      ).toHaveLength(2);
    },
  );

  it("honors separate mode for matching linked projects across environments", () => {
    const linked = makeProject("linked", "/work/t3code", {
      workspaceFile: "/work/t3.code-workspace",
    });
    const remote = { ...linked, id: ProjectId.make("remote"), environmentId: remoteEnvironmentId };
    expect(
      buildProjectGroups({ projects: [linked, remote], settings: settings("separate") }),
    ).toHaveLength(2);
  });

  it("keeps ordering and grouping overrides independent for projects sharing a primary folder", () => {
    const plain = makeProject("plain", "/work/t3code");
    const linked = makeProject("linked", plain.workspaceRoot, {
      workspaceFile: "/work/t3.code-workspace",
    });
    const remote = { ...linked, id: ProjectId.make("remote"), environmentId: remoteEnvironmentId };
    expect(getProjectOrderKey(linked)).not.toBe(getProjectOrderKey(plain));
    expect(deriveProjectGroupingOverrideKey(linked)).not.toBe(
      deriveProjectGroupingOverrideKey(plain),
    );
    const groups = buildProjectGroups({
      projects: [plain, linked, remote],
      settings: settings("repository", { [deriveProjectGroupingOverrideKey(linked)]: "separate" }),
    });
    expect(groups).toHaveLength(3);
  });

  it("deduplicates refreshed registrations of one workspace file and preserves their thread targets", () => {
    const stale = makeProject("stale", "/work/t3code", {
      workspaceFile: "/work/t3.code-workspace",
    });
    const fresh = makeProject("fresh", "/work/new-primary", {
      workspaceFile: stale.workspaceFile,
      updatedAt: "2026-07-02T00:00:00.000Z",
    });
    const groups = buildProjectGroups({ projects: [stale, fresh], settings: settings("separate") });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.members.map((member) => member.project.id)).toEqual(["fresh"]);
    expect(groups[0]?.memberProjectRefs).toHaveLength(2);
  });
});

describe("sortProjectsByGroupOrder", () => {
  const remote = EnvironmentId.make("remote");
  const ref = (projectId: string, env = environmentId) => ({
    environmentId: env,
    projectId: ProjectId.make(projectId),
  });
  const project = (id: string, env: string = environmentId) => ({ id, environmentId: env });

  it("tells the same project id on two environments apart", () => {
    const sorted = sortProjectsByGroupOrder(
      [project("shared"), project("shared", remote)],
      [{ memberProjectRefs: [ref("shared", remote)] }, { memberProjectRefs: [ref("shared")] }],
    );
    expect(sorted.map((entry) => entry.environmentId)).toEqual([remote, environmentId]);
  });
});
