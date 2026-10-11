import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { WorkspaceMcpBinding } from "./workspaceMcp.ts";
import {
  WorktreeMcpHandoffResult,
  WorktreeMcpListInput,
  WorktreeMcpListResult,
  WorktreeMcpStatusResult,
} from "./worktreeMcp.ts";

const decodeWorkspaceMcpBinding = Schema.decodeUnknownSync(WorkspaceMcpBinding);
const decodeWorktreeMcpHandoffResult = Schema.decodeUnknownSync(WorktreeMcpHandoffResult);
const encodeWorktreeMcpHandoffResult = Schema.encodeSync(WorktreeMcpHandoffResult);
const decodeWorktreeMcpListInput = Schema.decodeUnknownSync(WorktreeMcpListInput);
const decodeWorktreeMcpListResult = Schema.decodeUnknownSync(WorktreeMcpListResult);
const encodeWorktreeMcpListResult = Schema.encodeSync(WorktreeMcpListResult);
const decodeWorktreeMcpStatusResult = Schema.decodeUnknownSync(WorktreeMcpStatusResult);
const encodeWorktreeMcpStatusResult = Schema.encodeSync(WorktreeMcpStatusResult);

const binding = {
  cwd: "C:/worktrees/primary/src",
  workspaceFile: "C:/team.code-workspace",
  folders: [
    {
      path: "C:/repo/primary/src",
      name: "App",
      label: "app",
      checkoutRoot: "C:/repo/primary",
      checkoutPrefix: "src",
      availability: "available",
      effectivePath: "C:/worktrees/primary/src",
    },
    {
      uri: "vscode-remote://host/folder",
      name: "Remote",
      label: "remote",
      availability: "unavailable",
      effectivePath: null,
    },
  ],
  worktrees: [
    { repositoryRoot: "C:/repo/primary", path: "C:/worktrees/primary", branch: "feature/set" },
  ],
};

it("worktree status and handoff retain the entire binding on the wire", () => {
  const status = {
    ...binding,
    attached: true,
    worktreePath: binding.cwd,
    branch: "feature/set",
    projectWorkspaceRoot: "C:/repo/primary/src",
    defaultStartFromOrigin: false,
  };
  const handoff = {
    ...binding,
    worktreePath: binding.cwd,
    branch: "feature/set",
    baseRef: "dev",
    startedFromOrigin: false,
    setupScript: { status: "skipped" },
    continuation: { status: "skipped" },
    note: "Handoff recorded.",
  };
  expect(encodeWorktreeMcpStatusResult(decodeWorktreeMcpStatusResult(status))).toEqual(status);
  expect(encodeWorktreeMcpHandoffResult(decodeWorktreeMcpHandoffResult(handoff))).toEqual(handoff);
});

it("plain one-folder bindings omit the tuple and use a null workspace file", () => {
  const plain = {
    cwd: "/repo",
    workspaceFile: null,
    folders: [
      {
        path: "/repo",
        name: "repo",
        label: "repo",
        availability: "available",
        effectivePath: "/repo",
      },
    ],
  };
  expect(decodeWorkspaceMcpBinding(plain)).toEqual(plain);
  expect(() =>
    decodeWorkspaceMcpBinding({
      ...plain,
      folders: [{ ...plain.folders[0], availability: "unknown" }],
    }),
  ).toThrow();
});

it("folder selection is additive to ref queries and results keep nullable repository roots", () => {
  const query = {
    query: "feature",
    cursor: 2,
    limit: 3,
    refKind: "local",
    includeMatchingRemoteRefs: false,
  };
  expect(decodeWorktreeMcpListInput(query)).toEqual(query);
  expect(decodeWorktreeMcpListInput({ ...query, folderPath: "C:/repo/secondary" }).folderPath).toBe(
    "C:/repo/secondary",
  );
  const nonGit = {
    refs: [],
    isRepo: false,
    hasPrimaryRemote: false,
    nextCursor: null,
    totalCount: 0,
    folderPath: "/docs",
    cwd: "/docs",
    repositoryRoot: null,
  };
  expect(encodeWorktreeMcpListResult(decodeWorktreeMcpListResult(nonGit))).toEqual(nonGit);
});
