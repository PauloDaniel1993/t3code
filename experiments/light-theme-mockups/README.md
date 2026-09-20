# Light theme rework — mockups

Four candidate reworks of the light ("white") theme. Static HTML, faithful to the current app
chrome (chat "New thread" hero + Settings > General, from the 2026-08 desktop screenshots).
**Only color values change** — geometry, typography, spacing, and layout are byte-identical
across variants, because every variant is just a different assignment to the same semantic
token block the app binds in `apps/web/src/index.css` (`:root` light, plus the
`[data-sidebar-version]` overrides).

## Viewing

Open `index.html` directly in a browser (works over `file://`, no server, no build).

- Keys `1`–`4` switch candidates, `0` shows the **current shipping palette** for comparison.
- Keys `c` / `s` switch between the Chat and Settings screens.
- Deep link: `?theme=a|b|c|d|0&screen=chat|settings`.

## Why the current theme reads as "unusable"

The shipping light palette puts every surface within ~2% lightness of white:

- `--background: zinc-25` (≈ `#fcfcfd`, 99.2% lightness) behind `--card: #fff` and a
  `--sidebar: zinc-50` (`#fafafa`) — background, content, and navigation are the same color
  for all practical purposes, so nothing has an edge.
- `--border: zinc-200` (`#e4e4e7`) at 1px is below the visibility floor on many displays,
  and the composer outline is `rgb(0 0 0 / 8%)` — structure you can only see by squinting.
- `--foreground: zinc-800` (`#27272a`) with `--muted-foreground: zinc-500` (`#71717a`, ~4.8:1
  on white) keeps both text tiers soft, so the hierarchy between title and metadata is weak.

Result: a white void where the sidebar, the page, the cards, and the composer all merge.

Each candidate fixes the same three things — surface separation, border visibility, text
contrast — along a different axis. The brand accent (`--primary`/`--ring`,
`oklch(0.488 0.217 264)`) and the status palette (success/warning/info/destructive) are
identical in all four, including the `0` baseline, to isolate the neutral ramp as the variable
under test. The dark sidebar brand strip in the mockups is the dev-channel **environment
artwork** (Settings → Environment identification → Artwork); it is stage art, not a theme
token, so it stays constant — whether light-mode artwork should exist is a separate question.

## The candidates

### 1 · Paper (`a`) — warm neutral

Chrome shifts to a warm paper gray (`#f6f5f1` page, `#efece5` sidebar), content surfaces stay
pure white, text goes warm near-black (`#1c1917` / `#5f594f`). The white composer and selected
rows now float visibly over the chrome.

- Optimises for: comfort over long sessions; the warm cast reads intentional, not "dirty monitor".
- Gives up: warmth is a taste commitment; screenshots/marketing in cool contexts clash slightly.

### 2 · Slate (`b`) — cool, maximum separation

Strongest chrome-to-content step (`#eceff4` page, `#dfe6ee` sidebar), darkest text
(`#0f172a` / `#475569`), most visible borders (`#c7d2df`). GitHub-light / Linear-adjacent.

- Optimises for: legibility and density — every edge is findable; best for lower-quality panels.
- Gives up: the grayest option; furthest from the "clean white" aesthetic some users want.

### 3 · Anchored White (`c`) — stays white, adds structure

Page and cards remain `#ffffff`; hierarchy comes from a gray sidebar (`#f3f3f5`), real borders
(`#d8d8dd`, composer outline at 15% black), darker text tiers (`#18181b` / `#52525b`), and a
slightly stronger composer shadow. The minimal-change fix.

- Optimises for: keeping the current identity — this is "the white theme, but you can see it".
- Gives up: the least surface separation; white-on-white means edges still do all the work.

### 4 · Porcelain (`d`) — faint blue tint

Chrome takes a cool blue-gray wash (`#eef2f8` page, `#e3eaf4` sidebar) in the same hue family
as the brand accent; content stays white; text is blue-black (`#17212f` / `#4c5a6e`).
Stripe-dashboard territory.

- Optimises for: cohesion with the accent — the tint makes the blue UI feel native to the surface.
- Gives up: tinted neutrals pollute color judgement (diffs, image attachments, syntax highlighting
  sit on a blue cast).

## Token mapping

Implementation is mechanical: each variant is one `:root` assignment block for the existing
names — `--background`, `--foreground`, `--card`, `--secondary(-foreground)`, `--muted(-foreground)`,
`--accent(-foreground)`, `--border`, `--input`, the seven `--sidebar-*` tokens, plus
`--app-scrollbar-thumb(-hover)` and the light `--chat-composer-outline`/composer shadow in
`index.css`. No component changes. The `[data-sidebar-version="v1|v2"]` light override block
duplicates the same ramp and must be updated (or collapsed into the root block) in the same pass.

## Open questions for review

- Warm (1) vs cool (2/4) vs neutral (3) is the real decision; contrast levels are all WCAG-AA+
  for body text (muted tier ≥ 6.3:1 everywhere vs ~4.8:1 today).
- Whether the composer outline becomes a token (variants use `--composer-outline`; today it's a
  hardcoded `rgb(0 0 0 / 8%)` in `.chat-composer-glass-shell`).
- Whether dev-channel artwork needs a light-mode variant (out of scope here).
