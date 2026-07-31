# Subagent views — mockups

Static HTML mockups exploring how provider-native subagents (Claude Code's Task tool and
equivalents) could surface in T3 Code alongside **thread tasks**. Companion to
`../thread-tasks-mockups/` (the accepted thread-tasks design); reuses its app chrome and dark
theme tokens via a shared `mockup.css`.

**The problem.** A parent thread can fan out work two ways:

- **Thread tasks** — real T3 threads: own provider session (~400 MB process), own transcript, own
  model, durable. Steerable, cancellable, openable. Sidebar rows + mini thread window.
- **Provider-native subagents** — run _inside_ the parent's session on the same session id. T3
  receives `task.started` / `task.progress` / `task.completed` events, but they **cannot be
  steered, cannot be cancelled independently** (only by interrupting the parent turn), have no
  model of their own, are not durable, and their result already goes back to the parent agent
  automatically. Today they render only as a workflow card in the transcript at the turn where
  they ran.

Same user intent ("go wide on this"), two unrelated surfaces. These mockups test three ways to
integrate them, four variants each — twelve in total.

## Viewing

Open `index.html` directly in a browser (works over `file://`, no server, no build). Each option
page takes `?v=1..4` to deep-link a variant; option 1 also takes `&peek=t1|t2|w1..w4` to open a
sidebar row's peek window, and option 2 also takes `&w=w1..w4` to pick which worker the window is
open on (`w2` running, `w3` failed are the interesting non-defaults).

## Files

- `index.html` — landing page linking all twelve variants.
- `mockup.css` — shared stylesheet: the thread-tasks mockup base plus subagent-view additions
  (workflow card, native/mirror chips, jump-highlight, lock banner, usage stats, failed states).
- `option-1-sidebar/` — sidebar parity mockup + `NOTES.md`.
- `option-2-mini-window/` — mini-window parity mockup + `NOTES.md`.
- `option-3-mirror-threads/` — mirror threads mockup + `NOTES.md`.

## Shared scenario

Parent thread **"Audit Kimi ACP Integration Gaps"** (project `t3code`, branch `dev`, Claude Code /
Opus 4.7) with six parallel units: two real thread tasks (T1 finished and woke the parent, T2
running) and four native subagents from one turn (W1 `Explore` finished, W2 `general-purpose`
running, W3 `Explore` failed on a tool-use budget, W4 `Explore` retrying W3). Token/tool/duration
figures are realistic for the subagent types shown.

The two constraints every variant had to answer: **affordance honesty** (a native subagent must
never look steerable/cancellable when it isn't) and **naming** ("task" is already overloaded; the
codebase calls the native kind "worker" internally). Variants deliberately try different
vocabularies — _in-session agents_, _workers_, _subagents_, _mirrors_ — so the words can be judged
visually.

---

## Option 1 — Sidebar parity

Native subagents appear as rows inside the parent's sidebar task group. Every row in the group is
live, mirroring the real app's task rows: hovering opens a peek window anchored to the row with a
caret (short dwell to open, grace period to travel into the window, Esc or hover-away to close;
one at a time; deep link `&peek=t1|t2|w1..w4`). Clicking acts: a task row opens its thread, a
native row locates its run in the transcript. The peek body is honestly different per kind. A **task row** gets the
standard task peek (the thread-tasks window): status, title, chips (creator, context, model),
prompt/timeline, "Cancel task", an enabled steer composer, and "Open thread ↗". A **native row**
gets option 2's honest window in the same frame: chips carry kind, subagentType, parent turn, and
usage; the body is limited to what `WorkflowActivityWorker` has (prompt, rolling progress or
result/error summary, last tool, retry links); the steer composer is disabled with the reason
spelled out; and "Open thread ↗" becomes "Show in transcript" — the old jump-and-flash, now one
level deep. The peek header keeps each variant's word for the native kind.

**1A — Split section.** Two labelled sub-sections, "Tasks" and "In-session agents".

- Optimises for: honesty and scannability — the capability difference is structural (labels), not
  encoded in icons; the count chip restates the split ("2 tasks · 4 in-session").
- Gives up: vertical space and a unified list — the kinds can never interleave by recency.
- Strongest objection: it preserves the confusion it claims to fix — the user asked for "parallel
  work" and the sidebar answers with a taxonomy lesson; a user who never hovers still can't tell
  why one row opens a thread and the other just flashes the transcript.

**1B — Merged, icon-coded.** One flat start-time-ordered list; kind is a leading icon + tooltip,
"in-session · view only" tag on hover.

- Optimises for: density and minimal structural change — the group keeps its shape, chip reads "6".
- Gives up: at-a-glance legibility — bolt vs list glyph at 10px is a subtle signal for a hard
  capability boundary.
