import { useAtomValue } from "@effect/atom-react";
import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { getNewThreadTaskUnavailableReason } from "../components/NewThreadTaskDialog.logic";
import { environmentPresentations } from "../state/presentation";
import { environmentThreadDetails } from "../state/threads";
import { useEnvironmentScope } from "../state/session";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../state/server";

const parentAtom = Atom.family((key: string) =>
  Atom.make((get) => {
    const ref = parseScopedThreadKey(key);
    return ref === null
      ? null
      : (get(environmentThreadDetails.threadAtom(ref))?.projection.thread ?? null);
  }),
);
const providersAtom = Atom.family((environmentId: EnvironmentId | null) =>
  Atom.make((get) =>
    environmentId === null
      ? EMPTY_SERVER_PROVIDERS
      : (get(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS),
  ),
);
const problemAtom = Atom.family((key: string | null) =>
  Atom.make((get) => {
    const ref = key === null ? null : parseScopedThreadKey(key);
    if (ref === null) return "Open an existing thread to request a task.";
    const thread = get(environmentThreadDetails.threadAtom(ref));
    const presentation = get(environmentPresentations.presentationAtom(ref.environmentId));
    return getNewThreadTaskUnavailableReason({
      projection: thread?.projection ?? null,
      status: get(environmentThreadDetails.statusAtom(ref)),
      connected: presentation?.connection.phase === "connected",
      providers: get(providersAtom(ref.environmentId)),
    });
  }),
);

/** Mounts only the requested parent stream and ignores updates to its conversation entities. */
export function useNewThreadTaskParent(threadRef: ScopedThreadRef) {
  return useAtomValue(parentAtom(scopedThreadKey(threadRef)));
}

/** All entry points share the same writable-parent and environment checks. */
export function useNewThreadTaskAvailability(threadRef: ScopedThreadRef | null) {
  const environmentId = threadRef?.environmentId ?? null;
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const providers = useAtomValue(providersAtom(environmentId));
  // Subscribe to the reason alone, so streaming tokens do not repaint the header or palette.
  const problem = useAtomValue(problemAtom(threadRef === null ? null : scopedThreadKey(threadRef)));
  return {
    providers,
    problem: problem ?? (canOperate ? null : "This connection cannot change threads."),
  };
}
