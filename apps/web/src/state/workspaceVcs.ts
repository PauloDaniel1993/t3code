import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, OrchestrationV2ThreadWorktree } from "@t3tools/contracts";
import { workspaceBranchState, type VcsBranchStatus } from "@t3tools/client-runtime/state/vcs";
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

const branchAgreementAtom = Atom.family((key: string) => {
  const [environmentId, tuple, primary, lease] = JSON.parse(key) as [
    EnvironmentId,
    Array<OrchestrationV2ThreadWorktree>,
    VcsBranchStatus | null,
    boolean,
  ];
  return Atom.make((get) => {
    if (!lease || tuple.length < 2) return null;
    const secondary = tuple
      .slice(1)
      .map((member) =>
        Option.getOrNull(
          AsyncResult.value(
            get(vcsEnvironment.branchStatus({ environmentId, input: { cwd: member.path } })),
          ),
        ),
      );
    return workspaceBranchState(
      tuple.map((member) => ({ expectedBranch: member.branch })),
      [primary, ...secondary],
    );
  });
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
  primary: VcsBranchStatus | null,
  lease: boolean,
) {
  const key = JSON.stringify(members ?? []);
  const state = useAtomValue(
    branchAgreementAtom(JSON.stringify([environmentId, members ?? [], primary, lease])),
  );
  return useRetainedValue(JSON.stringify([environmentId, key]), state?.complete ? state : null);
}
