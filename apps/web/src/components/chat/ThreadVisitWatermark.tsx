import { useAtomMount } from "@effect/atom-react";
import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { createThreadVisitTracker } from "@t3tools/client-runtime/state/thread-visits";
import { type ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { environmentCatalog } from "../../connection/catalog";
import { getDocumentActivity, subscribeDocumentActivity } from "../../lib/documentActivity";
import { useUiStateStore } from "../../uiStateStore";
import { environmentThreadShells, threadEnvironment } from "../../state/threads";

const visitShellAtom = Atom.family((key: string) =>
  Atom.make((get) => {
    const ref = parseScopedThreadKey(key);
    const shell = ref === null ? null : get(environmentThreadShells.threadShellAtom(ref));
    const deliveredAt = shell?.source?.latestTaskDeliveredAt;
    return shell && deliveredAt && Date.parse(deliveredAt) > Date.parse(shell.updatedAt)
      ? { ...shell, updatedAt: deliveredAt }
      : shell;
  }),
);

const isDocumentViewed = () => {
  const activity = getDocumentActivity();
  return activity.visible && activity.focused;
};

const documentViewedAtom = Atom.make((get) => {
  get.addFinalizer(subscribeDocumentActivity(() => get.setSelf(isDocumentViewed())));
  return isDocumentViewed();
}).pipe(Atom.withLabel("document-viewed"));

const threadVisitTracker = createThreadVisitTracker({
  threadShellAtom: (ref) => visitShellAtom(scopedThreadKey(ref)),
  sessionGenerationAtom: environmentCatalog.sessionGenerationAtom,
  visit: threadEnvironment.visit,
  markLocalVisit: (ref, visitedAt) =>
    useUiStateStore.getState().markThreadVisited(scopedThreadKey(ref), visitedAt),
  viewingAtom: documentViewedAtom,
});

// The visit watermark is the one part of the chat view that follows the
// shell's updatedAt, which ticks while a run streams. The tracker subscribes to
// it outside React, so ChatView keeps reading the quiet shell.
export function ThreadVisitWatermark(props: { readonly threadRef: ScopedThreadRef }) {
  useAtomMount(threadVisitTracker(props.threadRef));
  return null;
}
