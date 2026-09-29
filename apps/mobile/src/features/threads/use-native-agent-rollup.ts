import { useAtomValue } from "@effect/atom-react";
import { deriveNativeAgentRollup } from "@t3tools/client-runtime/state/native-agent-rollup";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useMemo } from "react";

import { environmentThreadDetails } from "../../state/threads";

/** Subscribe to roster inputs, so message deltas do not repaint the rollup. */
export function useNativeAgentRollup(target: ScopedThreadRef) {
  const agents = useAtomValue(
    environmentThreadDetails.threadAtom(target),
    (thread) => thread?.projection.subagents,
  );
  const runs = useAtomValue(
    environmentThreadDetails.threadAtom(target),
    (thread) => thread?.projection.runs,
  );
  return useMemo(
    () => deriveNativeAgentRollup({ subagents: agents ?? [], runs: runs ?? [] }),
    [agents, runs],
  );
}
