# Flow 2 — Bottom-sheet peek — design notes

The middle of the converged v2 flow (thread list → **bottom-sheet peek** → full task view),
carried forward from v1's option 2. Tapping a task or turn row slides up a glass bottom sheet
over the list; the sheet keeps v1's anatomy verbatim: status line → title → chips → mini
timeline (prompt bubble, latest activity, wake/fail event line) → the turn's agent rows →
actions → composer. This page renders the sheet open — the screen _is_ the sheet, over a static
facsimile of flow-1's list.

The two bodies stay honestly different, per the desktop 2A recommendation v1 followed:

- **Task sheet** — chips: creator (`✦ agent` / `you`), context (`full thread context` /
  `2 selected messages`), model (`Opus 4.7`), and on finished tasks `↩ returned · woke parent`.
  A **Cancel task** action while running, an **enabled "Steer this task…" composer**, and
  **"Open thread ↗"** in the header — now a real link to `flow-3-task`.
- **Native agent sheet** — identical frame, but chips carry `agent · runs in the task session`,
  the subagentType (`Explore`), a usage triple on `.chip.danger`, and a model chip **derived
  from the parent** (`inherits task · Opus 4.7` — natives have no model of their own). The
  composer is present but **disabled with the reason spelled out in words**, there is no
  Cancel, and the header action becomes **"Show in transcript"**, linking to the owning task's
  thread view (agents run inside the task's session, so that is where the run lives).

The exact disabled-composer wording, carried verbatim from v1 and treated as a spec string:

> Runs inside the task’s session — to stop it, interrupt the task’s turn.

## Deep links

All params are read once from `location.search`; unknown values fall back to the default sheet,
never a blank page. `?theme=` is preserved across **every** outgoing link.

| Param     | Values                             | Renders                                                                                                                                                                                  |
| --------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `?theme=` | `dark` · `light` (absent = system) | Pins the page theme on `<html>`                                                                                                                                                          |
| `?sheet=` | `task` (default)                   | The mockups task, working · 8s, 10-agent turn (✓ 6 × 4, each failure reasoned), Cancel, enabled steer composer                                                                           |
|           | `apk`                              | Done task · 19m, returned chip, 3-agent turn (✓ 2 × 1, failed row reasoned)                                                                                                              |
|           | `local`                            | Done task · 59s, created by `you` from 2 selected messages, returned chip, no agents                                                                                                     |
|           | `login`                            | Working task · 24s, created by `you`, Cancel, enabled composer                                                                                                                           |
|           | `a4`                               | **Failed in-session agent** — the non-steerable case: same anatomy, `native` chip, danger usage chip, failure sentence, disabled composer with the reason in words, "Show in transcript" |
| `?task=`  | same ids — **alias of `?sheet=`**  | The id flow-1's task/turn rows emit when they open a sheet; `?sheet=` wins if both are present (added in reconciliation, `_reports/T7.md` item A)                                        |

Outgoing wiring (the flow is real, not decorative):

- Dismiss (dim, grabber, ✕, Escape) → `../flow-1-list/index.html?peek=<row>` — the row that
  owns the open sheet stays highlighted (`a4` returns to `peek=task`, its owning task).
- "Open thread" on a task sheet → `../flow-3-task/index.html?task=<id>` (`task` / `apk` /
  `local` / `login`).
- "Show in transcript" on the agent sheet → `../flow-3-task/index.html?task=task` (the owner).
- `← v2 index` furniture → `../index.html`.
- Tapping a list sub-row switches sheets in place and updates the address-bar `?sheet=` via a
  guarded `history.replaceState` (file:// history APIs may throw; cosmetic only).

- **Optimises for:** parity with the accepted desktop design at mobile interaction cost. One
  sheet anatomy for both kinds of parallel work; the capability difference is stated in words
  exactly where the user looks for it (the composer), never carried by styling alone. Sheets
  are also the phone-native way to preview-without-navigating: the thread list stays
  underneath, one flick dismisses — and in v2 that dismissal actually returns somewhere (flow
  1, row still lit).
- **Gives up:** the desktop window's anchor. A floating card with a caret points back at its
  row; a full-width sheet covers the list, so the user loses the visual link between row and
  peek (mitigated weakly by the picked-row highlight staying lit under the dim). It also gives
  up side-by-side glanceability — the sheet and the transcript can never be visible together.
- **Strongest objection:** a sheet is a modal dead end for the one action that matters on a
  task — steering. Typing a steer message inside a sheet that then has to be dismissed to
  return to the parent thread is a worse loop than desktop's peek-and-type, and if the user
  wanted to _watch_ a running task while steering, the sheet must either grow to full height
  (becoming flow 3's full task view with extra steps) or be abandoned. The sheet risks being a
  preview nobody keeps open. v2's wiring sharpens this: "Open thread" is one tap away and
  lands on a real page, which may be where steering should have lived all along.

## What changed from v1's option 2

- **Failed agent rows carry their reason.** v1's sheet rows showed only a duration (`9s`) next
  to a red ⊗; v2 renders `failed — tool-use budget exceeded` in `.wsub` per CONVENTIONS §7.1.
  The mockups task's four failures and the APK turn's one failure all get it.
- **The disabled composer keeps full opacity.** v1's `.sh-composer.disabled { opacity: 0.65 }`
  drops the mandatory reason sentence to ≈2.6:1 in both themes (measured in CONTRAST.md's
  effective-contrast section) — an illegible explanation is nearly an unexplained one. Disabled
  now reads from the greyed send pill and `--dim` note text at full strength. (A page-local
  override at build time; reconciliation removed the opacity from the shared sheet itself —
  `_reports/T7.md` item C — and this page's `<style>` block is gone entirely.)
- **No hardcoded colors.** v1's `<b style="color:#d5d7de">` in the agents header is a token
  rule now. (Page-local at build time; `.sh-agents-head b` was promoted into `mockup.css` in
  reconciliation — `_reports/T7.md` item D.)
- **320px safety.** The shared `.sh-top` was nowrap; the agent sheet's status + "Show in
  transcript" + close would clip at 320px, so the header wraps instead. (Page-local at build
  time; the wrapping `.sh-top` was promoted into `mockup.css` in reconciliation —
  `_reports/T7.md` item D.)
- **The wiring is real.** v1's "Open thread" / "Show in transcript" / dismiss were inert; v2
  links them into the flow (above). Unowned furniture keeps chrome.html's `(mock)` toasts.

## Mobile-specific notes

- **Detents.** The mockup renders one tall detent (~84%). A real build wants a half detent for
  status + chips and a full detent for the timeline/composer — but two detents double the
  states the honest-composer layout has to survive.
- **Keyboard.** Opening the steer composer raises the keyboard over the sheet; on small phones
  the sheet + keyboard leaves ~200px of timeline. The desktop window never had this problem.
- **Chips wrap.** Four chips fit the desktop window's 352px; the sheet is 390px minus padding,
  so the usage triple + kind chip + type chip + inherited-model chip wrap to two lines. The
  inherited-model chip is the honest answer to "what model is this" and must survive the wrap.
- **Dismissal gestures.** Swipe-down on the grabber, tap the dim, the ✕, or Escape. Four
  dismissal paths plus a composer focus state is the classic sheet footgun (drag-to-dismiss
  fighting scroll-to-read); the mockup hand-waves it with click-to-dismiss — which in v2
  navigates back to flow 1, so nothing is lost by leaving.

## Data gaps (mobile-specific)

- **Sheet liveness.** The desktop window streams "latest activity"; over a phone connection
  (relay/tunnel, backgrounded app) a running sheet needs the same event stream with resume
  semantics, or it shows stale progress with no staleness marker.
- **Cancel confirmation.** "Cancel task" on a phone wants a confirmation step (destructive, no
  undo) — the desktop window's single click doesn't translate directly; an action-sheet
  confirmation adds a second sheet layer the design doesn't show.
- **Interrupt-the-parent discoverability.** The disabled composer names the only stop
  mechanism for natives, but "interrupt the task's turn" requires navigating to the task's
  thread and finding the stop button — a multi-step path the sheet can't shortcut without
  implying a per-native cancel that doesn't exist. v2's "Show in transcript" at least lands
  the user on the right thread.
