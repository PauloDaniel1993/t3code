import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";
import { useMemo } from "react";
import { getNewThreadTaskUnavailableReason } from "../components/NewThreadTaskDialog.logic";
import { useEnvironment } from "../state/environments";
import { environmentPresentations } from "../state/presentation";
import { environmentThreadDetails } from "../state/threads";
import { EMPTY_SERVER_PROVIDERS } from "../state/server";

/** All entry points share the same writable-parent and environment checks. */
export function useNewThreadTaskAvailability(threadRef: ScopedThreadRef | null) {
  const environmentId = threadRef?.environmentId ?? null;
  const threadId = threadRef?.threadId ?? null;
  const environment = useEnvironment(environmentId);
  const providers = environment?.serverConfig?.providers ?? EMPTY_SERVER_PROVIDERS;
  // Subscribe to the reason alone, so streaming tokens do not repaint the header or palette.
  const problemAtom = useMemo(
    () =>
      Atom.make((get) => {
        if (environmentId === null || threadId === null)
          return "Open an existing thread to request a task.";
        const ref = scopeThreadRef(environmentId, threadId);
        const thread = get(environmentThreadDetails.threadAtom(ref));
        const presentation = get(environmentPresentations.presentationAtom(environmentId));
        return getNewThreadTaskUnavailableReason({
          projection: thread?.projection ?? null,
          status: get(environmentThreadDetails.statusAtom(ref)),
          connected: presentation?.connection.phase === "connected",
          providers: presentation?.serverConfig?.providers ?? EMPTY_SERVER_PROVIDERS,
        });
      }),
    [environmentId, threadId],
  );
  const problem = useAtomValue(problemAtom);
  return { providers, problem };
}
