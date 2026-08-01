# Flow 1 — Thread list with expanded task/agent groups — design notes

Carried forward from v1's option 1 (`../../mobile-tasks-mockups/option-1-sidebar/`, frozen): the
shipped Android thread list (T3 Code · ALPHA header, filter/settings circle buttons, "Search
threads" field, hairline-separated rows, compose FAB, gesture bar) with the tasks/agents
language grafted onto the two threads that have fan-out. v2 keeps v1's anatomy row-for-row and
wires it into the converged three-screen flow:

- **Add Wayfinder Constellation Sidebar View** — expanded parent row: repo icon + path, clock
  icon + "✓ Settle" pill right-aligned, bold title, `dev` + disclosure chip "⌄ 1 task ·
  10 agents" + coral Claude glyph. Under it, indented on a guide line: the task row (blue
  asterisk, "Create 4 mockups for the mobile app based on th…", 8s) and nested one level deeper
  the task's turn row ("› Latest turn · 10 agents" with green ✓ 6, red × 4, blue ↩).
- **Fix T3 Connect Redirect Error** — chip "⌄ 3 tasks"; sub-rows "⌄ Build a standalone,
  installable Android APK of t…" (19m, ↩), "✓ is it possible to build locally?" (59s, ↩), and
  blue-asterisk "the t3 connect is not letting log in" (24s, ↩).

All other rows are the real rows from the screenshot, unchanged.

What changed from v1 (all consequences of becoming the flow's entry screen):

- **Rows navigate now.** A task sub-row opens the peek sheet
  (`../flow-2-peek/index.html?task=<id>`); each task row also carries a trailing ↗ "Open thread"
  link to the full task view (`../flow-3-task/index.html?task=<id>`); the turn row opens its
  task's peek sheet, where the turn's agents are view only. v1's toast ("Opens the task — peek
  sheet or full thread") is replaced by the real two-path wiring. Plain thread rows still toast,
  honestly: the parent-thread view is not part of this flow's mockups.
- **Groups collapse.** The disclosure chip is a real toggle: the guide-line sub-rows hide, the
  chevron flips ⌄→›, and the Wayfinder parent sheds clock + Settle back to the plain "3h"
  time-ago — exactly the shedding v1's NOTES said the collapsed state required. Deep-linkable as
  `?groups=collapsed`; default (and `?groups=expanded`, or any unknown value) is v1's
  always-expanded rendering. `?peek=` re-opens the group containing the highlighted row.
- **The failure reason rides the list.** The turn row's `× 4` keeps v1's counter form (the
  per-agent reasons live one tap away in the peek sheet), but the shared reason is now stated in
  words on the row: the counter's tooltip reads "4 agents failed — tool-use budget exceeded" and
  the turn row's tooltip carries the full sentence. All four failures share one reason, so one
  phrase is honest, not lossy.
- **Provider glyphs are all titled** ("Claude Code" / "Codex") — v1 titled only some rows.
- v1's dead `selected` class on the expanded parent is dropped (nothing overlays this page, so
  it has no selected row to mark; the class has since been restored to the shared sheet in
  reconciliation for flow-2's backdrop row — `_reports/T7.md` item D).

- **Optimises for:** zero new chrome, and now zero dead ends. The list keeps the shipped app's
  anatomy pixel-for-pixel; fan-out lives entirely in row furniture (chip, sub-rows, markers)
  that the desktop sidebar already validates. The disclosure chip restates the split in the
  product's own words — "1 task · 10 agents" — so the hierarchy is legible before any
  interaction, with no hover to lean on. Every nested row goes somewhere real: peek first, full
  thread one tap behind it.
- **Gives up:** vertical space on the smallest surface we have — though collapse now gives it
  back, at the cost of hiding running work behind a second tap. And the ↗ link spends ~20 px of
  row width on every task row to keep the third screen reachable without opening the sheet
  first.
- **Strongest objection:** a navigation list is still the wrong place to watch live work.
  Ticking seconds ("8s", "24s") and a ✓/× counter that changes mid-stream invite parking on the
  list as a dashboard, which a per-event re-rendered mobile list is bad at. Collapse makes this
  worse before it makes it better: the cheap way to stop the noise is to hide the work entirely.

## Deep-link parameters

| Param      | Values                                      | Default    | What it renders                                                                                                                                                                                                        |
| ---------- | ------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `?theme=`  | `dark` · `light`                            | system     | Pins `data-theme` on `<html>`; absent follows the OS. Preserved across every internal link (anchors rewritten on load; JS navigations append it).                                                                      |
| `?peek=`   | `task` · `turn` · `apk` · `local` · `login` | none       | Highlights that sub-row (`.picked` + page-local pulse) and scrolls it into view; re-opens its group first if `?groups=collapsed` hid it. Unknown values fall back to the default rendering. Ids are v1's `data-unit`s. |
| `?groups=` | `collapsed` · `expanded`                    | `expanded` | `collapsed` renders both groups closed: sub-rows hidden, chip chevrons flipped ›, the Wayfinder parent shows "3h" instead of clock + Settle. Any other value renders expanded.                                         |

Onward links emitted by this page (ids are the same `data-unit` ids):

- task sub-row tap → `../flow-2-peek/index.html?task=task|apk|local|login`
- turn sub-row tap → `../flow-2-peek/index.html?task=task` (a turn lives in its task's sheet)
- ↗ "Open thread" → `../flow-3-task/index.html?task=task|apk|local|login`
- `← v2 index` → `../index.html`

## Mobile-specific notes

- **No hover.** v1 stayed agnostic about tap = sheet vs tap = navigate; the converged flow
  decides: task tap = sheet (flow 2), ↗ = navigate (flow 3). Tooltips remain only as the
  honesty channel for reasons — nothing essential is tooltip-only.
- **Turn rows are a new entity.** "› Latest turn · 10 agents" is neither thread nor task. In v1
  its tap was undefined; here it opens the task's peek sheet, whose agent block is the only
  place its agents render — view only there. Whether turns ever expand inline (a third nesting
  level on 390 px) is still no.
- **Row furniture budget.** The expanded parent carries clock + Settle + chip + glyph — four
  accessories on a row that normally has one. It fits only because the parent is expanded; the
  collapsed state sheds the chip's contents into "1 task · 10 agents" alone and restores "3h".
- **↩ on working rows.** The reference shows ↩ next to "24s" (still running) — returned markers
  are not terminal. Encoded as-is; contracts still need to say what non-terminal "returned"
  means.

## Data gaps (mobile-specific)

- **Cross-level rollup.** "1 task · 10 agents" joins task count with agent count across the
  task's turns — a per-thread aggregate the list payload doesn't compute today.
- **Turn identity.** "Latest turn" needs turn recency per task; agents carry opaque turn ids,
  and only the latest turn is surfaced in the list.
- **✓/× counters.** Per-turn outcome counts need agents grouped by turn with terminal status —
  available per-turn in the transcript, not as a list-level aggregate. The list shows the count;
  the reason per agent lives in the sheet.
- **Push parity.** A task returning results while the phone is locked should arguably notify;
  nothing in the return/wake event says whether it's user-visible, and the list has no
  cold-start unread semantics.
- **Link contract — resolved in reconciliation.** This page links onward with `?task=<id>`;
  flow-2 now accepts it as an alias of `?sheet=` and flow-3 as its task selector, so every hop
  this page emits resolves (CONVENTIONS.md §3 documents both; `_reports/T7.md` item A). Kept
  here as the record of why the id vocabulary is `task|apk|local|login` everywhere.
