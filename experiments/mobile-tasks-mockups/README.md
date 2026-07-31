# Mobile tasks — mockups

Static HTML mockups of how **tasks** and their turns' **agents** surface in the T3 Code mobile
app (Android, dark). Companion to `../thread-tasks-mockups/` and `../subagent-view-mockups/`;
reuses their dark theme tokens via a shared `mockup.css`.

**References.** These mockups are traced from two screenshots:

1. **`reference-mobile.png`** (in this directory) — the real T3 Code Android app: status bar
   (11:31 · 5G · 81%), "T3 Code" header with a gray ALPHA pill and circular filter/settings
   buttons, a "Search threads" field, hairline-separated thread rows (repo icon + path, time-ago
   or blue "Working", bold title, branch, provider glyph, occasional green "#10" badge), a white
   compose FAB, and the gesture home bar.
2. **The desktop/web sidebar's tasks/agents UI** (not embeddable) — the accepted visual language
   for fan-out: an expanded parent row with a clock icon + "✓ Settle" pill and a disclosure chip
   ("⌄ 1 task · 10 agents"); indented sub-rows under a guide line — a task row (blue asterisk =
   working, green ✓ = done, chevron = expandable) with right-aligned elapsed time and a blue ↩
   returned marker; nested one level deeper, the task's "› Latest turn · 10 agents" row with
   per-turn outcome counters (green ✓ 6, red × 4) and a ↩ marker.

**The model.** Hierarchy is **thread → tasks → a task's turn → that turn's agents**. Tasks are
real sub-threads: own session, steerable, cancellable, durable, and they return results to the
parent (↩, which wakes it). Agents are provider-native runs inside a task's (or thread's)
session: they cannot be steered or cancelled independently, have no model of their own, and
today surface only as a card in the transcript. The product vocabulary in this UI is **"tasks"
and "agents"** — with a clarifying "runs in the task's session" subtitle wherever honesty
requires it. **Affordance honesty** still applies: an agent must never look steerable or
cancellable; the difference is structural or spelled out in words, never styling alone.

## Viewing

Open `index.html` directly in a browser (works over `file://`, no server, no build). Deep links:

- Option 1: `?peek=task|turn|apk|local|login` highlights that sub-row.
- Option 2: `?sheet=task|apk|local|login|a4` opens that bottom sheet (`a4` is a failed agent;
  default `task`).
- Option 3: `?open=1` shows the pinned parallel-work card expanded.
- Option 4: `?view=parent|task` and `?tab=chat|agents` pick the view and tab.

## Files

- `index.html` — landing page linking the four variants.
- `reference-mobile.png` — the Android app screenshot the chrome is traced from.
- `mockup.css` — shared stylesheet: desktop mockup tokens + the Android chrome (status bar,
  T3 Code · ALPHA header, search field, FAB, gesture bar) + the tasks/agents row anatomy
  (disclosure chips, guide-line sub-rows, turn counters, Settle pill).
- `option-1-sidebar/` — thread list with expanded task/agent groups + `NOTES.md`.
- `option-2-bottom-sheet/` — bottom-sheet peek + `NOTES.md`.
- `option-3-in-thread/` — in-thread agent card + pinned parallel-work card + `NOTES.md`.
- `option-4-full-thread/` — task as full thread + parent Agents tab + `NOTES.md`.
- `HANDOFF.md` — the planning handoff.

## Shared scenario

