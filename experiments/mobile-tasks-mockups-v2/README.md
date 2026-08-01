# Mobile tasks — mockups v2

Static HTML mockups of how **tasks** and their turns' **agents** surface in the T3 Code mobile
app (Android, dark **and light**). v2 converges v1's four parallel options
(`../mobile-tasks-mockups/`, frozen as the comparison baseline) into the single flow v1's own
README recommended — **thread-list entry → bottom-sheet peek → full task view** — and renders
the lifecycle states v1 never showed: queued, exactly one agent, zero failures, all agents
failed, cancelled mid-flight, returned-but-unread, and the native in-session agent that must
visibly refuse steering. Companion to `../thread-tasks-mockups/` and
`../subagent-view-mockups/`; reuses their mockup idiom via a forked `mockup.css`.

**References — stated honestly.** v2 was built from two things: **v1's HTML/CSS**, and
**`reference-mobile.png`** (in v1's directory) _as already traced into v1's markup_. Nobody in
this run looked at the image directly — no vision was available to the builders — so v2
inherits v1's trace of the Android chrome rather than re-deriving it. The second reference v1's
`HANDOFF.md` names, the desktop/web sidebar's tasks/agents UI, **still does not exist as a
file**: everything specific to tasks and agents (disclosure chips, guide-line sub-rows, ✓/×
counters, ↩ returned markers, the Settle pill) remains v1's interpretation of a written
description, carried forward unverified. See "What v2 does not settle" below.

**The model.** Hierarchy is **thread → tasks → a task's turn → that turn's agents**. Tasks are
real sub-threads: own session, steerable, cancellable, durable, and they return results to the
parent (↩, which wakes it). Agents are provider-native runs inside a task's (or thread's)
session: they cannot be steered or cancelled independently, have no model of their own, and
today surface only as a card in the transcript. The product vocabulary is **"tasks" and
"agents"**. **Affordance honesty** still applies, and v2 sharpens it into rules (CONVENTIONS.md
§7): a failed item always carries its reason in words; an unavailable control always says why
in words next to it; counts read correctly at zero, one, and all-failed (no "× 0", no "1
agents", no "0 of 0"); cancelled is its own amber state, never red, never "failed".

## Viewing

Open `index.html` directly in a browser (works over `file://`, no server, no build). Every page
accepts `?theme=dark|light` (absent = follow the OS); a pinned theme survives every internal
link, so a walk never drops it. The full parameter contract, as finally wired, is the table in
`CONVENTIONS.md` §3 — what follows is the walk.

**To walk the converged flow:**

1. **`flow-1-list/`** — the thread list, both task groups expanded. Tap a **task row** to open
   its peek sheet (flow 2); tap the trailing **↗** to jump straight to the full task view
   (flow 3); tap the **turn row** to open its task's sheet, where the turn's agents render view
   only. Deep links: `?peek=task|turn|apk|local|login` highlights and scrolls to that sub-row
   (re-opening its group if collapsed); `?groups=collapsed` renders every group closed (the
   disclosure chip toggles them live).
2. **`flow-2-peek/`** — the bottom-sheet peek, rendered open. Deep links:
   `?sheet=task|apk|local|login|a4` (`a4` is the failed in-session agent — the non-steerable
   case); `?task=<id>` is the alias flow 1's rows emit. **"Open thread"** navigates to flow 3;
   dismissing (dim, grabber, ✕, Escape) returns to flow 1 with the owning row still
   highlighted.
3. **`flow-3-task/`** — the full task view. Deep links: `?task=task|apk|local|login` picks
   which of the four modelled tasks renders; `?state=running|complete|failed` switches the
   mockups task's lifecycle tail and composer (inert for the other three tasks, which have one
   canonical state each); `?view=parent` redirects to the task's row in flow 1. The back
   chevron returns to the task's sheet; "See in list →" lands on the task's row in flow 1.

**To review the states:** **`state-matrix/`** renders all seven states side by side, one phone
each; `?state=queued|single|zero-fail|all-failed|cancelled|unread|native` rings that phone and
scrolls to it. Each phone's caption carries a permalink. Two of the sheet phones (zero-fail,
native) have their header action wired into the flow; the cancelled and all-failed sheets
deliberately do not (flow 3 models neither a cancelled state nor the ×3 cardinality — the
captions say so in words).

**`chrome.html`** is the canonical Android chrome rendered as two phones, dark and light, side
by side — the copy-paste source every screen is built on. Unknown deep-link values everywhere
fall back to the page's default state, never a blank screen.

## Files

