import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  OrchestrationV2ThreadWorktree,
  VcsStatusResult,
} from "@t3tools/contracts";
import { workspaceBranchState } from "@t3tools/client-runtime/state/vcs";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useMemo } from "react";
import { useRetainedValue } from "../components/Sidebar.logic";
import { vcsEnvironment } from "./vcs";

/** All checkout queries are shared atoms; the panel owns only their leases. */
export function useWorkspaceStatuses(
  environmentId: EnvironmentId,
  cwds: ReadonlyArray<string | null>,
) {
  const key = JSON.stringify(cwds);
  const atom = useMemo(() => {
    const paths = JSON.parse(key) as Array<string | null>;
    return Atom.make((get) =>
      paths.map((cwd) =>
        cwd === null ? null : get(vcsEnvironment.status({ environmentId, input: { cwd } })),
      ),
    );
  }, [environmentId, key]);
  return useAtomValue(atom).map((value) => ({
    status: value === null ? null : Option.getOrNull(AsyncResult.value(value)),
    error: value?._tag === "Failure",
  }));
}

/** Only shell members are needed; no thread detail or project folder subscriptions. */
export function useSidebarBranchAgreement(
  environmentId: EnvironmentId,
  members: ReadonlyArray<OrchestrationV2ThreadWorktree> | undefined,
  primary: VcsStatusResult | null,
  lease: boolean,
) {
  const key = JSON.stringify(members ?? []);
  const atom = useMemo(() => {
    const tuple = JSON.parse(key) as Array<OrchestrationV2ThreadWorktree>;
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
  }, [environmentId, key, lease]);
  const secondary = useAtomValue(atom);
  const state =
    members && members.length >= 2 && secondary.length === members.length - 1
      ? workspaceBranchState(
          members.map((member) => ({ expectedBranch: member.branch })),
          [primary, ...secondary],
        )
      : null;
  return useRetainedValue(JSON.stringify([environmentId, key]), state?.complete ? state : null);
}
