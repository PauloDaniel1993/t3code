# Option 2 — Mini-window parity — design notes

One page, four variants of the same idea: the existing mini thread window also opens on a
provider-native subagent, launched by clicking a worker row in the transcript's workflow card.
Steering/cancellation is impossible in all four, so every variant states why in words. Open
`index.html` directly; `?v=1..4` picks the variant, `&w=w1..w4` picks the worker (default
`w2`, the running one).

## V1 — Same anatomy, honest composer

- Optimises for: learnability. One window anatomy serves both kinds of parallel work — thread
  tasks and in-session agents differ only in chips ("in-session agent"), in the header action
  ("Show in transcript" instead of "Open thread ↗"), and in a composer that is present but
  disabled with the reason spelled out ("Runs inside the parent session — to stop it,
  interrupt the parent turn"). Zero new UI vocabulary.
- Gives up: the live-ness of a running worker. A single "latest activity" line is all the
  anatomy has room for; watching W2 work is strictly better in V4.
- Strongest objection: a permanently disabled composer is a tease. It keeps the _shape_ of an
  affordance the object can never support, and some users will read "disabled" as
  "unlockable somewhere in settings". Parity also cuts both ways: reusing the task window
  risks implying task properties (durability, openable as a thread) that native workers don't
  have — "Show in transcript" is a weaker promise than "Open thread ↗", and the user learns
  the difference only by reading fine print.

## V2 — Receipt card

- Optimises for: trust. "Honesty by subtraction" — no composer, no send button, nothing that
  could be misread as control. The AGENT RECEIPT framing sets the right expectation: this is
  a record of work done (or in flight), with the stats, the result, and the full-output file
  path as the escape hatch for anything the summary omits.
- Gives up: any sense of process. It is the weakest variant exactly while a worker is running
  — a receipt for work still happening is a contradiction the design papers over with a
  "Still running" note.
- Strongest objection: it dead-ends the user. A failed run (W3) presented as a red receipt
  with no recovery action pushes the user back to the transcript to figure out what happens
  next; and "Copy result" copies a one-paragraph _summary_, not the actual output — the
  honest artifact is the outputFile path, which most users can't or won't open.

## V3 — Peek → promote

- Optimises for: the recovery workflow. When the agent went wide in-session but the user
  wanted (or the task deserves) a real sub-thread, "Promote to task thread" is one click
  away, and the copy makes clear it is a _re-run_ with its own session, not an adoption of
  the existing run.
- Gives up: honesty-by-simplicity — it is the only variant that adds a capability instead of
  describing one.
- Strongest objection: it sells a feature that does not exist. "Promote" is a product
  decision disguised as a button: re-running a prompt as a task is _not_ the same computation
  (fresh context, nondeterministic — W1's re-run may not rediscover the same gaps), and it
  quietly encourages turning lightweight in-session work into heavyweight ~400 MB threads.
  If the bridge never ships, this variant is a promise we can't keep.

## V4 — Live ticker

- Optimises for: the moment of watching. A running worker gets a ticking elapsed readout, a
  timestamped progress log, and a pulsing "Last: Grep" chip — the window is a monitor first;
  for a finished worker the same chrome collapses to a summary (`?v=4&w=w1`).
- Gives up: the recovery/action surface entirely — like V2 there is no path from "this is
  failing/failed" to doing anything about it besides interrupting the parent turn.
- Strongest objection: a monitor for a process you cannot control is anxiety TV. The ticking
  clock emphasizes the one thing the user has no agency over, and — worse — the data cannot
  feed it today: `progressSummary` is a single rolling string, so the beat log is fiction
  unless the server starts retaining every `task.progress` event per worker.

## Recommended variant

**V1 — Same anatomy, honest composer.** Parity is the point of this option: one window to
learn for both kinds of parallel work, launched from both surfaces, with the capability
difference stated in words exactly where the user would look for it. If a running-state
upgrade is wanted later, V4's live body (ticker + beat log) slots into V1's anatomy as a
running-only module without changing the frame.

## Data gaps (things the design wanted that WorkflowActivityWorker does not provide)

- **Timestamped progress history.** `progressSummary` is one rolling string; V4's beat log
  (0:12 / 0:41 / 1:02) and V1/V2's "latest progress" both assume per-beat `task.progress`
  events are retained per worker, which the model collapses today.
- **Usage over time.** `TaskUsageSnapshot` is a latest-value rollup (`totalTokens`,
  `toolUses`, `durationMs`) — fine for the chips/stat cells, but no sparkline-style history;
  and every counter is optional, so the UI must degrade when e.g. `durationMs` is absent (the
  mockup assumes all three are always present).
- **Tool-call breakdown.** Only `lastToolName` exists; "14 tools" cannot be enumerated or
  inspected — no per-worker tool list for the window to show.
- **outputFile timing.** `outputFile` arrives with `task.completed`; a running worker has no
  file yet. V2 honors this by omitting the "Full output:" line while running — worth keeping
  in the real implementation rather than rendering a dead path.
- **Summary vs. full result.** Only `resultSummary` is available, so "Copy result" (V2)
  copies the summary, not the real output; anything fuller requires reading `outputFile`.
- **Worker model/effort.** Native workers inherit the parent session's model and have no
  model field — the windows deliberately show no model chip (unlike thread-task windows);
  that's a constraint, not a choice.
- **Promote bridge (V3).** Nothing in contracts/server can convert a worker's `prompt` +
  `subagentType` into a new thread-task creation request; V3 requires that API to exist.
