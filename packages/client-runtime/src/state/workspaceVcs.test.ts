import { describe, expect, it } from "@effect/vitest";
import type { VcsWorkspaceActionProgressEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";
import * as Latch from "effect/Latch";
import * as Fiber from "effect/Fiber";
import {
  consumeWorkspaceActionProgress,
  workspaceActionState,
  workspaceBranchState,
  workspaceCheckoutStatusCwds,
} from "./workspaceVcs.ts";
import { EnvironmentId, type VcsStatusResult } from "@t3tools/contracts";
import { AtomRegistry } from "effect/unstable/reactivity";
import {
  scheduleWorkspaceVcsCommand,
  vcsCommandScheduler,
  vcsCommandConcurrency,
} from "./vcsCommandScheduler.ts";
import { scheduleAtomCommandEffect } from "./runtime.ts";

describe("workspace action eligibility", () => {
  const checkouts = ["/api", "/web"].map((root) => ({
    root,
    repositoryRoot: root,
    cwd: `${root}/service`,
    label: root.slice(1),
    expectedBranch: "feature",
  }));
  const status = (isRepo: boolean, refName = "feature") => ({ isRepo, refName }) as VcsStatusResult;
  it("waits for unknown status, then excludes missing or failed members without counting false drift", () => {
    const healthy = { status: status(true), error: false };
    expect(
      workspaceActionState(
        checkouts,
        ["/api/service", "/web/service"],
        [healthy, { status: null, error: false }],
      ).ready,
    ).toBe(false);
    for (const missing of [
      { status: status(false, "other"), error: false },
      { status: null, error: true },
    ]) {
      expect(
        workspaceActionState(checkouts, ["/api/service", "/web/service"], [healthy, missing]),
      ).toMatchObject({
        ready: true,
        members: ["/api"],
        eligible: [true, false],
        branch: { drifted: 0 },
      });
    }
  });
  it("uses the root for a missing first folder, without adopting an independent nested repository", () => {
    expect(
      workspaceCheckoutStatusCwds(checkouts, [
        { label: "api", checkoutRoot: "/api", effectivePath: null, isGit: false },
        { label: "healthy", checkoutRoot: "/api", effectivePath: "/api/healthy", isGit: true },
        { label: "nested", checkoutRoot: "/web/nested", effectivePath: "/web/nested", isGit: true },
      ]),
    ).toEqual(["/api", null]);
  });
});

it.effect("serializes a batch with per-repository commands on every checkout lane", () =>
  Effect.gen(function* () {
    const registry = AtomRegistry.make();
    const environmentId = EnvironmentId.make("remote");
    const events: Array<string> = [];
    const batchStarted = Latch.makeUnsafe();
    const finishBatch = Latch.makeUnsafe();
    try {
      const batch = yield* Effect.forkChild(
        scheduleWorkspaceVcsCommand(
          registry,
          environmentId,
          ["/web", "/api", "/api"],
          Effect.gen(function* () {
            events.push("batch:start");
            batchStarted.openUnsafe();
            yield* finishBatch.await;
            events.push("batch:end");
          }),
        ),
      );
      yield* batchStarted.await;
      const singles = yield* Effect.forEach(["/api", "/web"], (cwd) =>
        Effect.forkChild(
          scheduleAtomCommandEffect(
            registry,
            vcsCommandScheduler,
            vcsCommandConcurrency,
            { environmentId, input: { cwd } },
            Effect.sync(() => {
              events.push(cwd);
            }),
          ),
        ),
      );
      const overlapping = yield* Effect.forkChild(
        scheduleWorkspaceVcsCommand(
          registry,
          environmentId,
          ["/api", "/web"],
          Effect.sync(() => {
            events.push("overlapping");
          }),
        ),
      );
      expect(events).toEqual(["batch:start"]);
      finishBatch.openUnsafe();
      yield* Effect.forEach([batch, ...singles, overlapping], Fiber.join);
      expect(events.slice(0, 2)).toEqual(["batch:start", "batch:end"]);
      expect(events.slice(2)).toEqual(expect.arrayContaining(["/api", "/web", "overlapping"]));
    } finally {
      finishBatch.openUnsafe();
      registry.dispose();
    }
  }),
);

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
    expect(workspaceBranchState(members, [status("release"), status("feature-api")])).toMatchObject(
      { branch: "feature", drifted: 1 },
    );
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
