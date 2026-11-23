import { consumeWorkspaceActionProgress } from "./workspaceVcs.ts";
import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  EnvironmentId,
  ThreadId,
  type AuthSessionState,
  type VcsWorkspaceActionProgressEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as Layer from "effect/Layer";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { EnvironmentRegistry } from "../connection/registry.ts";
import * as Persistence from "../platform/persistence.ts";
import { vcsCommandConcurrency, vcsCommandScheduler } from "./vcsCommandScheduler.ts";
import { createWorkspaceVcsAtoms, workspaceActionOutcomeSummary } from "./workspaceVcsActions.ts";

vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }),
}));
const sessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState, never>>(AsyncResult.initial()),
);

const input = { actionId: "batch", threadId: ThreadId.make("thread"), action: "push" as const };
const finished: VcsWorkspaceActionProgressEvent = {
  kind: "workspace_action_finished",
  actionId: "batch",
  results: [
    {
      repositoryRoot: "/api",
      cwd: "/session/api",
      label: "api",
      outcome: { _tag: "failed", message: "Push rejected" },
    },
    {
      repositoryRoot: "/web",
      cwd: "/session/web",
      label: "web",
      outcome: { _tag: "drifted", refName: "other", expectedBranch: "feature" },
    },
  ],
};

describe("workspace action progress", () => {
  it.effect("returns independent outcomes only from the batch receipt", () =>
    Effect.gen(function* () {
      const progress: VcsWorkspaceActionProgressEvent[] = [];
      const member: VcsWorkspaceActionProgressEvent = {
        kind: "action_failed",
        actionId: "batch",
        cwd: "/session/api",
        action: "push",
        message: "Push rejected",
        phase: "push",
      };
      const result = yield* consumeWorkspaceActionProgress(
        Stream.fromIterable([member, finished]),
        input.actionId,
        (event) => progress.push(event),
      );
      expect(result.results).toEqual(finished.results);
      expect(progress).toEqual([member, finished]);
    }),
  );
  it.effect("a member failure is not a batch completion", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        consumeWorkspaceActionProgress(
          Stream.fromIterable([
            {
              kind: "action_failed",
              actionId: "batch",
              cwd: "/api",
              action: "push",
              message: "Rejected",
              phase: "push",
            },
          ]),
          input.actionId,
          () => undefined,
        ),
      );
      expect(exit._tag).toBe("Failure");
    }),
  );
  it.effect("ignores another action's receipt and callback failures", () =>
    Effect.gen(function* () {
      const received: string[] = [];
      const result = yield* consumeWorkspaceActionProgress(
        Stream.fromIterable([{ ...finished, actionId: "another" }, finished]),
        input.actionId,
        (event) => {
          received.push(event.actionId);
          throw new Error("Unmounted UI");
        },
      );
      expect(received).toEqual(["batch"]);
      expect(result.results).toEqual(finished.results);
    }),
  );
  it.effect("propagates transport failure instead of inventing a partial result", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        consumeWorkspaceActionProgress(
          Stream.fail("disconnected"),
          input.actionId,
          () => undefined,
        ),
      );
      expect(result).toMatchObject({ _tag: "Failure", failure: "disconnected" });
    }),
  );
  it("names each failed or skipped checkout in the outcome summary", () => {
    expect(workspaceActionOutcomeSummary({ results: finished.results })).toBe(
      "api: Push rejected\nweb: Paused: switch back to feature",
    );
  });
  it.effect(
    "retains an in-flight batch and its receipt across readers, isolated by environment",
    () =>
      Effect.gen(function* () {
        const environmentId = EnvironmentId.make("environment-one");
        const otherEnvironmentId = EnvironmentId.make("environment-two");
        const phase: VcsWorkspaceActionProgressEvent = {
          kind: "phase_started",
          actionId: "batch",
          action: "push",
          cwd: "/api",
          phase: "push",
          label: "Pushing",
        };
        const receipt = yield* Deferred.make<VcsWorkspaceActionProgressEvent>();
        const started = yield* Deferred.make<void>();
        let response: Stream.Stream<VcsWorkspaceActionProgressEvent, Error> = Stream.make(
          phase,
        ).pipe(Stream.concat(Stream.fromEffect(Deferred.await(receipt))));
        const requests: EnvironmentId[] = [];
        const environments = EnvironmentRegistry.of({
          runStream: (id: EnvironmentId) => {
            requests.push(id);
            return response;
          },
        } as unknown as EnvironmentRegistry["Service"]);
        const cleared: EnvironmentId[] = [];
        const cache = Persistence.EnvironmentCacheStore.of({
          loadShell: () => Effect.succeedNone,
          saveShell: () => Effect.void,
          loadThread: () => Effect.succeedNone,
          saveThread: () => Effect.void,
          removeThread: () => Effect.void,
          loadServerConfig: () => Effect.succeedNone,
          saveServerConfig: () => Effect.void,
          loadVcsRefs: () => Effect.succeedNone,
          saveVcsRefs: () => Effect.void,
          removeVcsRefs: () => Effect.void,
          clearVcsRefs: (id) =>
            Effect.sync(() => {
              cleared.push(id);
            }),
          clear: () => Effect.void,
        });
        const runtime = Atom.runtime(
          Layer.merge(
            Layer.succeed(EnvironmentRegistry, environments),
            Layer.succeed(Persistence.EnvironmentCacheStore, cache),
          ),
        );
        const actions = createWorkspaceVcsAtoms(runtime);
        const registry = AtomRegistry.make();
        const target = { environmentId, threadId: input.threadId };
        const unmountSession = registry.mount(sessions(environmentId));
        const session: AuthSessionState = {
          authenticated: true,
          auth: {
            policy: "remote-reachable",
            bootstrapMethods: [],
            sessionMethods: [],
            sessionCookieName: "test",
          },
          scopes: [AuthSourceControlWriteScope, AuthOrchestrationOperateScope],
          permissions: [AuthSourceControlWriteScope, AuthOrchestrationOperateScope],
        };
        registry.set(sessions(environmentId), AsyncResult.success(session));
        try {
          expect(registry.get(actions.runAction.permissionAtom(environmentId, input))).toBe(true);
          const priorStarted = yield* Deferred.make<void>();
          const finishPrior = yield* Deferred.make<void>();
          const prior = yield* vcsCommandScheduler
            .schedule(
              registry,
              vcsCommandConcurrency,
              { environmentId, input: { cwd: "/api" } },
              Deferred.succeed(priorStarted, undefined).pipe(
                Effect.andThen(Deferred.await(finishPrior)),
              ),
            )
            .pipe(Effect.forkChild);
          yield* Deferred.await(priorStarted);
          const running = yield* actions.runAction
            .run(registry, {
              environmentId,
              input,
              cwds: ["/api", "/web"],
              onProgress: () => Deferred.doneUnsafe(started, Effect.void),
            })
            .pipe(Effect.forkChild({ startImmediately: true }));
          expect(requests).toEqual([]);
          yield* Deferred.succeed(finishPrior, undefined);
          yield* Fiber.join(prior);
          yield* Deferred.await(started);
          let queuedRan = false;
          const queued = yield* vcsCommandScheduler
            .schedule(
              registry,
              vcsCommandConcurrency,
              { environmentId, input: { cwd: "/web" } },
              Effect.sync(() => {
                queuedRan = true;
              }),
            )
            .pipe(Effect.forkChild({ startImmediately: true }));
          expect(queuedRan).toBe(false);
          // A sheet can unmount; its replacement reads the command-owned atom.
          expect(registry.get(actions.stateAtom({ ...target }))).toMatchObject({
            isRunning: true,
            currentLabel: "/api: Pushing",
          });
          expect(
            registry.get(actions.stateAtom({ ...target, environmentId: otherEnvironmentId }))
              .isRunning,
          ).toBe(false);
          yield* Deferred.succeed(receipt, finished);
          expect(yield* Fiber.join(running)).toEqual({ results: finished.results });
          yield* Fiber.join(queued);
          expect(queuedRan).toBe(true);
          expect(registry.get(actions.stateAtom(target))).toEqual({
            isRunning: false,
            currentLabel: null,
            result: { results: finished.results },
          });
          expect(cleared).toEqual([environmentId]);
          response = Stream.fail(new Error("Disconnected"));
          expect(
            Exit.isFailure(
              yield* Effect.exit(
                actions.runAction.run(registry, { environmentId, input, cwds: ["/api", "/web"] }),
              ),
            ),
          ).toBe(true);
          expect(registry.get(actions.stateAtom(target))).toMatchObject({
            isRunning: false,
            result: null,
          });
          expect(requests).toEqual([environmentId, environmentId]);
          expect(cleared).toEqual([environmentId, environmentId]);
          registry.set(
            sessions(environmentId),
            AsyncResult.success({ ...session, permissions: [] }),
          );
          expect(registry.get(actions.runAction.permissionAtom(environmentId, input))).toBe(false);
          expect(
            Exit.isFailure(
              yield* Effect.exit(
                actions.runAction.run(registry, { environmentId, input, cwds: ["/api", "/web"] }),
              ),
            ),
          ).toBe(true);
          expect(requests).toEqual([environmentId, environmentId]);
        } finally {
          unmountSession();
          registry.dispose();
        }
      }),
  );
});
