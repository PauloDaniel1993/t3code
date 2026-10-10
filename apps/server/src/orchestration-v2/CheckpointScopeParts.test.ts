import { assert, describe, it } from "@effect/vitest";
import {
  CheckpointScopeId,
  NodeId,
  type OrchestrationV2CheckpointScope,
  type OrchestrationV2ThreadWorkspaceFolder,
  type OrchestrationV2ThreadWorktree,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as NodeCrypto from "node:crypto";

import {
  checkpointBarrierStatus,
  checkpointScopeForRun,
  checkpointScopeParts,
  runFolderPaths,
} from "./CheckpointScopeParts.ts";

const hashKey = (location: string) =>
  NodeCrypto.createHash("sha256").update(location).digest("hex").slice(0, 16);

const folder = (
  path: string,
  label: string,
  checkout?: { readonly root: string | null; readonly prefix?: string },
): OrchestrationV2ThreadWorkspaceFolder => ({
  path,
  name: label,
  label,
  ...(checkout === undefined ? {} : { checkoutRoot: checkout.root }),
  ...(checkout?.prefix === undefined ? {} : { checkoutPrefix: checkout.prefix }),
});

const rootThread = (workspaceFolders: ReadonlyArray<OrchestrationV2ThreadWorkspaceFolder>) => ({
  worktreePath: null,
  workspaceFolders,
});

describe("checkpointScopeParts", () => {
  it("leaves a thread with one folder, or none, checkpointing its cwd", () => {
    assert.isUndefined(checkpointScopeParts({ thread: { worktreePath: null } }));
    assert.isUndefined(
      checkpointScopeParts({
        thread: rootThread([folder("/repo/app", "app", { root: "/repo", prefix: "app" })]),
      }),
    );
  });

  it("gives each checkout one part, its folders as pathspecs, and excludes nested checkouts", () => {
    const parts = checkpointScopeParts({
      thread: rootThread([
        folder("/mono/a", "a", { root: "/mono", prefix: "a" }),
        folder("/mono/b", "b", { root: "/mono", prefix: "b" }),
        // Inside folder a, so its pathspec adds nothing.
        folder("/mono/a/docs", "docs", { root: "/mono", prefix: "a/docs" }),
        folder("/mono/a/inner", "inner", { root: "/mono/a/inner", prefix: "" }),
        folder("/notes", "notes", { root: null }),
      ]),
    });

    assert.deepStrictEqual(parts, [
      {
        key: "primary",
        cwd: "/mono",
        vcs: "git",
        pathspecs: [":(literal)a", ":(literal)b", ":(exclude,literal)a/inner"],
        folders: [
          { folderPath: "/mono/a", label: "a", relativePath: "a" },
          { folderPath: "/mono/b", label: "b", relativePath: "b" },
          { folderPath: "/mono/a/docs", label: "docs", relativePath: "a/docs" },
        ],
      },
      {
        key: hashKey("/mono/a/inner"),
        cwd: "/mono/a/inner",
        vcs: "git",
        pathspecs: ["."],
        folders: [{ folderPath: "/mono/a/inner", label: "inner", relativePath: "" }],
      },
      {
        key: hashKey("/notes"),
        cwd: "/notes",
        vcs: null,
        pathspecs: ["."],
        folders: [{ folderPath: "/notes", label: "notes", relativePath: "" }],
      },
    ]);
  });

  it("covers a whole checkout with one pathspec when a folder is its root", () => {
    const parts = checkpointScopeParts({
      thread: rootThread([
        folder("/repo", "repo", { root: "/repo", prefix: "" }),
        folder("/repo/pkg", "pkg", { root: "/repo", prefix: "pkg" }),
      ]),
    });

    assert.deepStrictEqual(
      parts?.map((part) => part.pathspecs),
      [["."]],
    );
  });

  it("excludes a nested checkout only from the member folders around it", () => {
    const parts = checkpointScopeParts({
      thread: rootThread([
        folder("/mono/a", "a", { root: "/mono", prefix: "a" }),
        folder("/mono/c/inner", "inner", { root: "/mono/c/inner", prefix: "" }),
      ]),
    });

    assert.deepStrictEqual(
      parts?.map((part) => part.pathspecs),
      [[":(literal)a"], ["."]],
    );
  });

  it("records folders unavailable at binding but skips folders this run can't reach", () => {
    const parts = checkpointScopeParts({
      thread: rootThread([
        folder("/api", "api", { root: "/api", prefix: "" }),
        // Unavailable when the thread was bound: not checkpointed for this thread.
        folder("/late", "late"),
        folder("/gone", "gone", { root: "/gone", prefix: "" }),
        { uri: "vscode-remote://ssh-remote+devbox/srv/web", name: "web", label: "web" },
      ]),
      unavailableFolderPaths: ["/gone"],
    });

    assert.deepStrictEqual(
      parts?.map((part) => [part.key, part.cwd, part.vcs]),
      [
        ["primary", "/api", "git"],
        [hashKey("/late"), "/late", null],
      ],
    );
  });

  it("places a worktree thread's parts at its member worktrees", () => {
    const worktrees: ReadonlyArray<OrchestrationV2ThreadWorktree> = [
      { repositoryRoot: "/src/api", path: "/wt/S/api", branch: "t3code/x" },
      { repositoryRoot: "/src/web", path: "/wt/S/web", branch: "t3code/x" },
    ];
    const parts = checkpointScopeParts({
      thread: {
        worktreePath: "/wt/S/api/server",
        workspaceFolders: [
          folder("/src/api/server", "server", { root: "/src/api", prefix: "server" }),
          folder("/src/web", "web", { root: "/src/web", prefix: "" }),
          // Not a member, so it is checkpointed in place.
          folder("/shared", "shared", { root: "/shared", prefix: "" }),
        ],
        worktrees,
      },
    });

    assert.deepStrictEqual(
      parts?.map((part) => [part.key, part.cwd, part.pathspecs]),
      [
        ["primary", "/wt/S/api", [":(literal)server"]],
        [hashKey("/src/web"), "/wt/S/web", ["."]],
        [hashKey("/shared"), "/shared", ["."]],
      ],
    );
  });

  it("keeps glob characters in folder names literal and handles Windows paths", () => {
    const parts = checkpointScopeParts({
      thread: rootThread([
        folder("C:\\Repo\\[app]", "app", { root: "C:\\Repo", prefix: "[app]" }),
        folder("c:\\repo\\lib", "lib", { root: "c:\\repo", prefix: "lib" }),
        folder("C:\\Repo\\lib\\Nested", "nested", { root: "C:\\Repo\\lib\\Nested", prefix: "" }),
      ]),
    });

    assert.deepStrictEqual(
      parts?.map((part) => [part.cwd, part.pathspecs]),
      [
        ["C:\\Repo", [":(literal)[app]", ":(literal)lib", ":(exclude,literal)lib/Nested"]],
        ["C:\\Repo\\lib\\Nested", ["."]],
      ],
    );
  });
});

describe("checkpointScopeParts with moved or missing folders", () => {
  it("keeps a primary that a legacy writer moved into a worktree on its own part", () => {
    const parts = checkpointScopeParts({
      thread: {
        worktreePath: "/wt/feature",
        workspaceFolders: [
          folder("/mono/a", "a", { root: "/mono", prefix: "a" }),
          folder("/mono/b", "b", { root: "/mono", prefix: "b" }),
        ],
      },
    });

    assert.deepStrictEqual(
      parts?.map((part) => [part.key, part.cwd, part.vcs, part.pathspecs, part.folders]),
      [
        [
          "primary",
          "/wt/feature",
          "git",
          ["."],
          [{ folderPath: "/mono/a", label: "a", relativePath: "" }],
        ],
        [
          hashKey("/mono"),
          "/mono",
          "git",
          [":(literal)b"],
          [{ folderPath: "/mono/b", label: "b", relativePath: "b" }],
        ],
      ],
    );
  });

  it("still excludes a nested checkout this run can't reach", () => {
    const parts = checkpointScopeParts({
      thread: rootThread([
        folder("/mono/a", "a", { root: "/mono", prefix: "a" }),
        folder("/mono/a/inner", "inner", { root: "/mono/a/inner", prefix: "" }),
      ]),
      unavailableFolderPaths: ["/mono/a/inner"],
    });

    assert.deepStrictEqual(
      parts?.map((part) => part.pathspecs),
      [[":(literal)a", ":(exclude,literal)a/inner"]],
    );
  });

  it("never widens a folder without a known place in its checkout to the whole checkout", () => {
    const parts = checkpointScopeParts({
      thread: rootThread([
        folder("/repo", "repo", { root: "/repo", prefix: "" }),
        // Reached through a symlink, and recorded without its prefix.
        folder("/link/lib", "lib", { root: "/real/mono" }),
      ]),
    });

    assert.deepStrictEqual(
      parts?.map((part) => [part.cwd, part.vcs, part.pathspecs]),
      [
        ["/repo", "git", ["."]],
        ["/link/lib", null, ["."]],
      ],
    );
  });
});

describe("checkpointScopeForRun", () => {
  const scope = {
    id: CheckpointScopeId.make("scope:for-run"),
    threadId: ThreadId.make("thread:for-run"),
    runId: RunId.make("run:later"),
    nodeId: NodeId.make("node:for-run"),
    parentScopeId: null,
    providerThreadId: null,
    kind: "root_run",
    ordinalWithinParent: 0,
    advancesAppRunCount: true,
    cwd: "/app",
    createdAt: DateTime.makeUnsafe("2026-10-10T00:00:00.000Z"),
  } satisfies OrchestrationV2CheckpointScope;
  const thread = rootThread([
    folder("/app", "app", { root: "/app", prefix: "" }),
    folder("/lib", "lib", { root: "/lib", prefix: "" }),
  ]);

  it("plans a run's parts from its own folder facts, not the scope row's latest plan", () => {
    // A later run planned both folders; this one couldn't reach lib.
    const later = { ...scope, parts: checkpointScopeParts({ thread }) ?? [] };
    const own = checkpointScopeForRun({
      scope: later,
      thread,
      run: { unavailableFolderPaths: ["/lib"] },
    });

    assert.deepStrictEqual(
      own.parts?.map((part) => part.cwd),
      ["/app"],
    );
    assert.deepStrictEqual(runFolderPaths(thread, { unavailableFolderPaths: ["/lib"] }), ["/app"]);
  });

  it("leaves a scope without parts as it is", () => {
    assert.strictEqual(checkpointScopeForRun({ scope, thread, run: {} }), scope);
    assert.deepStrictEqual(runFolderPaths({ worktreePath: null }, {}), []);
  });
});

describe("checkpointBarrierStatus", () => {
  it.each([
    {
      parts: [
        ["git", "ready"],
        [null, "missing"],
      ],
      expected: "ready",
    },
    {
      parts: [
        ["git", "ready"],
        ["git", "missing"],
      ],
      expected: "missing",
    },
    {
      parts: [
        ["git", "missing"],
        ["git", "error"],
      ],
      expected: "error",
    },
    {
      parts: [
        ["git", "error"],
        ["git", "ready"],
      ],
      expected: "error",
    },
    { parts: [[null, "missing"]], expected: "missing" },
  ] as const)("$parts is $expected", ({ parts, expected }) => {
    assert.equal(
      checkpointBarrierStatus(parts.map(([vcs, status]) => ({ vcs, status }))),
      expected,
    );
  });
});