- Strongest objection: fails the exact failure mode this option is judged on — a row that looks
  like every other row but secretly can't be opened is how the current confusion started; "the
  tooltip explains it" is where affordance honesty goes to die.

**1C — Turn-grouped.** Natives under a collapsible "Turn 4 · 4 workers" header mirroring the
workflow card 1:1, with running/finished/failed mini-counts.

- Optimises for: the sidebar↔transcript mapping as the product — the only variant that teaches
  _when_ agents ran, not just _that_ they ran.
- Gives up: scalability — three fan-out turns means three stacked collapsible groups, each needing
  a turn ordinal the data doesn't provide; collapsed groups hide running workers.
- Strongest objection: groups by the wrong axis — "which turn spawned this" is transcript
  structure; the sidebar's job is "what is running right now", and a running worker buried in a
  collapsed turn group is easier to lose than the buried card we started with.

**1D — Metrics-forward.** Merged running-first list, tokens · tools · duration at rest on every
row, bolt badge + "in-session" micro-label on natives.

- Optimises for: observability — "what is this audit costing me" without clicking anything.
- Gives up: calm — two-line rows double the group's height; usage isn't guaranteed, so rows can
  degrade to partial triples.
- Strongest objection: optimises the metric the user didn't ask about — live token counts are
  noise and false precision while work runs; the sidebar's real question is "what can I do with
  it", which metrics don't answer.

## Option 2 — Mini-window parity

The existing task peek window opens on a native subagent, launched by clicking a worker row in the
transcript's workflow card. "Open thread ↗" becomes "Show in transcript".

