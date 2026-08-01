# State matrix — every lifecycle state side by side — design notes

The deliverable v1 lacked. v1 rendered exactly one scenario across all four options — ten
agents, six done, four failed — so the rollup chips, counters, and failed-agent styling were
never rendered at any other cardinality. This page renders **every lifecycle state as a real
screen**, one phone per state, side by side on a single page, so a reviewer can verify the
coverage by inspection rather than inference. It is the evidence for the spec's requirements on
lifecycle states, non-steerability, honest rollups, and failure attribution.

Every state is a new **cardinality of the same scenario** (CONVENTIONS.md §7.6), not an invented
thread: the mockups task (`Create 4 mockups for the mobile app based on th…`, Wayfinder thread)
and the APK task (`Build a standalone, installable Android APK of t…`, redirect thread) carry
all seven states between them.

## The seven states

Each phone is one real rendering — an actual screen, not prose describing one. Deep links ring
the phone and scroll it into view; unknown values fall back to the plain page.

1. **Queued, not yet started** — `?state=queued`. Thread list, expanded Wayfinder group. The
   task row carries the dim clock (`.clk`, the shared queued icon) and the word **“Queued”** in
   dim text. There is **no turn row and no counters** — nothing has run, so there is no outcome
   to ratio. Reads quiet next to running (blue asterisk + ticking seconds), failed (red), and
   complete (green ✓). The disclosure chip says “1 task” — singular, and no agent count at all,
   since “1 task · 0 agents” would be a zero-count form.
2. **Exactly one agent** — `?state=single`. Thread list, expanded group, the turn that ran a
   single one of the ten (“Map screenshot chrome regions”). Every rollup surface reads singular:
   the chip “1 task · 1 agent”, the turn row “Latest turn · 1 agent”, the counter “✓ 1”. Never
   “1 agents”. The lone agent succeeded, so there is no × anywhere — the singular-wording case
   and the zero-failure case are checked at different cardinalities (here 1, there 10).
3. **Zero failures** — `?state=zero-fail`. Task sheet, the mockups task done with all ten
   agents succeeded. The agents-block head shows **“✓ 10” and nothing else** — no “× 0”, no red
   icon, no danger chip, no failed row anywhere on the screen, backdrop included (“✓ 10” on the
   turn row behind the sheet). A red indicator when nothing failed teaches the user to distrust
   the indicator. The composer is enabled and carries **no** note — the steerable case is
   unambiguous.
4. **All agents failed** — `?state=all-failed`. Task sheet, the APK task whose turn of three
   all failed. The head shows **“× 3” and nothing else** — no “✓ 0”, no green, no ↩ returned
   chip (nothing was returned). **Every failed row carries its own reason in words**
   (“failed — tool-use budget exceeded”, the terse form, plus the full sentence
   “✕ Tool-use budget exceeded in all 3 agents — no result was returned”). The failed task row
   in the list behind the sheet carries the terse reason too — a red icon alone is a bug. The
   composer is **disabled with the reason in words** and the offered action is **Retry task**:
   reconciliation converged failed tasks on flow-3's model — a stopped task has no in-flight
   turn to steer into (`_reports/T7.md` item E.4, pinned in CONVENTIONS.md §7.7). This page
   originally shipped it enabled, reading v1's "tasks steer, agents don't" the other way; the
   disagreement and its resolution are recorded in the two reports.
