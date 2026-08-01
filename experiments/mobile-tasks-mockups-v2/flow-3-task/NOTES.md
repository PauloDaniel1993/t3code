# Flow 3 — Full task view — design notes

One pushed screen — the task as a real thread — carried forward from the TASK half of v1's
option 4 (the Agents tab half is not carried). Reconciliation extended the page to model **all
four scenario tasks** behind `?task=` (`_reports/T7.md` item B — v2's flow emits four "Open
thread" links, so one hardcoded task view would have made three of them land on the wrong
task); the mockups task alone keeps three lifecycle states behind deep links:

- **`?state=running`** (default) — v1 option 4's task view one-for-one: provenance event row,
  the prompt, the fan-out plan, the turn's agent card inline in the transcript (all ten agents;
  the four failures each carry their reason in words), the "six back, four retrying" update, a
  live Working row, and the enabled steer composer.
- **`?state=complete`** — the same thread after the retries: the failure record stands
  (✓ 6 / × 4, reasons intact — completing a task does not launder its failures), the result
  returns to the parent (`.evt.wake` — "Returned to the parent · woke …"), and the composer
  stays enabled: v1 showed a finished task with a fully enabled steer composer, and the model
  says task threads are durable.
- **`?state=failed`** — the retry turn exhausts the budget too: the task stops, the reason is
  stated in a full sentence (`.evt.failed`), the composer is disabled **with the reason in
  words**, and the one offered action is Retry task.

Deep links:

- `?task=task|apk|local|login` (default `task`) — which of the four modelled task views
  renders: the mockups task, the APK task (done · 19m, turn of 3 with one reasoned failure),
  the local-build question (done · 59s, created by you, no agents ran), or the login task
  (working · 24s, created by you). Unknown values fall back to the mockups task.
- `?view=task` (default). `?view=parent` does **not** render a parent view — v2 builds no
  parent-thread page — it redirects to `../flow-1-list/index.html?peek=<current task>`, the
  surface where the parent↔task relationship actually lives. The declared v1 param is kept so
  the two sets navigate the same way; unknown values fall back to the task view.
- `?state=running|complete|failed`. These tails exist only on the mockups task; for the other
  three tasks the param is inert (each has one canonical state). Unknown values (`queued`,
  `cancelled`, …) are state-matrix's cardinalities and fall back to `running`.
- `?theme=dark|light` (shared convention; preserved across every internal link and the
  redirect).

- **Optimises for:** the honest end of the flow. "Open thread" from the peek sheet lands on a
  screen that owes nothing: own header with the lifecycle state and a back target, provenance,
  the full transcript, the turn's agents with per-agent outcomes, and a composer whose
  availability is always explained in words. It is also the only screen in the set that shows
  all ten agents with their failure reasons at full width — no sheet detent, no tab.
- **Gives up:** peeking, still — every inspection is a navigation (v1 option 4's own trade,
  inherited). And without the parent view next door (v1 option 4 shipped both views in one
  page), the back chevron's "parent thread" is only implied: v2's back target is the sheet you
  came from, not the parent's transcript.
- **Strongest objection:** three screens now restate the same turn — the list's "✓ 6 × 4"
  sub-row, the sheet's agent block, and this page's agent card must never disagree, and this
  page is the one a reviewer will hold the other two against. There is also a model ambiguity
  the mockup had to settle by fiat: whether a completed or failed task accepts new messages
  (here: complete yes, failed no — retry instead). Reasonable people could flip either; the
  contracts don't say.

## Mobile-specific notes

- **Back-target naming.** v1's task view named the parent thread on the back chevron ("Back to
  Add Wayfinder Constellation…"). v2 has no parent page to name; the chevron goes to the
  current task's sheet (`../flow-2-peek/index.html?sheet=<id>`) and the provenance row offers
  "See in list →" (`../flow-1-list/index.html?peek=<id>`). When a real parent-thread screen
  exists, the chevron should name it again.
- **Stack depth.** Parent → task is one push; the failed state's Retry starts a new turn in
  place rather than pushing anything — the phone's stack stays flat.
- **Live row.** The running state ends in a spinner row; over a relay connection this view
  needs the same subscription lifecycle as any thread view — v1 option 4's note for the Agents
  tab applies here unchanged.
- **Composer per state.** The placeholder carries the state's truth: "Steer this task…" while
  running, "Message this task…" once done, and a disabled composer with the reason in words
  once failed. One composer, three honest faces — never a greyed-out control with no
  explanation.

## Data gaps (mobile-specific)

- **Task-level lifecycle.** The header state word (Working / Done / Failed) and the failed
  state's terminal reason ("the retry turn exhausted its tool-use budget…") need a task-scoped
  status and reason; today outcomes are per-turn agent records, not a task rollup.
- **Return/wake event.** The `.evt.wake` row ("Returned to the parent — woke …") needs the
  durable wake event v1 already flagged — there is no user-visible flag today.
- **Retry semantics.** Whether Retry reuses the brief, the failed agents' partial state, or a
  fresh turn is a contract decision the mockup cannot see.
- **Follow-up on a returned task.** The complete state's enabled composer asserts that messaging
  a returned task starts a new turn (and re-wakes the parent). That behavior is inferred from
  "durable, steerable sub-thread", not from any contract.
