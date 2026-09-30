import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import type { OrchestrationV2ThreadProjection, ScopedThreadRef } from "@t3tools/contracts";
import {
  retainKnownRuns,
  retainKnownSubagents,
} from "@t3tools/client-runtime/state/subagent-retention";
import { Atom } from "effect/unstable/reactivity";
import { useEffect } from "react";
import { create } from "zustand";
import { environmentThreadDetails } from "../state/threads";

type Presentation = Pick<OrchestrationV2ThreadProjection, "runs" | "subagents">;
const EMPTY_PRESENTATION: Presentation = { runs: Object.freeze([]), subagents: Object.freeze([]) };

/** A bounded reconnect can omit old records; absence is not a task deletion. */
export function mergeSidebarTaskPresentation(
  previous: Presentation,
  incoming: Presentation,
): Presentation {
  const subagents = retainKnownSubagents(previous.subagents, incoming.subagents);
  const nextRuns = retainKnownRuns(previous.runs, incoming.runs);
  if (
    subagents.length === previous.subagents.length &&
    subagents.every((agent, index) => agent === previous.subagents[index]) &&
    nextRuns.length === previous.runs.length &&
    nextRuns.every((run, index) => run === previous.runs[index])
  )
    return previous;
  return { subagents, runs: nextRuns };
}

// Keep the `use` prefix: the React Compiler memoizes calls to anything else, which
// skips the store's hooks on later renders and breaks the caller's hook order.
export const useSidebarTaskPresentationStore = create<{
  byParent: ReadonlyMap<string, Presentation>;
  remember: (key: string, presentation: Presentation) => void;
}>((set) => ({
  byParent: new Map(),
  remember: (key, presentation) =>
    set((state) => {
      const old = state.byParent.get(key) ?? EMPTY_PRESENTATION;
      const next = mergeSidebarTaskPresentation(old, presentation);
      return next === old ? state : { byParent: new Map(state.byParent).set(key, next) };
    }),
}));

export function useKnownSidebarTaskPresentation(ref: ScopedThreadRef) {
  const key = scopedThreadKey(ref);
  return useSidebarTaskPresentationStore((state) => state.byParent.get(key) ?? EMPTY_PRESENTATION);
}

export function createSidebarTaskProjectionAtom(
  source: Atom.Atom<{ projection: Presentation } | null>,
) {
  let previous: Presentation | null = null;
  return Atom.make((get) => {
    const projection = get(source)?.projection;
    if (projection === undefined) return null;
    if (previous?.runs === projection.runs && previous.subagents === projection.subagents)
      return previous;
    previous = { runs: projection.runs, subagents: projection.subagents };
    return previous;
  }).pipe(Atom.setIdleTTL(0));
}
const projectionSliceAtom = Atom.family((key: string) => {
  const ref = parseScopedThreadKey(key);
  return ref === null
    ? emptyAtom
    : createSidebarTaskProjectionAtom(environmentThreadDetails.threadAtom(ref));
});
const emptyAtom = Atom.make<Presentation | null>(null);

/** Call only for an expanded visible group or an already-open chat/peek. */
export function useSidebarTaskProjection(ref: ScopedThreadRef | null) {
  return useAtomValue(ref === null ? emptyAtom : projectionSliceAtom(scopedThreadKey(ref)));
}

export function useRememberSidebarTaskPresentation(
  ref: ScopedThreadRef | null,
  presentation: Presentation | null,
) {
  const key = ref === null ? null : scopedThreadKey(ref);
  useEffect(() => {
    if (key !== null && presentation !== null)
      useSidebarTaskPresentationStore.getState().remember(key, presentation);
  }, [key, presentation]);
}