- `index.html` — landing page linking the chrome, the three flow screens, and the state matrix,
  with a theme switcher. (It embeds v1's `reference-mobile.png` — see the note below.)
- `chrome.html` — the canonical chrome in both themes; the `CHROME-BEGIN`/`CHROME-END` block is
  what screen pages copy.
- `mockup.css` — shared stylesheet, forked from v1's: the contrast-fixed `--dim` token, a full
  light theme, per-theme chrome tokens (FAB, ALPHA pill, search field, header buttons),
  translucent elevated surfaces, and the shared rules promoted out of the four screens during
  reconciliation.
- `CONVENTIONS.md` — the contract the four screens were built to: the `?theme=`/`?param`
  conventions, the chrome skeleton, the class inventory, and the honesty rules (§7) that are
  the set's real deliverable.
- `CONTRAST.md` — measured WCAG 2.x ratios for every text token on every surface in both
  themes, the chrome-fix measurements, and an "Effective contrast" section on what token tables
  cannot see. Every claim in it is computed from literal CSS values and is checkable.
- `flow-1-list/` — thread-list entry + `NOTES.md`.
- `flow-2-peek/` — bottom-sheet peek + `NOTES.md`.
- `flow-3-task/` — full task view + `NOTES.md`.
- `state-matrix/` — the seven lifecycle states + `NOTES.md`.
- `_reports/` — the build and reconciliation reports (`T3`–`T7`: the four screens and the
  reconciliation pass; `T8`: this documentation pass).
- `README.md` — this file. `HANDOFF.md` — the planning handoff.

**The one external dependency.** `index.html` embeds
`<img src="../mobile-tasks-mockups/reference-mobile.png">` — the only image anywhere in v2, and
a path into v1's directory. It is legitimate (relative, on-disk, no network — the set still
works over `file://`), but it means v2 is not fully self-contained: v1 is meant to be an
archivable frozen baseline, and if it is ever moved or pruned, the v2 landing page loses its
reference thumbnail. Everything else in v2 touches nothing outside its own directory.

## Shared scenario

Unchanged from v1 — new lifecycle states are new **cardinalities of the same scenario**, never
invented threads (CONVENTIONS.md §7.6 pins this):

- **Add Wayfinder Constellation Sidebar View** (`pingdotgg/t3code`, dev, Claude Code / Opus 4.7)
  — expanded: clock + ✓ Settle pill, chip "⌄ 1 task · 10 agents".
  - **Task** — "Create 4 mockups for the mobile app based on th…", working 8s, agent-created,
    full thread context.
    - **Latest turn · 10 agents** — ✓ 6 completed, × 4 failed (all four
      `failed — tool-use budget exceeded`), ↩ returned.
- **Fix T3 Connect Redirect Error** (`pingdotgg/t3code`, dev, 13h) — chip "⌄ 3 tasks".
  - "Build a standalone, installable Android APK of t…" — done 19m, ↩; its turn ran 3 agents
    (2 ✓, 1 × budget exceeded).
  - "✓ is it possible to build locally?" — done, 59s, ↩, created by you from 2 selected
    messages; no agents ran.
  - blue asterisk "the t3 connect is not letting log in" — working, 24s, ↩, created by you.

The remaining list rows are the real rows from the app screenshot ("Build Standalone Android
APK" 13h, "Add Task Transformation to Threads" 11h, "Assess Local Build Feasibility" 14h, both
"Finish Durable Chat…" rows 15h #10, "Fix T3 Connect Login" Working). The state matrix reuses
these same tasks for its cardinalities: the single agent is one of the ten; all-failed is the
APK turn with all three failed; cancelled is the mockups task interrupted mid-turn at 26s;
returned-unread is the APK task's ↩ with an unread marker on the parent.

---

## What changed from v1 and why

v2 exists because of three findings about v1. They are stated in
`openspec/changes/revise-mobile-task-mockups/proposal.md`; the measured numbers below are the
ones that actually reproduce (see the contrast finding).

**1. v1 never saw the tasks/agents reference.** v1's own `HANDOFF.md` says the Android chrome
was traced from `reference-mobile.png` — a real file, present in v1's directory — but the
tasks/agents visual language came from "the desktop/web sidebar's tasks/agents UI (not
embeddable)": a written _description_, not a file. Everything v1 derived from it is an
interpretation, not a match — and **that is still true in v2**. v2 inherits v1's interpretation
unchanged and flags the missing reference as the one thing it did not close (below). Nothing
about the converged flow, the state matrix, or the contrast work depends on it.

