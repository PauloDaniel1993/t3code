# Option 3 — Mirror threads — design notes

Each provider-native subagent is mirrored into a **read-only task thread**: a real sidebar row,
normal thread navigation, a thread view of whatever the provider actually streamed — permanently
read-only (no steer composer, no cancel, no model picker). The four variants take different
positions on the core tension: the mirror promises "thread" but cannot deliver thread
capabilities, and the transcript may be partial.

## V1 — Locked chrome

- Optimises for: first-class citizenship. A mirror is navigable exactly like a task thread —
  same chrome, same timeline, same chips — with the capability story stated once, in words, in a
  full-width lock banner where the composer would be. Lowest learning curve: if you know what a
  task thread view is, you know what this is.
- Gives up: any honesty about partial data. The timeline presents three replayed beats as a
  clean transcript; nothing says the provider may not have streamed everything. It also spends
  the most screen real-estate on the read-only message (a whole composer-height banner).
- Strongest objection: the chrome is doing the opposite of the banner. Everything about the view
  — sidebar row identical to tasks, full thread timeline, chips row — says "normal thread", and
  banner blindness is real; users will try to steer it, and worse, will trust the transcript as
  complete when it is a best-effort replay. The most credible-looking variant is therefore the
  most dishonest one.

## V2 — Ghost rows

- Optimises for: glance-level separation. Ghosted sidebar rows (dimmed, italic title, `mirror`
  chip) can never be mistaken for real tasks; the thread view drops the composer area entirely
  so there is nothing to mistake for an input. Cheapest to build and the calmest sidebar.
- Gives up: discoverability and emphasis. Ghosting makes mirrors look unimportant or
  unavailable, which undersells finished work that may be the most valuable output of the turn.
  No chips row means usage/model facts have to hide in the result header.
- Strongest objection: honesty carried "entirely by styling" is honesty carried weakly. Dim +
  italic is exactly the kind of signal screen readers, low-vision users, and anyone on a
  low-contrast display will miss — and the one-line provenance note has to do all the work the
  V1 banner does, so it will be ignored at exactly the moment a user wonders why they can't
  type. Removing the composer zone also reads as "broken thread" more than "intentionally
  read-only".

## V3 — Provenance & gaps

- Optimises for: distrust-by-default. Every mirrored beat carries a provenance tag
  (`via parent session · tool_use 8f3a`), and every span the provider didn't stream is an
  explicit gap row (`— 14s not streamed by provider —`). A partial transcript can never pass as
  complete here; the `Mirror (partial)` chip and sidebar warning markers set expectations before
  the user even opens the view.
- Gives up: cleanliness. This is the noisiest variant by far — tags on every message, dashed
  gap rows, warning markers in the sidebar. It also depends on stream data (per-beat ids and
  timestamps) that the current data model does not provide, so it is the most expensive to
  build for real.
- Strongest objection: it punishes every mirror for a failure mode that may be rare. If a
  provider streams faithfully, the view is still covered in provenance boilerplate and gap
  rows, training users to skim past the very warnings that matter. It also exposes plumbing
  (`tool_use` ids) that most users should never have to read — honesty here borders on
  noise-as-virtue.

## V4 — Completion archive

- Optimises for: never faking liveness. Mirrors are created only when a subagent finishes or
  fails, so no read-only thread ever pretends to be running. Running natives stay in the
  parent's workflow card (their only truthful home), and the mirror view is an archive
  receipt — prompt, stats, result, delivered-to-parent event — not a replayed transcript.
  Durability without pretense; also the only variant immune to the transcript-fidelity problem.
- Gives up: live visibility. While W2 and W4 run, the sidebar shows nothing for them beyond a
  dim policy note, so the sidebar is no longer the one place to see all parallel work. Users
  who want to watch a running subagent must go back to the turn card.
- Strongest objection: it solves the honesty problem by shrinking the feature. Mirrors become
  second-class receipts that appear after the fact, which makes the sidebar feel like rows
  "pop in" unpredictably — and the receipt is arguably a worse, detached version of the
  workflow card entry it duplicates. If users wanted to watch progress, this variant tells them
  the sidebar is the wrong place to look.

## Recommended variant

**V3 — Provenance & gaps.** The mirror thread's fundamental risk is that a partial replay gets
read as a complete transcript; V3 is the only variant that structurally prevents that instead of
papering over it with a banner or a styling pass. It keeps the V1 win (mirrors as first-class,
navigable threads) while making provenance and missing spans explicit at exactly the points
where a reader would otherwise assume fidelity. If per-beat stream data never lands, V4 is the
honest fallback — but V3 is the position worth building toward.

## Data gaps (things the design wanted that WorkflowActivityWorker does not provide)

- **No per-message transcript stream exists.** `WorkflowActivityWorker` (apps/web/src/workflow-activity.ts:13)
  carries only `prompt`, `progressSummary` (a single rolling string), `resultSummary`,
  `errorMessage`, `lastToolName`, `usage`, and `outputFile`. The three "mirrored beats" in
  V1–V3 ("Reading packages/contracts/src/acp.ts…", "Grep: session/…", "Cross-referencing…") are
  **aspirational**: today they would have to be scraped out of the provider-specific
  `outputFile` (JSONL, format varies per provider) or synthesized from `progressSummary`
  updates. V1 and V2 depend on solving this _and_ present the result as an ordinary transcript
  without marking provenance; V3 depends on it too but is the only variant that says so.
- **No per-beat provenance or offsets.** V3's tags (`via parent session · tool_use 8f3a`) need a
  stable id per streamed event; only a single optional `toolUseId` exists on the worker. V3's
  gap rows (`— 14s not streamed —`) additionally need per-event timestamps — the model has only
  worker-level `startedAt`/`updatedAt`, so gap durations cannot be computed today.
- **No tool-call history.** `lastToolName` is only the latest tool. The "14 tools" total comes
  from `usage`, but which tools ran, in what order, and with what arguments is not in the model
  (again, only via `outputFile`).
- **No progress history.** `progressSummary` is one rolling string (W2's "Following the refresh
  path…" would overwrite earlier summaries); a mirror timeline of "latest activity" over time
  would need an append log.
- **No model field.** Subagents inherit the parent session's model; the
  `inherits parent · Claude Opus 4.7` chip must be derived from the parent session, not read off
  the worker.
- **No duration field.** "2m 14s" must be derived from `startedAt`/`updatedAt`, which is only
  meaningful once the worker is finished or failed (V4's receipt relies on exactly this).
- **`outputFile` is the only path to a real transcript**, but it is provider-written,
  provider-formatted, potentially large, and gated by `skipTranscript`; V1–V3's replay views
  implicitly assume a normalized reader for it that does not exist.
- Retry linkage is **already supported** (`retryOfTaskId` / `retriedByTaskId`) — the W3→W4 ↺
  marker and V4's "retried by a new subagent" note are implementable today.
