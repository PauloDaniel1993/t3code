# Mobile tasks — mockup handoff

Static HTML mockups of how **tasks (sub-threads)** and their turns' provider-native **agents**
surface in the T3 Code mobile app. This is the input for planning and refinement — not an
implementation.

The mockups are traced from two references:

1. **`reference-mobile.png`** (in this directory) — the real T3 Code Android app: status bar,
   "T3 Code · ALPHA" header with filter/settings buttons, "Search threads" field, thread rows
   (repo icon + path, time-ago / blue "Working", bold title, branch, provider glyph, green
   "#10" badges), compose FAB, gesture bar.
2. **The desktop/web sidebar's tasks/agents UI** (not embeddable) — the accepted fan-out visual
   language: expanded parent row with clock + "✓ Settle" pill, disclosure chip ("⌄ 1 task ·
   10 agents"), guide-line sub-rows, blue-asterisk working / green ✓ done / chevron expandable
   icons, right-aligned elapsed + blue ↩ returned markers, and a task's "› Latest turn ·
   10 agents" row with ✓ 6 / × 4 outcome counters.

Open `index.html` directly in a browser (works over `file://`, no server, no build).

## Files

- `index.html` — landing page linking the four variants, with deep-link params.
- `reference-mobile.png` — the Android app screenshot the chrome is traced from.
- `mockup.css` — shared stylesheet: design tokens + Android chrome + tasks/agents row anatomy.
- `option-1-sidebar/` — thread list with expanded groups (`?peek=task|turn|apk|local|login`).
- `option-2-bottom-sheet/` — bottom-sheet peek (`?sheet=task|apk|local|login|a4`).
- `option-3-in-thread/` — in-thread agent card + pinned parallel-work card (`?open=1`).
- `option-4-full-thread/` — task as full thread + parent Agents tab (`?view=parent|task`,
  `?tab=chat|agents`).
- `README.md` — per-variant trade-offs, recommendations, data-gap analysis.
- `HANDOFF.md` — this file.

## Scenario captured in the mockups

From the reference screenshots, no invented threads:

- **Add Wayfinder Constellation Sidebar View** (`pingdotgg/t3code`, dev, Claude Code /
  Opus 4.7) — expanded; chip "⌄ 1 task · 10 agents".
  - Task "Create 4 mockups for the mobile app based on th…" — working 8s, agent-created, full
    thread context; its **latest turn has 10 agents: ✓ 6 completed, × 4 failed** (tool-use
    budget), ↩ returned.
- **Fix T3 Connect Redirect Error** (`pingdotgg/t3code`, dev, 13h) — chip "⌄ 3 tasks":
  "Build a standalone, installable Android APK of t…" (19m, ↩, nested turn), "is it possible to
  build locally?" (✓ done, 59s, ↩), "the t3 connect is not letting log in" (working, 24s, ↩).
- The remaining list rows are the real rows from the app screenshot (Build Standalone Android
  APK, Add Task Transformation to Threads, Assess Local Build Feasibility, both Finish Durable
  Chat rows with #10, Fix T3 Connect Login = Working).

## Semantics to carry into a mobile implementation

- **Hierarchy: thread → tasks → a task's turn → that turn's agents.** The list surfaces three
  levels (thread, task, turn summary); individual agents live in the transcript card, the sheet,
  or the Agents tab.
- **Tasks are full threads** (own session/provider), linked to their parent. On mobile they are
  pushable views with normal thread chrome and a steer composer — special casing is limited to
  provenance (creator, context) and the back target.
- **Agents are view-only, structurally.** They run inside a task's (or thread's) session: no
  steer composer (a disabled one states why in words), no cancel, no model of their own
  ("inherits task · Opus 4.7"), terminal action "Show in transcript". The vocabulary is
  "agents", with "runs in the task's session" as the clarifying subtitle.
- **Status language** (from the reference): blue asterisk = working, green ✓ = done, red × =
  failed, chevron = expandable, ↩ = returned results / woke parent, "✓ n × m" = per-turn agent
  outcomes.
- **The parent row's furniture** — clock (reminders), "✓ Settle" pill, disclosure chip — ships
  only on rows with fan-out; idle rows keep the shipped app anatomy.
- **Recommended composition** (see README): option 1 for navigation, option 2 for peek, option
  4's pushed view for acting on tasks; options 3 and 4's Agents tab are upgrades.

## Open questions for planning (mobile)

- **Tap semantics per row kind.** Sheet (option 2) or push (option 4)? One gesture per surface;
  deliberately unresolved in the mockups.
- **Turn rows as list entities.** What does tapping "› Latest turn · 10 agents" do, and are
  turns ever expandable inline (a third nesting level on 390px)?
- **↩ lifecycle.** Rows show ↩ while still working — is that "returned intermediate results"?
  What are the exact contract states?
- **Rollups.** The disclosure chip and ✓/× counters need per-thread task+agent aggregates the
  list payload doesn't compute today.
- **Push notifications for wakes.** Which returns are user-visible, and what does opening the
  notification deep-link to?
- **Back-stack depth.** List → parent → task, each a pushed view; the back affordance must
  disambiguate "parent thread" from "thread list".
- **Live subscriptions on a phone.** List rows, sheets, and the Agents tab all stream running
  state; over relay/tunnel with backgrounding, each needs resume semantics or a staleness
  marker.
- **Likely touchpoints to investigate**: `apps/mobile` thread list, thread feed, and composer;
  `packages/client-runtime` shared thread/agent selectors; `packages/contracts` session, task,
  and agent (worker) event schemas; the server's wake/result delivery for a user-visible flag.
