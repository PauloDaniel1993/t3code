# Mobile tasks v2 — mockup handoff

Static HTML mockups of how **tasks (sub-threads)** and their turns' provider-native **agents**
surface in the T3 Code mobile app. v2 converges v1's four options into one flow — **thread-list
entry → bottom-sheet peek → full task view** — plus a state matrix rendering every lifecycle
state side by side. This is the input for planning and refinement — not an implementation.

What v2 was built from, precisely:

1. **v1's HTML/CSS** (`../mobile-tasks-mockups/`, frozen) — the four option pages and the
   shared stylesheet, which contain both v1's trace of the Android chrome and v1's
   interpretation of the tasks/agents visual language. v2 forked the stylesheet and carried the
   markup anatomies forward screen by screen.
2. **`reference-mobile.png`** (in v1's directory) **as already traced into v1's markup.** No
   one in this run looked at the image directly — no vision was available to the builders — so
   v2 inherits v1's trace of the status bar, "T3 Code · ALPHA" header, search field, thread-row
   anatomy, FAB, and gesture bar rather than re-deriving them from the pixels. v2's landing
   page embeds the image from v1's directory for the reader's reference (the one cross-directory
   dependency; see README's Files section).
3. **The desktop/web sidebar's tasks/agents UI — still unavailable.** This reference never
   existed as a file; v1 worked from a written description of it, and v2 carries v1's
   interpretation forward **unverified**. The tasks/agents visual language (disclosure chips,
   guide-line sub-rows, ✓/× counters, ↩ returned markers, Settle pill) has therefore never been
   checked against what was actually wanted. That alignment pass (OpenSpec task 5.1) is **not
   done** and is not claimed anywhere in this set — it is the one thing v2 did not close.

Open `index.html` directly in a browser (works over `file://`, no server, no build). Every page
takes `?theme=dark|light` (absent = follow the OS) and preserves a pinned theme across every
internal link.

## Files

- `index.html` — landing page linking the chrome, the three flow screens, and the state matrix.
- `chrome.html` — the canonical Android chrome as two phones (dark / light); screen pages copy
  the `CHROME-BEGIN`/`CHROME-END` block.
- `mockup.css` — shared stylesheet forked from v1: contrast-fixed `--dim`, full light theme,
  per-theme chrome tokens, translucent elevated surfaces, promoted shared rules.
- `CONVENTIONS.md` — the build contract: `?theme=`/`?param` conventions, chrome skeleton, class
  inventory, honesty rules (§7). §3 holds the final deep-link parameter contract.
- `CONTRAST.md` — measured WCAG ratios for every text token on every surface in both themes,
  plus the chrome fixes and an "Effective contrast" section.
- `flow-1-list/` — thread-list entry (`?peek=`, `?groups=`) + `NOTES.md`.
- `flow-2-peek/` — bottom-sheet peek (`?sheet=`, `?task=` alias) + `NOTES.md`.
- `flow-3-task/` — full task view for all four tasks (`?task=`, `?state=`, `?view=`) +
  `NOTES.md`.
- `state-matrix/` — the seven lifecycle states side by side (`?state=`) + `NOTES.md`.
- `_reports/` — the build/reconciliation reports: `T3` flow-1, `T4` flow-2, `T5` flow-3, `T6`
  state matrix, `T7` reconciliation, `T8` this documentation pass.
- `README.md` — the flow, per-screen trade-offs, what changed from v1 and why, measured
  contrast, data-gap analysis.
- `HANDOFF.md` — this file.

## Scenario captured in the mockups

v1's scenario, unchanged — v2's new states are new cardinalities of the same tasks, not
invented threads:

- **Add Wayfinder Constellation Sidebar View** (`pingdotgg/t3code`, dev, Claude Code /
  Opus 4.7) — expanded; chip "⌄ 1 task · 10 agents".
  - Task "Create 4 mockups for the mobile app based on th…" — working 8s, agent-created, full
    thread context; its **latest turn has 10 agents: ✓ 6 completed, × 4 failed** (all four
    `failed — tool-use budget exceeded`), ↩ returned.
- **Fix T3 Connect Redirect Error** (`pingdotgg/t3code`, dev, 13h) — chip "⌄ 3 tasks":
  "Build a standalone, installable Android APK of t…" (done 19m, ↩, turn of 3 agents with one
  budget-exceeded failure), "is it possible to build locally?" (✓ done, 59s, ↩, created by you,
  no agents ran), "the t3 connect is not letting log in" (working, 24s, ↩, created by you).
- The remaining list rows are the real rows from the app screenshot (Build Standalone Android
  APK, Add Task Transformation to Threads, Assess Local Build Feasibility, both Finish Durable
  Chat rows with #10, Fix T3 Connect Login = Working).
- State-matrix cardinalities: the single agent is one of the ten; all-failed is the APK turn
  with all three failed; cancelled is the mockups task interrupted mid-turn at 26s;
  returned-unread is the APK task's ↩ with a dot on the parent and the word "unread" on the
  row; the native non-steerable case is the failed agent a4's sheet.

## Semantics to carry into a mobile implementation

- **Hierarchy: thread → tasks → a task's turn → that turn's agents.** The list surfaces three
  levels (thread, task, turn summary); individual agents live in the sheet's agent block and
  the task thread's agent card — view only in both.
- **Tasks are full threads** (own session/provider), linked to their parent. On mobile they are
  pushable views with normal thread chrome and a composer whose availability follows the
  lifecycle: "Steer this task…" while running, "Message this task…" once done, and **disabled
  with the reason in words plus a Retry action** once failed or cancelled — never a greyed
  control with no explanation.
- **Agents are view-only, structurally.** They run inside a task's (or thread's) session: no
  steer composer (a disabled one states why in words: "Runs inside the task's session — to stop
  it, interrupt the task's turn"), no cancel, no model of their own ("inherits task ·
  Opus 4.7"), terminal action "Show in transcript".
- **Status language:** blue asterisk = working, green ✓ = done, red ⊗ = failed, dim clock =
  queued (it also means snooze/reminders on the parent row — the word "Queued" does the
  disambiguating), amber minus-in-circle = cancelled, chevron = expandable, ↩ = returned
  results / woke parent, "✓ n × m" = per-turn agent outcomes, "✓ n ⊖ m" for cancelled outcomes.
  Cancelled is its own state: amber, never red, never "failed".
- **Honesty rules** (CONVENTIONS.md §7 — the set's real deliverable): a failed item always
  carries its reason in words (terse in rows, full sentence where there is room); counts read
  correctly at zero, one, and all-failed — "✓ 6" alone when nothing failed, "× 3" alone when
  everything did, "1 agent" singular, no counters at all before anything ran, never "0 of 0".
- **The parent row's furniture** — clock (reminders), "✓ Settle" pill, disclosure chip — ships
  only on rows with fan-out, and only while expanded; collapsed rows shed back to the plain
  time-ago. Idle rows keep the shipped app anatomy.
- **Contrast is a measured property, not a taste.** Every text token on every surface in both
  themes clears 4.5:1 in `CONTRAST.md`, and two defect classes came from effects token tables
  cannot see: an `opacity: 0.65` on a disabled composer dropped its mandatory reason sentence
  to 2.65:1 while its token measured 4.69:1, and the avatar's `hsl(var(--h) 65% L%)` background
  passes at hue 215 but fails at hue 60 (2.7867:1 at 38% lightness). An implementation must
  (a) never dim text by opacity below the threshold — the greyed send pill carries the disabled
  read here — and (b) keep the avatar hue constraint **200–260** at 38% lightness; only hues
  215 and 255 are in use and measured safe.
- **The flow is the recommendation.** v1 compared four options; v2 is the composition: list =
  find, sheet = glance, task thread = act. The state matrix is not a product screen — it is the
  review artifact proving every lifecycle state has an honest rendering.

## Open questions for planning (mobile)

- **Reference alignment — NOT done.** The tasks/agents reference image still does not exist;
  the visual language of tasks and agents is unverified against any reference. This is the one
  open task that gates a "matches what was wanted" claim, and it must not be treated as closed
  by anything in this set.
- **Tap semantics per row kind.** v2 wires task tap → sheet and ↗ → thread, but whether that is
  the shipped mapping (sheet vs. push as _the_ gesture) is deliberately unsettled, as it was in
  v1. One gesture per surface, never both by context.
- **Turn rows as list entities.** The turn row's tap opens the task sheet's agent block. Are
  turns ever expandable inline (a third nesting level on 390px)? The mockup says no; the
  question stays open.
- **↩ lifecycle.** Rows show ↩ while still working — is that "returned intermediate results"?
  What are the exact contract states? What sets and clears the new unread marker?
- **Rollups.** The disclosure chip, ✓/×/⊖ counters, and the "Latest turn" label need
  per-thread task+agent aggregates the list payload doesn't compute today.
- **Push notifications for wakes.** Which returns are user-visible, and what does opening the
  notification deep-link to?
- **Terminal-state steerability.** The mockups settle by fiat: a done task accepts messages (a
  new turn), a failed or cancelled task does not (Retry instead). Reasonable people could flip
  either; the contracts don't say. What Retry reuses — the brief, partial state, or a fresh
  turn — is likewise a contract decision.
- **Back-stack depth.** List → sheet → task, each a pushed layer; the back affordance must
  disambiguate "task sheet", "parent thread", and "thread list" once a real parent view exists.
- **Live subscriptions on a phone.** List rows, sheets, and the task view all stream running
  state; over relay/tunnel with backgrounding, each needs resume semantics or a staleness
  marker.
- **Likely touchpoints to investigate**: `apps/mobile` thread list, thread feed, and composer;
  `packages/client-runtime` shared thread/agent selectors; `packages/contracts` session, task,
  and agent (worker) event schemas; the server's wake/result delivery for a user-visible flag.

## Verification status

Built and reconciled without a browser: all rendering claims are by construction, inspection,
and WCAG recomputation (every ratio in `CONTRAST.md` is recomputable from the method stated at
the top of the file). A coordinated browser-verification pass over `file://` — the flow hops,
both themes, 320px, the state matrix — is requested and specified in `_reports/T7.md` (and
re-requested in `_reports/T8.md`). Until it runs, no pixel-level claim in this set has been
confirmed by a render.
