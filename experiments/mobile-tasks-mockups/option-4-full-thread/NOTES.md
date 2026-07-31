# Option 4 — Task as full thread + parent "Agents" tab — design notes

Two phone views behind one mockup, switched by deep link:

- **`?view=task`** — a task (T1, the finished one) opened as a **normal full thread view**:
  standard stack header with the parent thread as the back target ("‹ Audit Kimi ACP…"), its own
  transcript (prompt, findings, the "Returned to parent" event line), and a fully enabled steer
  composer. This is the honest end state of "Open thread ↗": a task is a real thread, so on
  mobile it is simply a pushable view — no special chrome beyond the subtitle stating provenance
  (`Task · created by the agent · full thread context · Opus 4.7`).
- **`?view=parent&tab=agents`** — the **parent thread with a segmented control under the header
  (Chat / Agents)**. The Agents tab lists W1–W4 **read-only**: each row carries status icon,
  kind chip, a usage line (type · elapsed · tokens · tools · last tool), the retry linkage
  (W3 "Budget exceeded · retried below" ↔ W4 "Retry of the failed run above" — the links scroll
  to each other), and a "Show in transcript" link that jumps back to the Chat tab's workflow
  card. A note at the top states the capability truth in words: inherits the parent's model,
  can't be steered or cancelled, interrupt the turn to stop.

Deep links: `?view=parent|task` and `?tab=chat|agents` (combinable; the wake row's "Open →" in
Chat and the task view's back chevron navigate between views in-page).

- **Optimises for:** using the phone's strongest idiom — the navigation stack — exactly where it
  is honest. Tasks get _more_ capable UI than the desktop peek because a pushed view is free on
  mobile; natives get a structurally separate, read-only tab where the capability difference is
  the architecture itself (no composer exists in that tab, rather than a disabled one). The
  Agents tab is also the only mobile surface with room for full usage stats per worker.
- **Gives up:** peeking. Every inspection is a navigation; there is no way to glance at a
  running task without leaving the parent thread (options 2 and 3 exist precisely to fill that
  hole). The segmented control also splits one conceptual list ("everything this thread is
  doing") across two tabs plus the option-3 card.
- **Strongest objection:** the Agents tab is a graveyard with good typography. Read-only lists
  of things you cannot act on, one level deep behind a tab, are where mobile features go to be
  ignored — and the one action a native _does_ support (show in transcript) bounces the user out
  of the tab entirely, so the tab trains its own abandonment. If the tab is where natives live,
  nobody watches W2 run; if it isn't, it's a duplicate of the workflow card with extra steps.

## Mobile-specific notes

- **Back-target naming.** The task view's back chevron carries the parent's truncated title —
  the only place the parent↔task relationship is visible in this variant. A deep task title +
  deep parent title will collide in that 42%-width slot.
- **Tab + composer.** The composer stays attached to the Chat tab (hidden on Agents, where there
  is nothing to type into). A segmented control that swaps the _whole_ body including the
  composer is the safer build; the mockup hides it with `visibility` to keep the layout stable.
- **Stack depth.** Parent → task → (task's own tasks?) — the desktop design is one level deep;
  on a phone each level is another pushed view, and the back affordance has to disambiguate
  "back to parent thread" from "back to thread list".
- **Live rows in a read-only tab.** W2/W4 keep ticking while the tab is open; a pushed tab page
  that keeps streaming over a relay connection needs the same subscription lifecycle as the
  thread view — it's not a cheap static list.

## Data gaps (mobile-specific)

- **Agent-tab payload.** The tab wants per-worker usage, status, retry linkage and turn
  location for a whole thread at once — a thread-scoped worker rollup (today the client builds
  workers per-turn from the transcript stream, not as a queryable list).
- **Retry reason.** "Budget exceeded · retried below" is assembled from W3's `errorMessage` plus
  `retriedByTaskId`; there is no display-ready linkage label, so the UI must join the two rows.
- **Task thread parity.** The pushed task view assumes the mobile thread screen is
  provider-agnostic enough to host a sub-thread unchanged (composer modes, attachments); any
  mobile-only thread features (voice input, quick actions) need a decision for task threads too.