**2. v1 hardcoded one scenario.** All four v1 variants render the same "10 agents, 6 done, 4
failed" turn. The rollup chips, counters, and failed-agent styling were never rendered at any
other cardinality — including the two most common ones, a single agent and zero failures. v2's
answer is the **state matrix**: seven phones, one state each, side by side on one page, each a
real rendering rather than a prose description — queued (no counters at all, "Queued" in
words), exactly one agent ("1 task · 1 agent", "✓ 1" — never "1 agents"), zero failures
("✓ 10" alone, no red anywhere), all failed ("× 3" alone, every row reasoned), cancelled
mid-flight (amber, "✓ 6 / ⊖ 4", never red, never "failed"), returned-but-unread (blue dot +
the word "unread", next to its read sibling for comparison), and the native in-session agent
refusing a steer with the reason in words.

**3. Contrast failed, measurably.** v1's `--dim: #6b7280` — the token carrying the small
metadata lines everywhere — sits at **4.0952:1** on `--bg: #0a0a0a` and **3.9291:1** on
`--card: #101013` under the WCAG 2.x relative-luminance computation. Both fail the 4.5:1
threshold. Note on provenance: the proposal and design documents cite 4.15:1 and 3.98:1, but
**those claimed values do not reproduce** — the ratios above were recomputed independently
(twice during the run, and once more for this documentation pass) and are what `CONTRAST.md`
records. The discrepancy is in the original measurement, not in the finding: claimed or
measured, both values fail 4.5:1, so the fix was correct and stands. The replacement token was
chosen by measurement against _both_ dark surfaces, not by eye: dark `--dim: #787e8a` measures
**4.8552:1** on `--bg` and **4.6583:1** on `--card` (PASS, still visually subordinate to
`--muted`); the new light theme's `--dim: #6b6b73` measures **4.9335:1** and **5.2820:1**
(PASS). v1 also had no light theme at all — "legible in both themes" was unverifiable rather
than merely unverified — so v2 adds one as a token block, and every page renders in both.

Alongside those three, the converged flow itself is a change: v1's four options are replaced by
one wired flow (list → sheet → thread) with real navigation in both directions, collapsible
task groups, and v1's `?param` deep-link convention carried forward so the two sets navigate
the same way. The wording dialects the four screens were built with were reconciled into one
(`_reports/T7.md`): "Latest turn · n agents" everywhere, "Returned to the parent — woke
‹ParentName›", composer placeholders that carry the task's state ("Steer this task…" running,
"Message this task…" done, disabled with the reason in words plus **Retry** when failed or
cancelled).

## Flow 1 — Thread list, expanded groups

The app's real thread list with the tasks/agents language grafted on, now wired as the flow's
entry: task rows open the peek sheet, a trailing ↗ opens the full task view, the turn row opens
its task's sheet. Groups collapse (the disclosure chip is a real toggle; the expanded parent's
clock + Settle shed back to the plain time-ago, exactly the shedding v1's notes required).
Full notes: `flow-1-list/NOTES.md`.

- **Optimises for:** zero new chrome, and now zero dead ends — the shipped list's anatomy is
  untouched and every nested row goes somewhere real: peek first, full thread one tap behind
  it.
- **Gives up:** vertical space — though collapse now gives it back, at the cost of hiding
  running work behind a second tap. The ↗ link spends ~20 px of every task row to keep the
  third screen reachable without opening the sheet first.
- **Strongest objection:** a navigation list is still the wrong place to watch live work.
  Ticking seconds and a ✓/× counter that changes mid-stream invite parking on the list as a
  dashboard, which a per-event re-rendered mobile list is bad at. Collapse makes this worse
  before it makes it better: the cheap way to stop the noise is to hide the work entirely.

## Flow 2 — Bottom-sheet peek

