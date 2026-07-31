# Option 1 — Thread list with expanded task/agent groups — design notes

The shipped Android thread list (traced from `../reference-mobile.png`: T3 Code · ALPHA header,
filter/settings circle buttons, "Search threads" field, hairline-separated rows, compose FAB,
gesture bar) with the desktop sidebar's accepted tasks/agents language grafted onto the two
threads that have fan-out:

- **Add Wayfinder Constellation Sidebar View** — expanded parent row: repo icon + path, clock
  icon + "✓ Settle" pill right-aligned, bold title, `dev` + disclosure chip "⌄ 1 task ·
  10 agents" + coral provider glyph. Under it, indented on a guide line: the task row (blue
  asterisk, "Create 4 mockups for the mobile app based on th…", 8s) and nested one level deeper
  the task's turn row ("› Latest turn · 10 agents" with green ✓ 6, red × 4, blue ↩).
- **Fix T3 Connect Redirect Error** — chip "⌄ 3 tasks"; sub-rows "⌄ Build a standalone,
  installable Android APK of t…" (19m, ↩), "✓ is it possible to build locally?" (59s, ↩), and
  blue-asterisk "the t3 connect is not letting log in" (24s, ↩).

All other rows are the real rows from the screenshot, unchanged. Deep link:
`?peek=task|turn|apk|local|login` highlights that sub-row on load.

Icon semantics encoded from the reference: blue asterisk = working, green ✓ = done, chevron
(⌄/›) = expandable / has nested turn, blue ↩ = returned results / woke parent, "✓ n × m" =
per-turn agent outcomes. Tapping states the honest outcome in words via toast: tasks open (sheet
or thread); the turn row is view only — its agents run inside the task's session.

- **Optimises for:** zero new chrome. The list keeps the shipped app's anatomy pixel-for-pixel;
  fan-out lives entirely in row furniture (chip, sub-rows, markers) that the desktop sidebar
  already validates. The disclosure chip restates the split in the product's own words — "1
  task · 10 agents" — so the hierarchy is legible before any interaction, with no hover to lean
  on.
- **Gives up:** vertical space on the smallest surface we have. Two expanded groups plus the
  eight real rows overflow the viewport; collapsed groups hide running work behind a second tap.
  And a row tap must navigate or sheet — there is no preview gesture on a list row.
- **Strongest objection:** a navigation list is the wrong place to watch live work. Ticking
  seconds ("8s", "24s") and a ✓/× counter that changes mid-stream invite parking on the list as
  a dashboard, which a per-event re-rendered mobile list is bad at — the desktop mockups
  rejected metrics-at-rest for the same reason.

## Mobile-specific notes

- **No hover.** Desktop peeks on hover; mobile must pick tap = sheet (option 2) or tap =
  navigate (option 4). This variant stays agnostic — the rows' job is grouping and honesty.
- **Turn rows are a new entity.** "› Latest turn · 10 agents" is neither thread nor task; its
  tap target is undefined in the real app. Here it maps to the task sheet's agent block. Whether
  turns ever expand inline (a third nesting level on 390px) is open — the mockup says no.
- **Row furniture budget.** The expanded parent row carries clock + Settle + chip + glyph — four
  accessories on a row that normally has one. It fits only because the parent is expanded; the
  collapsed state must shed the chip's contents into "1 task · 10 agents" alone.
- **↩ on working rows.** The reference shows ↩ next to "24s" (still running) — returned markers
  are not terminal. The mockup encodes that as-is; contracts need to say what non-terminal
  "returned" means.

## Data gaps (mobile-specific)

- **Cross-level rollup.** "1 task · 10 agents" joins task count with agent count across the
  task's turns — a per-thread aggregate the list payload doesn't compute today.
- **Turn identity.** "Latest turn" needs turn recency per task; agents carry opaque turn ids,
  and only the latest turn is surfaced in the list.
- **✓/× counters.** Per-turn outcome counts need agents grouped by turn with terminal status —
  available per-turn in the transcript, not as a list-level aggregate.
- **Push parity.** A task returning results while the phone is locked should arguably notify;
  nothing in the return/wake event says whether it's user-visible, and the list has no
  cold-start unread semantics.
