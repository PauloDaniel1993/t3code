import { describe, expect, it } from "@effect/vitest";
import type { VcsStatusResult } from "@t3tools/contracts";
import { workspaceGitSummary, worktreeBranchAgreement } from "./workspace-git-model";

const checkouts = [
  { repositoryRoot: "/api", root: "/api", cwd: "/api", label: "api", expectedBranch: null },
  { repositoryRoot: "/web", root: "/web", cwd: "/web", label: "web", expectedBranch: null },
];
function status(refName: string | null): VcsStatusResult {
  return {
    isRepo: true,
    refName,
    hasPrimaryRemote: true,
    isDefaultRef: false,
    hasWorkingTreeChanges: true,
    workingTree: {
      files: [{ path: "index.ts", insertions: 2, deletions: 1 }],
      insertions: 2,
      deletions: 1,
    },
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
  };
}
describe("workspace Git presentation", () => {
  it("maps symlink aliases through checkout-space paths and excludes unavailable nested owners", () => {
    const checkout = { ...checkouts[0]!, root: "/repo", cwd: "/alias" };
    const value = {
      ...status("main"),
      workingTree: {
        files: ["packages/api/index.ts", "packages/api/docs/guide.md"].map((path) => ({
          path,
          insertions: 1,
          deletions: 0,
        })),
        insertions: 2,
        deletions: 0,
      },
    };
    const folders = [
      { label: "api", effectivePath: "/alias", diffPath: "/repo/packages/api" },
      {
        label: "docs",
        effectivePath: null,
        diffPath: "/repo/packages/api/docs",
        unavailable: true,
      },
    ];
    expect(
      workspaceGitSummary([checkout], [value], folders).files.map((file) => file.displayPath),
    ).toEqual(["api/index.ts"]);
  });
  it("current checkouts on different branches are mixed and never drifted", () => {
    const summary = workspaceGitSummary(checkouts, [status("main"), status("feature")]);
    expect(summary.branch).toBe("Mixed branches");
    expect(summary.drifted).toBe(0);
    expect(summary.files.map((file) => file.displayPath)).toEqual(["api/index.ts", "web/index.ts"]);
  });
  it("compares each member with its own recorded branch, including suffixes", () => {
    const set = checkouts.map((checkout, index) => ({
      ...checkout,
      expectedBranch: index === 0 ? "feature" : "feature-web",
    }));
    expect(workspaceGitSummary(set, [status("feature"), status("feature-web")]).drifted).toBe(0);
    expect(workspaceGitSummary(set, [status("feature"), status("elsewhere")]).drifted).toBe(1);
  });
  it("unknown status cannot imply a clean checkout or branch agreement", () => {
    expect(workspaceGitSummary(checkouts, [status("feature"), null]).known).toBe(false);
    expect(
      workspaceGitSummary(checkouts, [{ ...status("feature"), isRepo: false }, status("feature")])
        .known,
    ).toBe(false);
    expect(
      worktreeBranchAgreement(
        [{ branch: "feature" }, { branch: "feature" }],
        [status("feature"), null],
      ),
    ).toBeNull();
  });
  it("retains prefixes for two folders sharing one checkout", () => {
    const folders = [
      { label: "api", effectivePath: "/api" },
      { label: "web", effectivePath: "/api/web" },
    ];
    expect(
      workspaceGitSummary([checkouts[0]!], [status("main")], folders).files[0]?.displayPath,
    ).toBe("api/index.ts");
    expect(
      workspaceGitSummary([checkouts[0]!], [status("main")], folders.slice(0, 1)).files[0]
        ?.displayPath,
    ).toBe("index.ts");
  });
  it("uses the deepest folder label and keeps checkout changes outside the workspace visible on Windows", () => {
    const checkout = { ...checkouts[0]!, root: "C:\\repo", cwd: "C:\\repo\\api" };
    const files = ["api/index.ts", "api/nested/util.ts", "web/index.ts", "outside.txt"];
    const value = {
      ...status("main"),
      workingTree: {
        files: files.map((path) => ({ path, insertions: 1, deletions: 0 })),
        insertions: 4,
        deletions: 0,
      },
    };
    const folders = [
      { label: "api", effectivePath: "c:\\repo\\api" },
      { label: "nested", effectivePath: "C:\\repo\\api\\nested" },
      { label: "web", effectivePath: "C:\\repo\\web" },
    ];
    expect(
      workspaceGitSummary([checkout], [value], folders).files.map((file) => [
        file.folderLabel,
        file.displayPath,
        file.path,
      ]),
    ).toEqual([
      ["api", "api/index.ts", "api/index.ts"],
      ["nested", "nested/util.ts", "api/nested/util.ts"],
      ["web", "web/index.ts", "web/index.ts"],
      [null, "api (repository)/outside.txt", "outside.txt"],
    ]);
  });
  it("does not count a nested checkout's files in its parent", () => {
    const nested = { ...checkouts[1]!, root: "/api/web", cwd: "/api/web" };
    const parent = {
      ...status("main"),
      workingTree: {
        files: [{ path: "web/index.ts", insertions: 1, deletions: 0 }],
        insertions: 1,
        deletions: 0,
      },
    };
    const folders = [
      { label: "api", effectivePath: "/api" },
      { label: "web", effectivePath: "/api/web" },
    ];
    expect(
      workspaceGitSummary([checkouts[0]!, nested], [parent, status("main")], folders).files.map(
        (file) => file.displayPath,
      ),
    ).toEqual(["web/index.ts"]);
    // Excluding the nested repo after a status failure cannot assign its files to its parent.
    expect(
      workspaceGitSummary([checkouts[0]!], [parent], folders, [checkouts[0]!, nested]).files,
    ).toEqual([]);
  });
  it("a one-repository worktree does not get an agreement hint", () => {
    expect(worktreeBranchAgreement([{ branch: "feature" }], [status("feature")])).toBeNull();
  });
  it("shows the number of agreeing members without replacing their branch label", () => {
    expect(
      worktreeBranchAgreement(
        [{ branch: "feature" }, { branch: "feature-web" }],
        [status("feature"), status("other")],
      ),
    ).toEqual({ agreed: 1, total: 2, drifted: true });
  });
});
