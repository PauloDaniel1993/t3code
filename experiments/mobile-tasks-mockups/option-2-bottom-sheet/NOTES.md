# Option 2 — Bottom-sheet peek — design notes

The mobile replacement for the desktop mini thread window. Tapping a task or in-session agent
row (in the thread list, or the option-3 parallel-work card) slides up a glass bottom sheet with
a grabber, a dimmed backdrop, and swipe-to-dismiss — the standard iOS detent pattern. The sheet
_keeps the desktop window's anatomy verbatim_: status line → title → chips → mini timeline
(prompt bubble, latest activity, wake/fail event line) → actions → composer.

The two bodies stay honestly different, per the desktop 2A recommendation:

- **Task sheet** — chips: creator (`✦ agent` / `you`), context (`full thread context` /
  `3 selected messages`), model (`Opus 4.7`), and on finished tasks `↩ returned · woke parent`.
  A **Cancel task** action while running, an **enabled "Steer this task…" composer**, and
  **"Open thread ↗"** in the header.
- **Native agent sheet** — same frame, but chips carry `in-session agent`, the subagentType
  (`Explore` / `general-purpose`), a usage triple, and a model chip **derived from the parent**
  (`inherits parent · Opus 4.7` — natives have no model of their own). The composer is present
  but **disabled with the reason spelled out in words** ("Runs inside the parent session — to
  stop it, interrupt the parent turn"), there is no Cancel, and the header action becomes
  **"Show in transcript"**. Failed (W3) and retry (W4) states render in the same anatomy.

Deep link: `?sheet=t1|t2|t3|w1..w4` opens that sheet on load (`w2` running and `w3` failed are
the interesting non-defaults; default is `t1`).

- **Optimises for:** parity with the accepted desktop design at mobile interaction cost. One
  sheet anatomy for both kinds of parallel work; the capability difference is stated in words
  exactly where the user looks for it (the composer), never carried by styling alone. Sheets are
  also the phone-native way to preview-without-navigating: the thread list stays underneath, one
  flick dismisses.
- **Gives up:** the desktop window's anchor. A floating card with a caret points back at its
  row; a full-width sheet covers the list, so the user loses the visual link between row and
  peek (mitigated weakly by the picked-row highlight staying lit under the dim). It also gives
  up side-by-side glanceability — the sheet and the transcript can never be visible together.
- **Strongest objection:** a sheet is a modal dead end for the one action that matters on a
  task — steering. Typing a steer message inside a sheet that then has to be dismissed to return
  to the parent thread is a worse loop than desktop's peek-and-type, and if the user wanted to
  _watch_ a running task while steering, the sheet must either grow to full height (becoming
  option 4's full thread view with extra steps) or be abandoned. The sheet risks being a preview
  nobody keeps open.

## Mobile-specific notes

- **Detents.** The mockup renders one tall detent (~84%). A real build wants a half detent for
  status + chips and a full detent for the timeline/composer — but two detents double the states
  the honest-composer layout has to survive.
- **Keyboard.** Opening the steer composer raises the keyboard over the sheet; on small phones
  the sheet + keyboard leaves ~200px of timeline. The desktop window never had this problem.
- **Chips wrap.** Four chips fit the desktop window's 352px; the sheet is 390px minus padding,
  so the usage triple + kind chip + type chip + inherited-model chip wrap to two lines. The
  inherited-model chip is the honest answer to "what model is this" and must survive the wrap.
- **Dismissal gestures.** Swipe-down on the grabber, tap the dim, or the X. Three dismissal
  paths plus a composer focus state is the classic sheet footgun (drag-to-dismiss fighting
  scroll-to-read); the mockup hand-waves it with click-to-dismiss.

## Data gaps (mobile-specific)

- **Sheet liveness.** The desktop window streams "latest activity"; over a phone connection
  (relay/tunnel, backgrounded app) a running sheet needs the same event stream with resume
  semantics, or it shows stale progress with no staleness marker.
- **Cancel confirmation.** "Cancel task" on a phone wants a confirmation step (destructive, no
  undo) — the desktop window's single click doesn't translate directly; an action-sheet
  confirmation adds a second sheet layer the design doesn't show.
- **Interrupt-the-parent discoverability.** The disabled composer names the only stop mechanism
  for natives, but "interrupt the parent turn" requires navigating to the parent thread and
  finding the stop button — a multi-step path the sheet can't shortcut without implying a
  per-native cancel that doesn't exist.
