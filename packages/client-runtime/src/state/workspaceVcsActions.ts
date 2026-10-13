import { consumeWorkspaceActionProgress, workspaceActionOutcomeText } from "./workspaceVcs.ts";
import {
  type EnvironmentId,
  type ThreadId,
  type VcsRunWorkspaceActionInput,
  type VcsRunWorkspaceActionResult,
  type VcsWorkspaceActionProgressEvent,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import * as Persistence from "../platform/persistence.ts";
import { runStreamGuarded, RpcPermissionGuard } from "../rpc/client.ts";
import { createCommandPermissions } from "./commandPermissions.ts";
import {
  createEnvironmentRpcCommand,
  createRuntimeCommand,
  runStreamInEnvironment,
  type AtomCommand,
} from "./runtime.ts";
import { scheduleWorkspaceVcsCommand } from "./vcsCommandScheduler.ts";
import { invalidateCachedVcsRefs } from "./vcsRefInvalidation.ts";

export function workspaceActionOutcomeSummary(result: VcsRunWorkspaceActionResult) {
  return result.results
    .map((member) => `${member.label}: ${workspaceActionOutcomeText(member)}`)
    .join("\n");
}

/** Hold existing checkout command lanes in a stable order for a batch. */
function withCheckoutLanes<W extends { readonly environmentId: EnvironmentId }, A, E>(
  command: AtomCommand<W, A, E>,
): AtomCommand<W & { readonly cwds: ReadonlyArray<string> }, A, E> {
  return {
    label: command.label,
    run: (registry, target) =>
      Effect.runPromise(
        scheduleWorkspaceVcsCommand(
          registry,
          target.environmentId,
          target.cwds,
          Effect.promise(() => command.run(registry, target)),
        ),
      ),
  };
}

export function createWorkspaceVcsAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Persistence.EnvironmentCacheStore | R, E>,
) {
  const branchPermissions = createCommandPermissions(
    runtime,
    WS_METHODS.vcsSwitchWorktreeSetBranch,
  );
  const actionPermissions = createCommandPermissions(runtime, WS_METHODS.vcsRunWorkspaceAction);
  type Target = {
    readonly environmentId: EnvironmentId;
    readonly input: VcsRunWorkspaceActionInput;
    readonly onProgress?: (event: VcsWorkspaceActionProgressEvent) => void;
  };
  const state = Atom.family((key: string) =>
    Atom.make<{
      readonly isRunning: boolean;
      readonly currentLabel: string | null;
      readonly result: VcsRunWorkspaceActionResult | null;
    }>({ isRunning: false, currentLabel: null, result: null }).pipe(
      Atom.keepAlive,
      Atom.withLabel(`vcs-action:workspace:${key}`),
    ),
  );
  const stateAtom = (target: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
  }) => state(JSON.stringify([target.environmentId, target.threadId]));
  return {
    stateAtom,
    switchBranch: {
      ...withCheckoutLanes(
        createEnvironmentRpcCommand(runtime, {
          label: "vcs-action:workspace-switch-branch",
          tag: WS_METHODS.vcsSwitchWorktreeSetBranch,
          onSettled: (target, registry) =>
            invalidateCachedVcsRefs(registry, {
              environmentId: target.environmentId,
              cwd: `thread:${target.input.threadId}`,
            }),
        }),
      ),
      requiredScopes: branchPermissions.requiredScopes,
      permissionAtom: branchPermissions.permissionAtom,
    },
    runAction: {
      ...withCheckoutLanes(
        createRuntimeCommand<
          EnvironmentRegistry | Persistence.EnvironmentCacheStore | R,
          E,
          Target,
          VcsRunWorkspaceActionResult,
          unknown
        >(runtime, {
          label: "vcs-action:workspace",
          concurrency: {
            mode: "serial",
            key: (target) => JSON.stringify([target.environmentId, target.input.threadId]),
          },
          execute: (target: Target, registry) =>
            Effect.gen(function* () {
              yield* actionPermissions.authorize(registry, target.environmentId, target.input);
              const atom = stateAtom({
                environmentId: target.environmentId,
                threadId: target.input.threadId,
              });
              registry.set(atom, {
                isRunning: true,
                currentLabel: "Starting workspace action…",
                result: null,
              });
              return yield* consumeWorkspaceActionProgress(
                runStreamInEnvironment(
                  target.environmentId,
                  runStreamGuarded(WS_METHODS.vcsRunWorkspaceAction, target.input),
                ),
                target.input.actionId,
                (event) => {
                  if (event.kind === "phase_started")
                    registry.update(atom, (value) => ({
                      ...value,
                      currentLabel: `${event.cwd}: ${event.label}`,
                    }));
                  target.onProgress?.(event);
                },
              ).pipe(
                Effect.provideService(RpcPermissionGuard, {
                  authorize: (id, method, payload) =>
                    createCommandPermissions(runtime, method).authorize(registry, id, payload),
                }),
                Effect.tap((result) =>
                  Effect.sync(() => registry.update(atom, (value) => ({ ...value, result }))),
                ),
                // A disconnected stream can follow a successful mutation. Clear refs on every outcome.
                Effect.ensuring(
                  invalidateCachedVcsRefs(registry, {
                    environmentId: target.environmentId,
                    cwd: `thread:${target.input.threadId}`,
                  }),
                ),
                Effect.ensuring(
                  Effect.sync(() =>
                    registry.update(atom, (value) => ({
                      ...value,
                      isRunning: false,
                      currentLabel: null,
                    })),
                  ),
                ),
              );
            }),
        }),
      ),
      requiredScopes: actionPermissions.requiredScopes,
      permissionAtom: actionPermissions.permissionAtom,
    },
  };
}
