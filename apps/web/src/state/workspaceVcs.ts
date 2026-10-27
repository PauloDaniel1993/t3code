import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  OrchestrationV2ThreadWorktree,
  VcsStatusResult,
} from "@t3tools/contracts";
import { workspaceBranchState } from "@t3tools/client-runtime/state/vcs";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useRetainedValue } from "../components/Sidebar.logic";
import { vcsEnvironment } from "./vcs";

const workspaceStatusesAtom = Atom.family((key: string) => {
  const [environmentId, paths] = JSON.parse(key) as [EnvironmentId, Array<string | null>];
  return Atom.make((get) =>
    paths.map((cwd) =>
      cwd === null ? null : get(vcsEnvironment.status({ environmentId, input: { cwd } })),
    ),
  );
});

const secondaryStatusesAtom = Atom.family((key: string) => {
  const [environmentId, tuple, lease] = JSON.parse(key) as [
    EnvironmentId,
    Array<OrchestrationV2ThreadWorktree>,
    boolean,
  ];
  return Atom.make((get) =>
    !lease || tuple.length < 2
      ? []
      : tuple
          .slice(1)
          .map((member) =>
            Option.getOrNull(
              AsyncResult.value(
                get(vcsEnvironment.branchStatus({ environmentId, input: { cwd: member.path } })),
              ),
            ),
          ),
  );
});

/** All checkout queries are shared atoms; the panel owns only their leases. */
export function useWorkspaceStatuses(
  environmentId: EnvironmentId,
  cwds: ReadonlyArray<string | null>,
) {
  return useAtomValue(workspaceStatusesAtom(JSON.stringify([environmentId, cwds]))).map(
    (value) => ({
      status: value === null ? null : Option.getOrNull(AsyncResult.value(value)),
      error: value?._tag === "Failure",
    }),
  );
}

/** Only shell members are needed; no thread detail or project folder subscriptions. */
export function useSidebarBranchAgreement(
  environmentId: EnvironmentId,
  members: ReadonlyArray<OrchestrationV2ThreadWorktree> | undefined,
  primary: VcsStatusResult | null,
  lease: boolean,
) {
  const key = JSON.stringify(members ?? []);
  const secondary = useAtomValue(
    secondaryStatusesAtom(JSON.stringify([environmentId, members ?? [], lease])),
  );
  const tuple = JSON.parse(key) as Array<OrchestrationV2ThreadWorktree>;
  const state =
    tuple.length >= 2 && secondary.length === tuple.length - 1
      ? workspaceBranchState(
          tuple.map((member) => ({ expectedBranch: member.branch })),
          [primary, ...secondary],
        )
      : null;
  return useRetainedValue(JSON.stringify([environmentId, key]), state?.complete ? state : null);
}
