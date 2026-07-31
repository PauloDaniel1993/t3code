# Option 3 — In-thread lifecycle rows + pinned parallel-work card — design notes

The thread feed itself, on the phone. Two surfaces, both carried over from the desktop design:

1. **Quiet lifecycle event rows in the conversation** — `Agent created task · <title>`,
   `You created task · <title> · context: 3 selected messages`, and the info-blue wake row
   (`Task finished · <title> — 4 findings returned. Main thread resumed.`). These are the same
   rows as the desktop mockup, reflowed for a 390px column (they wrap to two lines instead of
   truncating).
2. **A collapsible "Parallel work" card pinned above the composer** — the mobile answer to "the
   sidebar is one back-button away and therefore invisible". Collapsed it is one line
   ("Parallel work · 3 tasks · 4 in-session · 4 running"); expanded it lists T1–T3 and W1–W4
   with the same split labels and status icons as option 1. Deep link `?open=1` shows it
   expanded.

Tap behavior preserves affordance honesty structurally: a **task row** navigates (it's a real
thread — option 4's view); a **native row** can't navigate anywhere because there is nowhere to
go, so it scrolls the feed and **flashes its row in the turn's workflow card** — the desktop
jump-to-transcript interaction, and the card's own section label says "view only" in words.

- **Optimises for:** ambient awareness at zero navigation cost. The pinned card is visible from
  the exact screen where the user is already watching the parent work, and it collapses to a
  single line when not needed — the cheapest possible always-on indicator that parallel work
  exists, on the surface where the wake row will appear anyway.
- **Gives up:** list space and composer proximity. Expanded, the card is nine rows sitting
  directly above the composer, competing with the keyboard for the same bottom-of-screen real
  estate; on a small phone the expanded card + keyboard leaves almost no transcript visible. It
  also duplicates the option-1 group — two surfaces showing the same seven units that must never
  disagree.
- **Strongest objection:** the card lies about liveness by omission. Pinned above the composer
  it reads as a control surface, but it is a summary that depends on the feed being scrolled to
  the bottom to feel current; a wake row can land _above_ the fold while the card below still
  shows "4 running". And its flash-the-transcript gesture scrolls the feed away from the
  composer the user was typing in — the honest native interaction is also the disruptive one.

## Mobile-specific notes

- **Pin vs. inline.** The card is pinned (always visible) rather than inline in the feed; inline
  would scroll away exactly when the user is deep in a long transcript. The cost is permanent
  composer-neighborhood occupancy.
- **Collapsed summary needs a rollup** ("4 running") — the same cross-kind count the option-1
  collapsed group needs; one computed field would serve both.
- **The wake row and the card race.** T1 finishing must update three things at once — the feed
  (new wake row), the card (T1 done, running count drops), and the option-1 list (blue dot).
  Over a relay connection these arrive as separate events; the mockup assumes they are
  atomically consistent.
- **Long transcripts.** Flashing a native's workflow-card row assumes the card is rendered;
  virtualized mobile lists unmount offscreen rows, so "scroll to it" needs the feed to materialize
  the target turn first — a real engineering cost the desktop list never paid.

## Data gaps (mobile-specific)

- **Card ordering.** Expanded, tasks and natives are split by kind (labels), so no cross-kind
  start-time join is needed — but the collapsed "4 running" count and the option-1 chip both need
  a cheap per-thread rollup that doesn't exist in the thread-list payload today.
- **Row identity for flashing.** The flash targets a worker's row inside a specific turn's
  workflow card; locating it needs a worker → (thread, turn, card-row) lookup the client doesn't
  currently maintain.
- **Unread vs. seen.** The blue dot on the option-1 row should clear when the user has seen the
  wake row; "seen" for a feed row on a phone (viewport visibility) is a different signal than
  desktop's click-to-open.