5. **Cancelled mid-flight** — `?state=cancelled`. Task sheet, the mockups task cancelled at 26s
   with four agents still in flight (the four that were retrying, per v1's narrative). Amber
   minus-in-circle (`.cancel-ic`, invented in CONVENTIONS §6), “Cancelled · 26s”, and the event
   row “Cancelled by you — 6 agents had finished, 4 were still running”. Counters split
   **✓ 6 / ⊖ 4** with **no red and no “failed”** — the in-flight agents never failed; they were
   stopped. Distinguishable from both completion (not all ✓, amber not green) and failure (no
   ⊗, no ×). The four in-flight rows say “cancelled — retry interrupted” in words. The composer
   is disabled **with the reason in words**: “Cancelled — the task is no longer running, so
   there is nothing to steer.”
6. **Result returned but unread** — `?state=unread`. Thread list, redirect thread. The APK
   task's ↩ came back since the user last looked: a **blue dot on the parent row** and the word
   **“unread”** on the task row. The sibling “is it possible to build locally?” row — done, ↩,
   read — renders in the same screen as the direct comparison: plain ↩, no dot, no word.
7. **Native in-session agent refusing steering** — `?state=native`. The agent sheet for
   “Reproduce provider glyph set” (a4), v1 option 2's exact treatment promoted to a first-class
   state: same sheet anatomy as a task, the steering composer **visibly unavailable AND the
   reason written next to it**: “Runs inside the task’s session — to stop it, interrupt the
   task’s turn.” A greyed control with no explanation is indistinguishable from a defect. Its
   failure also carries a reason (“✕ Tool-use budget exceeded before the sweep converged”).

## Deep links

| Param     | Values                                                                               | Behavior                                                                                                                                                                              |
| --------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `?theme=` | `dark` · `light` (absent = system)                                                   | v2 convention, pins `data-theme` on `<html>`; preserved across the backlink, the per-state permalinks, and the theme toggle                                                           |
| `?state=` | `queued` · `single` · `zero-fail` · `all-failed` · `cancelled` · `unread` · `native` | Rings the named phone (`.device.picked` outline — originated page-local, promoted into `mockup.css` in reconciliation) and scrolls it into view; unknown values render the plain page |

Each phone's caption carries a permalink for its state, and the toggle's Dark / Light / System
links preserve whichever `?state=` is active. The backlink to `../index.html` carries `?theme=`
forward.

## What could not be rendered honestly

Nothing — all seven states render as real screens. Three states required judgement calls the
conventions did not pin down (all recorded in `_reports/T6.md`): the unread marker's **form**
(“an unread marker on the parent” is specified, its shape is not — a blue dot + the word
“unread”, since `.tbadge`'s “#10” form is a per-thread number that cannot be invented); whether
a **cancelled** task accepts steers (conservatively: no — disabled with the reason in words);
and the all-failed **reasons** (the scenario's only established failure reason is
“tool-use budget exceeded”, so each of the three rows carries it — per-row attribution, no
invented causes).

- **Optimises for:** reviewability in one pass. The states the honesty rules name as
  defect-prone — queued, one, zero, all-failed, cancelled, unread, non-steerable — sit side by
  side at one URL, each in the surface where its risk lives (rollups on the list, failure
  attribution and composers on sheets), so the comparison a reviewer would otherwise have to
  assemble is already assembled. Consistency is enforced structurally: each sheet phone's
  backdrop list is adjusted to the phone's state (the zero-fail backdrop says ✓ 10, the
  cancelled backdrop says ✓ 6 / ⊖ 4), so no screen contradicts itself.
- **Gives up:** interaction. The sheets are statically open; nothing animates, dismisses, or
  navigates except the deep links. The flow between surfaces is flow-1/2/3's job — this page
  deliberately trades liveness for coverage. It also gives up the read/unread transition: the
  dot never clears, because there is no “mark as read” gesture to model without inventing one.
- **Strongest objection:** a matrix is not a product screen. No real screen shows seven phones,
  and the one-phone-per-state framing means each state is reviewed in isolation from the
  transitions that produce it — a reviewer can verify the renderings but not the lifecycle
  (what clears the unread dot, what a retry turns the all-failed sheet into). That gap is
  inherent to a state matrix; the flow pages own the transitions.

## Mobile-specific notes

- **The failure reason competes with the agent's name for the same row.** A `.wrow` is one
  line; “failed — tool-use budget exceeded” is ~180px of flex-none meta, so at 390px the name
  ellipsizes (“Locate Gradle w…”), and more at 320px. The full name + reason rides in the
  row's `title` attribute, and the native phone shows the same agent's full name in its sheet
  title. This is the honest layout compromise the attribution rule forces on a narrow row —
  recorded for the coordinator.
- **The cancelled counter has no glyph in the shared sheet — fixed in reconciliation.**
  `.cnt-ok` / `.cnt-fail` exist; a cancelled count did not. `.cnt-cancel` mirrors them with the
  amber minus-in-circle SVG inline (a “⊖” text glyph is font-dependent over file://). It
  originated page-local on this page and was promoted into `mockup.css` in reconciliation
  (`_reports/T7.md` item D), along with `.sh-evt.cancelled`, `.wrow.cancelled`, and the
  `.udot` / `.unread` unread indication.
- **Unread has no established marker.** v1's only unread form is `.tbadge` “#10”, a per-thread
  number. A dot + the word “unread” was chosen over inventing a badge number for the redirect
  thread; the dot's `title` spells out “1 unread result in this thread”.
- **Queued reuses `.clk`.** The same clock icon already means “snooze / reminders” in the
  expanded parent's `.tago` — two meanings for one glyph, inherited from v1 and noted in
  CONVENTIONS §5 (`.clk` is also the queued icon). On the sub-row the word “Queued”
  disambiguates; the icon alone would not.

## Data gaps (mobile-specific)

- **Unread semantics.** The dot and the “unread” word need a per-user read marker on returned
  task results — the same gap v1 recorded (“the list has no cold-start unread semantics”,
  option 1 NOTES; “‘seen’ for a feed row on a phone is a different signal than desktop's
  click-to-open”, option 3 NOTES). The mockup cannot say what clears it.
- **Cancelled rollup.** “✓ 6 / ⊖ 4” needs per-turn agents grouped by terminal state including
  cancelled — an extension of the ✓/× counter gap v1 recorded (counters exist per-turn in the
  transcript, not as a list-level aggregate).
- **Retry attribution.** The cancelled rows say “retry interrupted”, which presumes the client
  knows an agent run was a retry of a failed one. v1's narrative asserts retries; the data
  model's link between a failed run and its retry is not in any payload the mockups cite.
- **Steerability by state.** The page disables the composer for cancelled and failed tasks
  (reason in words, Retry offered) and leaves it enabled for done tasks — the model
  reconciliation pinned in CONVENTIONS.md §7.7. Which terminal states actually accept a steer,
  and whether a steer to a done task starts a new turn, is a product decision the mockups
  inherit rather than settle.
