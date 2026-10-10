import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentProject } from "./models.ts";
import { chooseLoadBalancedEnvironment } from "../load-balancing.ts";
import {
  buildProjectGroups,
  derivePhysicalProjectKey,
  deriveProjectGroupingOverrideKey,
  getProjectOrderKey,
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

  it("uses a shared custom title as the repository group's label", () => {
    const projects = [
      makeProject("first", "/work/t3code", { title: "Custom project" }),
      makeProject("second", "/work/t3code-2", { title: "Custom project" }),
    ];

    expect(buildProjectGroups({ projects, settings: settings("repository") })[0]?.label).toBe(
      "Custom project",
    );
  });

  it("keeps the repository label when shared titles match its repository name", () => {
    const projects = [
      makeProject("first", "/work/t3code", { title: "t3code" }),
      makeProject("second", "/work/t3code-2", { title: "t3code" }),
    ];

    expect(buildProjectGroups({ projects, settings: settings("repository") })[0]?.label).toBe(
      "T3 Code",
    );
  });

  it("keeps physical clones in separate groups when requested", () => {
    const projects = [
      makeProject("t3code", "/work/t3code"),
      makeProject("t3code-2", "/work/t3code-2"),
      makeProject("t3code-3", "/work/t3code-3"),
    ];

    const groups = buildProjectGroups({ projects, settings: settings("separate") });
    expect(groups).toHaveLength(3);
    expect(groups.flatMap((group) => group.members)).toHaveLength(3);
    expect(groups.map((group) => group.label)).toEqual(["t3code", "t3code-2", "t3code-3"]);
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

  it("uses repository identity from a duplicate registration when the winner lacks it", () => {
    const identified = makeProject("identified", "/work/t3code", {
      updatedAt: "2026-07-01T00:00:00.000Z",
    });
    const freshUnidentified = makeProject("fresh", "/work/t3code/", {
      repositoryIdentity: null,
      updatedAt: "2026-07-02T00:00:00.000Z",
    });
    const sibling = makeProject("sibling", "/work/t3code-2");

    const groups = buildProjectGroups({
      projects: [identified, freshUnidentified, sibling],
      settings: settings("repository"),
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.members.map((member) => member.project.id)).toEqual(["fresh", "sibling"]);
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
      const remote = makeProject("remote", "C:/src/t3code/packages/shared", {
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