The glass bottom sheet over the dimmed list, carried from v1's option 2 with its anatomy
verbatim: status → title → chips → mini timeline → the turn's agent rows → actions → composer.
Task sheet: Cancel while running, enabled steer composer, "Open thread". Agent sheet: identical
frame, composer disabled **with the reason in words** ("Runs inside the task's session — to
stop it, interrupt the task's turn"), no Cancel, "Show in transcript". Full notes:
`flow-2-peek/NOTES.md`.

- **Optimises for:** parity with the accepted desktop design at mobile interaction cost — one
  sheet anatomy for both kinds of parallel work, the capability difference stated in words
  exactly where the user looks for it. In v2 dismissal actually returns somewhere: flow 1, row
  still lit.
- **Gives up:** the anchor back to the row (the sheet covers the list, mitigated weakly by the
  picked-row highlight staying lit under the dim) and any side-by-side view of sheet +
  transcript.
- **Strongest objection:** a sheet is a modal dead end for the one action that matters on a
  task — steering. v2's wiring sharpens this: "Open thread" is one tap away and lands on a real
  page, which may be where steering should have lived all along.

## Flow 3 — Full task view

A task opened as a normal pushed thread view — own header, provenance, full transcript, the
turn's agents with per-agent outcomes and failure reasons, and a composer whose availability is
always explained in words. All four scenario tasks are modelled; the mockups task carries three
lifecycle states (running / complete / failed) with three honest composer faces. Full notes:
`flow-3-task/NOTES.md`.

- **Optimises for:** the honest end of the flow — "Open thread" lands on a screen that owes
  nothing, and the only screen in the set showing all ten agents with their failure reasons at
  full width.
- **Gives up:** peeking, still — every inspection is a navigation (v1 option 4's own trade,
  inherited). And with no parent-thread page in v2, the back chevron's "parent" is only
  implied: the back target is the sheet you came from.
- **Strongest objection:** three screens now restate the same turn — the list's "✓ 6 × 4"
  sub-row, the sheet's agent block, and this page's agent card must never disagree, and this
  page is the one a reviewer will hold the other two against. There is also a model ambiguity
  the mockup had to settle by fiat: whether a completed or failed task accepts new messages
  (here: complete yes, failed no — retry instead). The contracts don't say.

## State matrix — every lifecycle state side by side

The deliverable v1 lacked: seven phones, one state each, on one page — queued, exactly one
agent, zero failures, all failed, cancelled, returned-unread, and the native agent refusing a
steer — each a real rendering in the surface where its risk lives (rollups on the list, failure
attribution and composers on sheets), each backdrop list adjusted so no phone contradicts
itself. Full notes: `state-matrix/NOTES.md`.

- **Optimises for:** reviewability in one pass — the comparison a reviewer would otherwise have
  to assemble is already assembled, and consistency is enforced structurally.
- **Gives up:** interaction. The sheets are statically open; nothing animates, dismisses, or
  navigates except the deep links. The flow between surfaces is flow 1/2/3's job.
- **Strongest objection:** a matrix is not a product screen. Each state is reviewed in
  isolation from the transitions that produce it — a reviewer can verify the renderings but not
  the lifecycle (what clears the unread dot, what a retry turns the all-failed sheet into).
  That gap is inherent to a state matrix; the flow pages own the transitions.

## Contrast — measured, not asserted

`CONTRAST.md` holds the full tables: every text token (`--fg`, `--muted`, `--dim`, `--info`,
`--success`, `--warn`, `--danger`, `--teal`, `--violet`, `--coral`) against every surface in
both themes, computed from the literal values in `mockup.css` under the WCAG 2.x
relative-luminance method, threshold 4.5:1. **All forty v2 token rows pass** (ten text tokens ×
two surfaces × two themes), as do the chrome fixes (per-theme FAB, ALPHA pill text, search
placeholder, header buttons, avatar initials). The method is stated at the top of the file, so
every number is recomputable — the claim is checkable, not asserted.

**Standing constraint for whoever implements this in React Native: token tables cannot see
effective contrast.** Two of the three real contrast defects found in this run came from
rendering effects a token table structurally cannot capture:

1. **An `opacity` multiplier.** `.sh-composer.disabled { opacity: 0.65 }` composited the
   mandatory non-steerability reason sentence 35% toward the background: the token measured
   4.69:1 on the sheet composite while the _effective_ text measured **2.6492:1** (dark) and
   **2.5460:1** (light). The fix removed the opacity entirely — the disabled read is carried by
   the greyed send pill (3.20:1 / 3.38:1, passing the 3:1 non-text threshold) plus the reason
   at full strength (4.69:1 / 4.91:1). An implementation that dims disabled text by opacity
   will reintroduce this defect invisibly.
2. **An `hsl()` hue parameter.** The repo avatar is `hsl(var(--h) 65% L%)` with white initials
   — its luminance is a function of a runtime parameter, not a token. White text passed at hue
   215 under the old 45% lightness (5.6124:1) but fails at hue 60 even under the new 38%
   (**2.7867:1**). The fix constrained lightness to 38% **and** hues to 200–260 as a hard rule
   (CONVENTIONS.md §7.5): inside the band the worst case is hue 200 at 5.0469:1. Only hues
   **215 and 255** are in use anywhere in the scenario, both measured safe (7.1954:1 and
   10.7023:1). An implementation must keep the hue constraint, not just the lightness.

The rule `CONTRAST.md` now follows, and an implementation should inherit: any text rendered
through an effect (opacity, blend, tint, translucent composite) must be measured at its
_effective_ color, with the effect named. Token-vs-token tables are the necessary minimum, not
the sufficient one.

## What v2 does not settle

- **Reference alignment is NOT done.** The tasks/agents reference image never arrived, so the
  visual language of tasks and agents — chips, guide-line sub-rows, counters, ↩ markers, Settle
  pill — remains **unverified against any reference**, exactly as it was in v1. This is the one
  thing v2 did not close (OpenSpec task 5.1 stays unchecked by construction). Everything else —
  convergence, state coverage, contrast, both themes — is independent of it and complete, but a
  reader must not mistake "v2 did everything else" for "v2 did everything": when a real
  reference exists, the alignment pass still has to happen, and it may restyle the visual
  language on top of the (structural) flow and state decisions.
- **Sheet vs. push for the task-row tap.** v2 renders the converged flow — a task tap opens the
  sheet, and the sheet's "Open thread" reaches the full view — but it deliberately does not
  settle whether that is the _shipped_ gesture mapping (see the interaction gaps below).
- **The parent-thread view.** v2 builds no parent page; `?view=parent` redirects to the list,
  and flow 3's back chevron targets the sheet. When a real parent-thread screen exists, the
  chevron should name it again.
- **Browser verification of the reconciled set.** The pages were built and reconciled with no
  browser available to the builders; every report requests a coordinated browser-verification
  pass over `file://` (the punch list is in `_reports/T7.md`). Until that pass runs, rendering
  is verified by construction and inspection, not by pixels.

## Data gaps / mobile-specific gaps

Desktop gaps from `../subagent-view-mockups/` (no per-message agent transcript, rolling
`progressSummary`, optional usage counters, no capability descriptor) still apply, and **v2
resolves none of v1's gaps** — a mockup cannot answer a contract question. They are re-stated
here so they are not mistaken for solved. v1's `README.md:155-190` is the original wording.

**Interaction gaps (open in v1, still open):**

- **Sheet vs. navigation stack.** Task row tap → sheet or push must be one gesture per surface,
  never both by context. v2 renders the converged flow but deliberately does not settle this
  (v1 `README.md:158-161`).
- **Turn rows.** The "› Latest turn · 10 agents" row is a new kind of entity in the list. v2
  gives its tap a defined target (the task sheet's agent block, view only) — whether turns are
  ever expandable inline (a third nesting level on a 390px screen) remains open, and the mockup
  still says no.
- **Keyboard vs. bottom sheet.** Steer composer + sheet + keyboard leaves ~200px of timeline on
  small phones; detents and dismissal gestures multiply the states. v2 renders one tall detent
  and does not attempt the half-detent question.
- **Gesture conflicts.** Android's back gesture vs. swipe-to-dismiss on the sheet vs.
  horizontal swipes on list rows needs a deliberate mapping; the mockups hand-wave it with
  click-to-dismiss (which in v2 navigates back to flow 1).

**Data gaps (unresolved by construction):**

- **Cross-level rollup.** The disclosure chip ("1 task · 10 agents") joins task counts with
  agent counts across a task's turns — a per-thread rollup the list payload doesn't compute.
- **Turn identity in the list.** "Latest turn" needs a turn ordinal/recency per task; agents
  carry opaque turn ids today, and only the latest turn is surfaced.
- **✓/× counters.** Per-turn outcome counts need agents grouped by turn with terminal status —
  available per-turn in the transcript, not as a list-level aggregate. v2 adds the cancelled
  case ("✓ 6 / ⊖ 4"), which extends the same gap to cancelled-as-terminal-state.
- **↩ semantics on a working row.** The reference shows ↩ on rows that are still working (a
  task returned intermediate results); the exact lifecycle ("returned" vs. "returned and woke
  parent") needs contract clarity. Encoded as-is in both versions.
- **Push-notification parity.** A task waking its parent while the phone is locked is the
  mobile headline moment; the wake event has no user-visible flag and the list's unread state
  has no cold-start semantics. v2 renders the unread _marker_ (dot + word) but cannot say what
  sets or clears it — there is no "mark as read" gesture to model without inventing one.
- **Agent → transcript lookup.** "Show in transcript" needs an agent → (thread, turn, card-row)
  mapping the client doesn't maintain, complicated by virtualized feeds. v2's agent sheet links
  to the owning task's thread view; it does not and cannot deep-link the specific card row.