Taken from the reference screenshots — no invented threads. The surrounding list rows ("Build
Standalone Android APK" 13h, "Add Task Transformation to Threads" 11h, "Assess Local Build
Feasibility" 14h, both "Finish Durable Chat…" rows 15h #10, "Fix T3 Connect Login" Working) are
the real rows from the app screenshot.

- **Add Wayfinder Constellation Sidebar View** (`pingdotgg/t3code`, dev, Claude Code / Opus 4.7)
  — expanded: clock + ✓ Settle pill, chip "⌄ 1 task · 10 agents".
  - **Task** — "Create 4 mockups for the mobile app based on th…", working 8s, agent-created,
    full thread context.
    - **Latest turn · 10 agents** — ✓ 6 completed, × 4 failed (tool-use budget), ↩ returned.
- **Fix T3 Connect Redirect Error** (`pingdotgg/t3code`, dev, 13h) — chip "⌄ 3 tasks".
  - "⌄ Build a standalone, installable Android APK of t…" — 19m, ↩ (has a nested turn).
  - "✓ is it possible to build locally?" — done, 59s, ↩.
  - blue asterisk "the t3 connect is not letting log in" — working, 24s, ↩.

The 10 agents of the mockups task (6 ✓ / 4 ×) are named in option 2/3/4 ("Map screenshot chrome
regions", "Reproduce provider glyph set", …); token/tool figures on the Agents tab are realistic
for Explore/general-purpose runs of a few seconds.

---

## Option 1 — Thread list, expanded groups

The app's real thread list, with the desktop sidebar's tasks/agents language grafted on:
expanded parent rows (clock + Settle pill + disclosure chip), guide-line sub-rows for tasks, a
task's turn nested one level deeper with ✓/× counters and the ↩ returned marker.

- **Optimises for:** zero new chrome — the list keeps the shipped app's anatomy exactly, and
  fan-out is expressed entirely in row furniture the desktop sidebar already validates.
- **Gives up:** vertical space; two expanded groups plus eight real rows overflow the viewport,
  and there is no preview gesture — a row tap must navigate or sheet.
- **Strongest objection:** a navigation list is the wrong place to watch live work; ticking
  seconds ("8s", "24s") invite parking on the list as a dashboard, which a per-event
  re-rendered mobile list is bad at.

## Option 2 — Bottom-sheet peek

Glass bottom sheet over the dimmed list. Task sheet: chips (creator · context · model ·
↩ returned), prompt, latest activity, the task's turn block listing its agents with ✓/×
counters, Cancel while running, enabled steer composer, "Open thread". Agent sheet: same
anatomy, composer disabled with the reason in words ("Runs inside the task's session — to stop
it, interrupt the task's turn"), "Show in transcript".

- **Optimises for:** preview without navigating, one flick to dismiss; the honesty carried in
  words at the composer, exactly where the desktop 2A design put it.
- **Gives up:** the anchor back to the row (the sheet covers the list) and any side-by-side
  view of sheet + transcript.
- **Strongest objection:** a modal sheet is a dead end for steering — typing inside a
  dismissible sheet that fights the keyboard is the classic Android footgun, and a user who
  wants to _watch_ a task while steering will abandon the sheet for option 4 anyway.

## Option 3 — In-thread agent card + parallel-work card

The task thread's own feed: a provenance event row ("Created as a task by …"), the turn's agent
card inline in the conversation, and a collapsible "Parallel work" card pinned above the
composer. Agent rows are view only; tapping one scrolls the feed and flashes its card row.

- **Optimises for:** ambient awareness at zero navigation cost — the card lives where the user
  already is, and collapses to one line ("Parallel work · 10 agents · ✓ 6 × 4").
- **Gives up:** composer-neighborhood real estate; expanded, ten agent rows plus the keyboard
  leave almost no transcript visible.
- **Strongest objection:** the pinned card duplicates the feed's own agent card, and the two
  can disagree mid-stream; the flash-the-feed gesture scrolls the user away from the composer
  they were typing in.

## Option 4 — Full task thread + Agents tab

A task opens as a normal pushed thread view (own transcript, steer composer, parent as back
target). The parent thread gains a Chat / Agents segmented control; Agents lists the ten agents
read-only, grouped under their task's turn, each with usage stats and "Show in transcript".

- **Optimises for:** the navigation stack where it's honest — tasks get full thread UI because
  they _are_ threads; agents get a structurally separate tab where read-only is the
  architecture, not a disabled control.
- **Gives up:** peeking entirely — every inspection is a navigation.
- **Strongest objection:** the Agents tab is a graveyard with good typography — a read-only list
  whose single action bounces you out of the tab, training its own abandonment.

---

## Recommendations

Consistent with the desktop picks (split section, honest composer), adapted per surface:

- **Navigation (thread list) → Option 1.** It costs the shipped app nothing structurally and
  carries the desktop sidebar's validated language. Ship expanded state only for threads with
  live or unread fan-out; idle threads collapse to the disclosure chip.
- **Preview / inspect → Option 2.** The sheet is the phone-native answer to the peek window.
  Keep the honesty rules verbatim: same anatomy for tasks and agents, disabled composer with the
  reason in words, "Show in transcript" for agents.
- **In-thread awareness → Option 3, collapsed by default.** The pinned card is the cheapest
  always-on indicator inside a task thread. It complements option 1: the list is where you _go_,
  the card is where you _are_.
- **Deep work → Option 4's task view is non-negotiable** (a task is a real thread; "Open thread"
  must land somewhere). The Agents tab half is optional — the best home for per-agent usage
  stats, but the in-feed agent card + option 2's sheet cover the honest minimum.

The four are complementary surfaces, not competitors: 1 = find, 2 = glance, 3 = ambient, 4 =
act. The smallest honest ship is 1 + 2 + 4-task-view; 3 and 4-agents-tab are upgrades.

## Data gaps / mobile-specific gaps

Desktop gaps from `../subagent-view-mockups/` (no per-message agent transcript, rolling
`progressSummary`, optional usage counters, no capability descriptor) still apply. Mobile adds:

**Interaction gaps:**

- **Sheet vs. navigation stack.** Task row tap → sheet (option 2) or push (option 4) must be one
  gesture per surface, never both by context. The mockups deliberately leave it unresolved.
- **Turn rows.** The "› Latest turn · 10 agents" row is a new kind of entity in the list —
  tapping it needs a defined target (the task sheet's agent block in these mockups). Whether
  turns are expandable inline (a third nesting level on a 390px screen) is open.
- **Keyboard vs. bottom sheet.** Steer composer + sheet + keyboard leaves ~200px of timeline on
  small phones; detents and dismissal gestures multiply the states.
- **Gesture conflicts.** Android's back gesture vs. swipe-to-dismiss on the sheet vs. horizontal
  swipes on list rows needs a deliberate mapping.

**Data gaps:**

- **Cross-level rollup.** The disclosure chip ("1 task · 10 agents") joins task counts with
  agent counts across a task's turns — a per-thread rollup the list payload doesn't compute.
- **Turn identity in the list.** "Latest turn" needs a turn ordinal/recency per task; agents
  carry opaque turn ids today, and only the latest turn is surfaced.
- **✓/× counters.** Per-turn outcome counts need agents grouped by turn with terminal status —
  available per-turn in the transcript, not as a list-level aggregate.
- **↩ semantics on a working row.** The reference shows ↩ on rows that are still working (a task
  returned intermediate results); the exact lifecycle ("returned" vs. "returned and woke
  parent") needs contract clarity.
- **Push-notification parity.** A task waking its parent while the phone is locked is the mobile
  headline moment; the wake event has no user-visible flag and the list's unread state has no
  cold-start semantics.
- **Agent → transcript lookup.** Options 2–4 need "Show in transcript": an agent → (thread,
  turn, card-row) mapping the client doesn't maintain, complicated by virtualized feeds.
