# Option 1 — Sidebar parity — design notes

Provider-native subagents appear as rows inside the parent's existing sidebar task group, next to
real thread tasks. Every row in the group is interactive, mirroring the real app's task rows:
**hovering** a row opens a floating peek window anchored to it with a caret (a short dwell before
opening, a grace period so the pointer can travel into the window; Esc or hovering away closes it;
one open at a time). **Clicking** acts instead of peeking: a task row opens its thread (simulated
with a toast — navigation is outside this mockup), a native row locates its run in the
transcript's workflow card. Deep links: `?v=N&peek=t1|t2|w1..w4` opens a row's peek on load.

The peek body is honestly different per kind. A **task row** gets the standard task peek (the
thread-tasks mockup's window, i.e. the app's `MiniThreadWindow`): status line, title, chips
(creator, context, model), prompt excerpt and latest activity, a "Cancel task" action while the
task runs, an enabled "Steer this task…" composer, and "Open thread ↗". A **native row** gets
option 2's honest window in the same frame: chips carry the variant's kind word plus subagentType,
parent turn, and usage (when present); the body shows only what `WorkflowActivityWorker` has —
prompt, the rolling `progressSummary` (W4 has none yet, so it degrades to "No progress updates
yet"), `resultSummary` / `errorMessage`, `lastToolName`, and retry linkage (the W3↔W4 links swap
the peek to the other run). The steer composer is present but disabled with the reason spelled out
("Runs inside the parent session — to stop it, interrupt the parent turn"), and "Open thread ↗"
becomes "Show in transcript", which closes the window and flashes the worker's row in the
transcript's workflow card — the old direct-click jump, now one level deep. All four variants
share both the interaction and the two bodies; they still differ in how the two kinds of work are
grouped and labelled (and the peek header keeps each variant's word for the native kind —
in-session agent / in-session · view only / in-session worker / in-session subagent).

## V1 — Split section

- Optimises for: maximal honesty and scannability. "Tasks" and "In-session agents" are separate
  labelled sub-sections, so the capability difference (steerable thread vs view-only run) is
  structural, not iconographic. The count chip ("2 tasks · 4 in-session") restates the split at the
  parent row. Cheapest possible learn: two labels the user reads once.
- Gives up: vertical space and a single unified list — the group is six rows plus two labels, and
  the two kinds can never be interleaved by recency, so a freshly-finished native sits under a
  long-dead task.
- Strongest objection: it preserves the confusion it claims to fix. The user asked for "parallel
  work"; the sidebar answers with a taxonomy lesson ("did you mean tasks or in-session agents?").
  Two vocabularies in one group invites exactly the wrong question — and a user who never hovers
  a tooltip still can't tell why one row opens a thread and the other just flashes the transcript.

## V2 — Merged, icon-coded

- Optimises for: density and minimal structural change. One flat list ordered by start time; the
  existing group keeps its shape, count chip just reads "6". Kind is a leading icon with a tooltip,
  and the "in-session · view only" tag appears on hover/selection — the honesty is there, but
  pull-to-refresh rather than always-on.
- Gives up: at-a-glance legibility. Bolt vs list-checks at 10px is a subtle signal for a hard
  capability boundary, and the view-only tag is invisible until the user happens to hover.
- Strongest objection: the icon-only coding fails the exact failure mode this option is judged on.
  A row that looks like every other row but secretly can't be opened is how the current confusion
  started; "the tooltip explains it" is doing all the work, and tooltips are where affordance
  honesty goes to die.

## V3 — Turn-grouped

- Optimises for: the sidebar↔transcript mapping as the product. Natives live under a collapsible
  "Turn 4 · 4 workers" header that mirrors the workflow card 1:1, with running/finished/failed
  mini-counts; clicking the header flashes the card itself. It's the only variant where the
  sidebar teaches _when_ the agents ran, not just _that_ they ran.
- Gives up: scalability across turns. One workflow is tidy; three turns of fan-out means three
  collapsible groups stacking under the tasks, each needing an ordinal ("Turn 4") that the data
  doesn't directly provide. Collapsed groups also hide running workers behind a second click.
- Strongest objection: it groups by the wrong axis for the sidebar. "Which turn spawned this" is
  transcript structure, not sidebar structure — the sidebar's job is "what is running right now",
  and a running worker buried in a collapsed, turn-labelled group is easier to lose than the
  buried card we started with.

## V4 — Metrics-forward

- Optimises for: observability. Every row — tasks and natives — shows cost at rest
  (tokens · tools · duration) plus a status-colored time, running first. The bolt badge +
  "in-session" micro-label marks kind without splitting the list. Best variant for "what is this
  audit costing me" without clicking anything.
- Gives up: calm. Two-line rows double the group's height, six usage triples compete for
  attention, and the sidebar starts to feel like a dashboard. Metrics also aren't guaranteed
  (see data gaps), so rows would sometimes degrade to partial triples.
- Strongest objection: it optimises the metric the user didn't ask about. Token counts are
  interesting after the fact; while work is running they mostly add noise and false precision
  ("21.7k tokens · 9 tools _so far_"). The variant answers "what did it cost" better than "what
  can I do with it" — and the second question is the one the sidebar actually has to answer.

## Recommended variant

**V1 — Split section.** Affordance honesty is the stated failure condition, and V1 is the only
variant where the capability difference is structural rather than encoded in an icon, a hover
tag, or a badge — the label _is_ the explanation, visible before any interaction. The peek and
jump-to-card interactions are identical across variants, so V1's cost is only a few pixels of
vertical space,
and its section headers give the eventual implementation a natural place for per-kind empty
states and copy.

## Data gaps (things the design wanted that WorkflowActivityWorker does not provide)

- **Capability flags.** The mockup hard-codes "view only" per kind. The worker model has no field
  saying what a worker _can_ do (steerable? cancellable? openable?), so if a future provider
  exposes a steerable native subagent the UI couldn't distinguish it — honesty would need a
  capability descriptor, not a kind check.
- **Guaranteed usage.** `usage` is optional and every counter inside `TaskUsageSnapshot`
  (`totalTokens`, `toolUses`, `durationMs`) is independently optional. V4's "usage at rest on
  every row" can degrade to partial or missing triples; running workers only show live token
  counts if the provider streams `task.progress` with usage attached.
- **Turn ordinals.** Workers carry an opaque `turnId`; V3's "Turn 4" label requires deriving an
  ordinal from transcript ordering, which the model doesn't store.
- **Cross-kind start ordering.** V2's merged-by-start-time list needs a comparable start instant
  for thread tasks (orchestration thread model) and workers (`startedAt`) — a join the sidebar
  doesn't do today.
- **Retry naming.** `retryOfTaskId` links the runs, but there's no display-ready label explaining
  _why_ the retry happened (the failure reason of the previous run); the mockup's "↺ retry of the
  failed run" hint works only because the failed predecessor is also in the list.
- **Thread-task usage (out of scope of this interface, noted for V4).** Task rows in V4 show
  invented usage numbers (T1: 52.4k · 19 tools · 7m 05s; T2: 24.9k · 11 tools · 3m) — real
  thread tasks would need a usage rollup from their own sessions, which `WorkflowActivityWorker`
  doesn't cover. Everything else for natives (status, description, subagentType, progress/result/
  error summaries, `lastToolName`, retry linkage) maps 1:1 onto existing fields.
