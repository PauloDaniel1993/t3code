import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  GitCommandError,
  GitPreparePullRequestThreadResult,
  GitRunStackedActionInput,
  VcsRunWorkspaceActionInput,
  VcsStatusInput,
} from "./git.ts";

const decodeGitCommandError = Schema.decodeUnknownSync(Schema.toCodecJson(GitCommandError));
const decodePreparePullRequestThreadResult = Schema.decodeUnknownSync(
  GitPreparePullRequestThreadResult,
);
const decodeRunStackedActionInput = Schema.decodeUnknownSync(GitRunStackedActionInput);

describe("GitCommandError", () => {
  it("decodes an unknown failure reason as absent", () => {
    const error = decodeGitCommandError({
      _tag: "GitCommandError",
      operation: "GitVcsDriver.createWorktree",
      command: "git",
      cwd: "/repo",
      detail: "git worktree add failed",
      reason: "added_by_a_newer_server",
    });

    expect(error.reason).toBeUndefined();
    expect(error.message).toBe(
      "Git command failed in GitVcsDriver.createWorktree (/repo): git worktree add failed",
    );
  });
});

describe("GitPreparePullRequestThreadResult", () => {
  it("defaults legacy responses to the pull request head", () => {
    const parsed = decodePreparePullRequestThreadResult({
      pullRequest: {
        number: 42,
        title: "PR threads",
        url: "https://github.com/pingdotgg/codething-mvp/pull/42",
        baseBranch: "main",
        headBranch: "feature/pr-threads",
        state: "open",
      },
      branch: "feature/pr-threads",
      worktreePath: "/tmp/pr-threads",
    });

    expect(parsed.isOnPullRequestHead).toBe(true);
  });
});

describe("GitRunStackedActionInput", () => {
  it("preserves leading and trailing whitespace in file paths", () => {
    const parsed = decodeRunStackedActionInput({
      actionId: "action-1",
      cwd: "/repo",
      action: "commit",
      filePaths: [" leading.txt", "trailing.txt "],
    });

    expect(parsed.filePaths).toEqual([" leading.txt", "trailing.txt "]);
  });
});

describe("VcsStatusInput", () => {
  const decodeStatusInput = Schema.decodeUnknownSync(VcsStatusInput);

  it("keeps old subscriptions full and accepts a branch scope", () => {
    expect(decodeStatusInput({ cwd: "/repo" })).toEqual({ cwd: "/repo" });
    expect(decodeStatusInput({ cwd: "/repo", scope: "branch" }).scope).toBe("branch");
    expect(() => decodeStatusInput({ cwd: "/repo", scope: "remote" })).toThrow();
  });
});

describe("VcsRunWorkspaceActionInput", () => {
  const decodeWorkspaceActionInput = Schema.decodeUnknownSync(VcsRunWorkspaceActionInput);

  it("accepts the three batch actions and a non-empty list of repository roots", () => {
    for (const action of ["commit", "push", "create-prs"]) {
      expect(
        decodeWorkspaceActionInput({ actionId: "batch-1", threadId: "thread-1", action }).action,
      ).toBe(action);
    }
    const base = { actionId: "batch-1", threadId: "thread-1", action: "push" };
    expect(decodeWorkspaceActionInput({ ...base, members: ["/src/api"] }).members).toEqual([
      "/src/api",
    ]);
    expect(() => decodeWorkspaceActionInput({ ...base, members: [] })).toThrow();
    expect(() => decodeWorkspaceActionInput({ ...base, action: "commit_push_pr" })).toThrow();
  });
});