**2A — Same anatomy, honest composer.** Pixel-faithful to the task mini window; composer present
but disabled with the reason in words ("Runs inside the parent session — to stop it, interrupt the
parent turn").

- Optimises for: learnability — one window anatomy for both kinds of parallel work; zero new UI
  vocabulary.
- Gives up: live-ness — a single "latest activity" line is all the anatomy fits; watching a
  running worker is strictly better in 2D.
- Strongest objection: a permanently disabled composer is a tease — it keeps the _shape_ of an
  affordance the object can never support, and reusing the task window risks implying task
  properties (durability, openable) that natives don't have.

**2B — Receipt card.** No composer at all; "AGENT RECEIPT" with stat cells, labelled result (or
red failure) block, copy button, and the full-output file path.

- Optimises for: trust — honesty by subtraction; nothing that could be misread as control.
- Gives up: any sense of process — weakest exactly while a worker is running ("receipt for work
  still happening").
- Strongest objection: dead-ends the user — a failed run shown as a red receipt with no recovery
  action pushes the user back to the transcript; and "Copy result" copies a one-paragraph summary,
  not the real output, which lives in a file most users won't open.

**2C — Peek → promote.** 2A's anatomy plus a primary "Promote to task thread" button — copy makes
clear it is a _re-run_ with its own session, not an adoption.

- Optimises for: the recovery workflow — the agent went wide in-session, but this unit of work
  deserves a real, steerable sub-thread.
- Gives up: honesty-by-simplicity — the only variant that adds a capability instead of describing
  one.
- Strongest objection: sells a feature that does not exist — re-running a prompt is not the same
  computation (fresh context, nondeterministic), and it quietly encourages turning lightweight
  in-session work into heavyweight ~400 MB threads.

**2D — Live ticker.** Running-worker monitor: ticking elapsed readout, timestamped progress beats,
pulsing "Last: Grep" chip; finished workers collapse to a summary.

- Optimises for: the moment of watching — the window as monitor first, receipt second.
- Gives up: the recovery/action surface entirely.
- Strongest objection: a monitor for a process you cannot control is anxiety TV — and the data
  cannot feed it today (`progressSummary` is one rolling string; the beat log is fiction unless
  the server retains every `task.progress` event).

## Option 3 — Mirror threads

Each native subagent becomes a read-only thread: real sidebar row, normal navigation, a thread
view of whatever the provider streamed — permanently read-only.

**3A — Locked chrome.** Full task-thread chrome; composer replaced by a lock banner stating the
read-only truth in words.

- Optimises for: first-class citizenship — if you know a task thread view, you know this.
- Gives up: any honesty about partial data — the timeline presents a best-effort replay as a clean
  transcript.
- Strongest objection: the chrome does the opposite of the banner — everything says "normal
  thread", banner blindness is real, and the most credible-looking variant is therefore the most
  dishonest one.

**3B — Ghost rows.** Sidebar mirrors dimmed and italicised with a `mirror` chip; thread view drops
the composer zone entirely; one-line provenance note under the topbar.

- Optimises for: glance-level separation — mirrors can never be mistaken for tasks; calmest,
  cheapest sidebar.
- Gives up: discoverability and emphasis — ghosting undersells finished work that may be the
  turn's most valuable output.
- Strongest objection: honesty carried entirely by styling is honesty carried weakly — dim +
  italic is exactly what screen readers and low-contrast displays miss, and a missing composer
  reads as "broken thread" more than "intentionally read-only".

**3C — Provenance & gaps.** Every mirrored beat tagged (`via parent session · tool_use 8f3a`);
every unstreamed span drawn as an explicit gap row; `Mirror (partial)` chip.

- Optimises for: distrust-by-default — a partial replay can never pass as a complete transcript.
- Gives up: cleanliness — noisiest variant by far; depends on per-beat stream data the model
  doesn't have.
- Strongest objection: punishes every mirror for a failure mode that may be rare — if the provider
  streams faithfully, the view is still covered in provenance boilerplate, training users to skim
  past the warnings that matter; `tool_use` ids are plumbing most users should never read.

**3D — Completion archive.** Mirrors created only on finish/fail; running natives stay in the turn
card. The mirror view is an archive receipt, not a replayed transcript.

- Optimises for: never faking liveness — durability without pretense; the only variant immune to
  the transcript-fidelity problem.
- Gives up: live visibility — the sidebar stops being the one place to see all parallel work.
- Strongest objection: solves the honesty problem by shrinking the feature — mirrors become
  second-class receipts that "pop in" after the fact, arguably a worse, detached version of the
  workflow card entry they duplicate.

---

## Recommendations

- **Option 1 → 1A (Split section).** Affordance honesty is the stated failure condition, and 1A is
  the only variant where the capability difference is structural — the label _is_ the explanation,
  visible before any interaction. The jump interaction is identical across variants, so the split
  costs only vertical space.
- **Option 2 → 2A (Same anatomy, honest composer).** Parity is the point of the option: one window
  to learn for both kinds, with the capability difference stated in words exactly where the user
  looks for it. If a running-state upgrade is wanted later, 2D's live body slots into 2A's frame
  as a running-only module.
- **Option 3 → 3C (Provenance & gaps), with 3D as fallback.** The mirror's fundamental risk is a
  partial replay being read as a complete transcript; 3C is the only variant that structurally
  prevents that. If the transcript-fidelity spike shows per-beat stream data isn't obtainable, 3D
  is the honest fallback — build archives, not live mirrors.

Cross-option: the three options are not mutually exclusive. 2A is independently shippable (no new
server data); 1A subsumes the sidebar half of 3A–3C without promising a transcript; option 3 is
the only one gated on data that may not exist.

## Data gaps — what the designs wanted that `WorkflowActivityWorker` doesn't provide

Consolidated from all three options' `NOTES.md`. This is the buildability input: everything a real
implementation would need beyond the current model (`apps/web/src/workflow-activity.ts:13`).

**Blocking (option 3 depends on these):**

- **No per-message transcript.** Workers carry only `prompt`, a single rolling `progressSummary`,
  `resultSummary`, `errorMessage`, `lastToolName`, `usage`, and `outputFile`. Mirrored transcript
  beats are aspirational; the only real source is `outputFile` — provider-written,
  provider-formatted (JSONL), potentially large, gated by `skipTranscript`, with no normalized
  reader.
- **No per-beat provenance or timestamps.** 3C's tags and gap durations need stable ids and times
  per streamed event; the model has one optional `toolUseId` and worker-level
  `startedAt`/`updatedAt`.
- **No progress history.** `progressSummary` overwrites; 2D's beat log and any "activity over
  time" view need an append log of `task.progress` events per worker.

**Non-blocking but real:**

- **Usage is optional and latest-value.** Every `TaskUsageSnapshot` counter is independently
  optional; 1D's metrics-at-rest can degrade to partial triples, and there is no usage history.
- **No tool-call enumeration.** Only `lastToolName`; "14 tools" can't be listed or inspected.
- **`outputFile` timing.** It arrives with `task.completed`; running workers have no file (2B
  honors this — the implementation should too).
- **No model field.** Natives inherit the parent session's model; "inherits parent · Opus 4.7"
  must be derived from the parent, not read off the worker.
- **No duration field.** Derivable from `startedAt`/`updatedAt` only once finished/failed.
- **No capability descriptor.** "View only" is hard-coded per kind; if a future provider makes
  natives steerable, the UI couldn't distinguish — honesty would need a capability field, not a
  kind check.
- **Turn ordinals / cross-kind ordering.** Workers carry opaque `turnId`s; "Turn 4" labels and
  merged-by-start-time lists need joins the sidebar doesn't do today.
- **Promote bridge (2C).** Nothing in contracts/server converts a worker's `prompt` +
  `subagentType` into a thread-task creation request.

**Already supported today** (no gaps): status lifecycle incl. failed, description/subagentType,
result/error summaries, `lastToolName`, usage chips, and retry linkage (`retryOfTaskId` /
`retriedByTaskId` — the W3→W4 ↺ marker works as-is).
