import { describe, expect, it } from "@effect/vitest";
import type { VcsWorkspaceActionProgressEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";
import { consumeWorkspaceActionProgress, workspaceBranchState } from "./workspaceVcs.ts";

describe("workspace branch presentation", () => {
  const status = (refName: string | null) => ({ isRepo: true, refName });
  it("treats different current-checkout branches as mixed, with no drift", () => {
    expect(
      workspaceBranchState(
        [{ expectedBranch: null }, { expectedBranch: null }],
        [status("main"), status("feature")],
      ),
    ).toMatchObject({ mixed: true, drifted: 0, branch: "Mixed branches" });
  });
  it("compares each set member with its own expected suffix", () => {
    const members = [{ expectedBranch: "feature" }, { expectedBranch: "feature-api" }];
    expect(workspaceBranchState(members, [status("feature"), status("feature-api")])).toMatchObject(
      { mixed: false, drifted: 0, hint: "2/2" },
    );
    expect(workspaceBranchState(members, [status("feature"), status(null)])).toMatchObject({
      drifted: 1,
      hint: "1/2 drifted",
    });
  });
  it("waits for all member branches before presenting agreement", () => {
    expect(
      workspaceBranchState(
        [{ expectedBranch: "feature" }, { expectedBranch: "feature" }],
        [status("feature"), null],
      ),
    ).toMatchObject({ complete: false, hint: null, drifted: 0 });
  });
});

describe("workspace action progress", () => {
  it.effect(
    "retains independent failures until the workspace result, and ignores other actions",
    () =>
      Effect.gen(function* () {
        const terminal: VcsWorkspaceActionProgressEvent = {
          kind: "workspace_action_finished",
          actionId: "batch",
          results: [
            {
              repositoryRoot: "/api",
              cwd: "/api/service",
              label: "api",
              outcome: { _tag: "failed", message: "Hook refused" },
            },
          ],
        };
        const events: Array<VcsWorkspaceActionProgressEvent> = [];
        const result = yield* consumeWorkspaceActionProgress(
          Stream.make(
            { kind: "workspace_action_finished", actionId: "other", results: [] },
            {
              kind: "action_failed",
              actionId: "batch",
              action: "commit",
              cwd: "/api/service",
              phase: null,
              message: "Hook refused",
            },
            terminal,
          ),
          "batch",
          (event) => {
            events.push(event);
          },
        );
        expect(result).toEqual({ results: terminal.results });
        expect(events.map((event) => event.kind)).toEqual([
          "action_failed",
          "workspace_action_finished",
        ]);
      }),
  );
  it.effect("rejects a truncated stream instead of reporting success", () =>
    Effect.gen(function* () {
      const exit = yield* consumeWorkspaceActionProgress(Stream.empty, "batch").pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );
  it.effect("presentation exceptions do not lose the terminal result", () =>
    Effect.gen(function* () {
      const result = yield* consumeWorkspaceActionProgress(
        Stream.make({ kind: "workspace_action_finished", actionId: "batch", results: [] }),
        "batch",
        () => {
          throw new Error("unmounted");
        },
      );
      expect(result).toEqual({ results: [] });
    }),
  );
});
