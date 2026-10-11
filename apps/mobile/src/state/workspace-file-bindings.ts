import { useAtomValue } from "@effect/atom-react";
import {
  request,
  type EnvironmentRpcInput,
  type EnvironmentUnaryRpcTag,
} from "@t3tools/client-runtime/rpc";
import { createEnvironmentQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  WorkspaceScope,
  OrchestrationProjectShell,
  OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { environmentSnapshotAtom } from "./shell";

/** Thread bindings freeze folders; draft bindings follow the project's current folder table. */
export function workspaceFileBindingKey(
  scope: WorkspaceScope,
  project: Pick<
    OrchestrationProjectShell,
    "workspaceRoot" | "workspaceFile" | "folders" | "workspaceFileStatus"
  > | null,
  thread: Pick<
    OrchestrationV2ThreadShell,
    "worktreePath" | "branch" | "worktrees" | "workspacePrimaryPath" | "workspaceFolderCount"
  > | null,
) {
  return JSON.stringify(
    scope.threadId === undefined
      ? [
          project?.workspaceRoot,
          project?.workspaceFile,
          project?.folders,
          project?.workspaceFileStatus?.state,
        ]
      : [
          thread?.worktreePath,
          thread?.branch,
          thread?.worktrees,
          thread?.workspacePrimaryPath,
          thread?.workspaceFolderCount,
        ],
  );
}

const bindingFamily = Atom.family((key: string) => {
  const [environmentId, scope] = JSON.parse(key) as [EnvironmentId, WorkspaceScope];
  return Atom.make((get) => {
    const snapshot = get(environmentSnapshotAtom(environmentId));
    return workspaceFileBindingKey(
      scope,
      snapshot?.projects.find((project) => project.id === scope.projectId) ?? null,
      snapshot?.threads.find((thread) => thread.id === scope.threadId) ?? null,
    );
  });
});
const EMPTY_BINDING = Atom.make("");

export function workspaceFileBindingAtom(
  environmentId: EnvironmentId | null,
  scope: WorkspaceScope | null,
) {
  return environmentId === null || scope === null
    ? EMPTY_BINDING
    : bindingFamily(
        JSON.stringify([environmentId, { projectId: scope.projectId, threadId: scope.threadId }]),
      );
}

export function useWorkspaceFileBindingKey(
  environmentId: EnvironmentId | null,
  scope: WorkspaceScope | null,
) {
  return useAtomValue(workspaceFileBindingAtom(environmentId, scope));
}

/** A new binding selects a fresh query, rather than retaining the previous binding's SWR value. */
export function switchWorkspaceFileQuery<A>(
  binding: Atom.Atom<string>,
  query: (bindingKey: string) => Atom.Atom<A>,
) {
  let selected: Atom.Atom<A> | undefined;
  return Atom.readable(
    (get) => {
      selected = query(get(binding));
      return get(selected);
    },
    (refresh) => {
      if (selected) refresh(selected);
    },
  );
}

export function createWorkspaceFileQuery<TTag extends EnvironmentUnaryRpcTag>(options: {
  readonly tag: TTag;
  readonly label: string;
  readonly staleTimeMs: number;
  readonly idleTtlMs?: number;
  readonly refreshIntervalMs?: number;
}) {
  const query = createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
    ...options,
    execute: (input: {
      readonly request: EnvironmentRpcInput<TTag>;
      readonly bindingKey: string;
    }) => request(options.tag, input.request),
  });
  const family = Atom.family((key: string) => {
    const [target, scope] = JSON.parse(key) as [
      { environmentId: EnvironmentId; input: EnvironmentRpcInput<TTag> },
      WorkspaceScope,
    ];
    return switchWorkspaceFileQuery(
      workspaceFileBindingAtom(target.environmentId, scope),
      (bindingKey) =>
        query({
          environmentId: target.environmentId,
          input: { request: target.input, bindingKey },
        }),
    ).pipe(Atom.setIdleTTL(options.idleTtlMs ?? 5 * 60_000));
  });
  return (
    target: { readonly environmentId: EnvironmentId; readonly input: EnvironmentRpcInput<TTag> },
    scope: WorkspaceScope,
  ) => family(JSON.stringify([target, scope]));
}
