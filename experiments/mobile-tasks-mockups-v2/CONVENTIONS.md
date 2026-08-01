# v2 conventions — the contract for the four screen pages

This file is the contract for the sibling tasks building `flow-1-list/`, `flow-2-peek/`,
`flow-3-task/`, and `state-matrix/`. It exists so four pages built in parallel cannot drift.
Everything here is demonstrated live in `chrome.html` and derived from v1
(`../mobile-tasks-mockups/`), which is frozen.

## 1. `mockup.css` is the single shared sheet

During the parallel build this file was frozen and every shared-need stopgap had to be
page-local and reported. The reconciliation pass (see `_reports/T7.md`) then **promoted every
stopgap two or more screens needed into `mockup.css`** and deleted the page-local copies:
`.trow.selected`, `.sh-agents-head b`, the wrapping `.sh-top`, `.composer.disabled`'s greyed
send, `.evt.failed`, `.tail` / `.hidden`, `.cnt-cancel`, `.sh-evt.cancelled`,
`.wrow.cancelled`, `.udot` / `.unread`, and device-granularity `.picked`. It also removed
`.sh-composer.disabled`'s `opacity: 0.65`, which composited the mandatory disabled-reason
sentence below 4.5:1 (measured in `CONTRAST.md`).

The rule that stands: **compose from the shared classes below; never fork a shared class
page-locally.** If a shared style is missing, the fix belongs in this sheet, not in a fourth
copy of a page-local hack. (v1's option 4 invented page-local `.arow-*` agent rows instead of
reusing the shared `.wrow` family — that is exactly the divergence to avoid.)

Also: nothing outside the v2 directory, and never `../mobile-tasks-mockups/` (v1 baseline).

Everything renders over `file://`: no build step, no framework, no external fonts, no CDN, no
remote images, no `<script src>`, no network anything.

## 2. Themes — `?theme=dark|light` on every page

Every v2 page **must** carry this snippet verbatim, before any other script logic:

```html
<script>
  /* v2 theme convention: ?theme=dark|light pins the page on <html>;
     no parameter follows the OS via the prefers-color-scheme block in
     mockup.css. */
  const params = new URLSearchParams(location.search);
  const theme = params.get("theme");
  if (theme === "dark" || theme === "light") {
    document.documentElement.dataset.theme = theme;
  }
</script>
```

Behavior, identical everywhere:

- `?theme=dark` / `?theme=light` → sets `data-theme` on `<html>`, pinning the theme.
- No parameter (or an unrecognized value) → no attribute → the `@media (prefers-color-scheme)`
  block in `mockup.css` follows the OS. Dark is the default when nothing else says otherwise.
- Reuse the `params` object for your page's own deep-link params (below) — one
  `URLSearchParams`, several `.get()` calls.

Rules:

- **Never hardcode a color** in your page's `<style>` or inline styles. Use the tokens. The one
  sanctioned exception is an accent tint that is deliberately theme-agnostic (e.g.
  `rgba(96, 165, 250, 0.35)`), matching how `mockup.css` itself treats info/success/danger tints.
- Your page must render correctly in **both** themes. Check `?theme=dark` and `?theme=light`
  before you finish. `chrome.html` shows the target rendering in each.
- If your page has a visible theme toggle, it must preserve the other query params:

```js
function setTheme(t) {
  const p = new URLSearchParams(location.search);
  if (t) p.set("theme", t);
  else p.delete("theme");
  location.search = p.toString();
}
```

- **The pinned theme survives every internal link.** A theme pin that drops at a flow boundary
  (list → sheet → thread) reads as a bug, so all four pages do it identically: rewrite static
  anchors once on load, and append the param on JS navigations:

```js
const pinned = theme === "dark" || theme === "light" ? theme : null;
const withTheme = (url) =>
  pinned ? url + (url.includes("?") ? "&" : "?") + "theme=" + pinned : url;
if (pinned) {
  document.querySelectorAll('a[href^="../"]').forEach((a) => {
    a.setAttribute("href", withTheme(a.getAttribute("href")));
  });
}
```

(flow-3-task uses a `data-to` attribute variant of the same pattern; state-matrix rewrites its
backlink, permalinks, and `.flowlink` sheet links. Same outcome, one behavior.)

Available tokens (all defined per theme in `mockup.css`):

- Text/surfaces: `--bg --sb --fg --muted --dim --card --chip`
- Lines/state: `--border --border2 --hairline --hover --row-hover --selected`
- Accents: `--primary --info --success --warn --danger --teal --violet --coral`
- Chrome: `--well` (search field), `--btn` (circle buttons), `--alpha-bg --alpha-fg`,
  `--fab-bg --fab-fg --fab-shadow`, `--bezel-shadow`
- Translucent elevated surfaces (already wired into `.sheet`, `.pcard`, `.toast`, `.concept`,
  `.backlink`): `--sheet-bg --float-bg --pill-bg --toast-bg`

`data-theme` also works on any subtree, not just `<html>` — that is how `chrome.html` renders a
dark and a light phone on one page. Screen pages should not need this; set it on `<html>` only.

## 3. Deep links — the `?param` convention

Carried forward from v1 so the two sets navigate the same way: lowercase verb params, read once
from `location.search`, unknown values ignored gracefully (fall back to the page's default
state, never render blank).

Declared params — the table describes what the pages **actually do** (reconciled in T7):

| Page            | Param      | Values                                                                               | Renders                                                                                                       |
| --------------- | ---------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| every page      | `?theme=`  | `dark` · `light` (absent = system)                                                   | Pins `data-theme` on `<html>`; preserved across every internal link (§2)                                      |
| `flow-1-list/`  | `?peek=`   | `task` · `turn` · `apk` · `local` · `login`                                          | Highlights that sub-row (`.picked` + page-local pulse), scrolls it into view, re-opens its group if collapsed |
| `flow-1-list/`  | `?groups=` | `collapsed` · `expanded` (default)                                                   | Renders both task groups closed/open; dchip tap toggles a group                                               |
| `flow-2-peek/`  | `?sheet=`  | `task` (default) · `apk` · `local` · `login` · `a4`                                  | Opens that sheet on load                                                                                      |
| `flow-2-peek/`  | `?task=`   | same ids — **alias of `?sheet=`**                                                    | The id flow-1's task/turn rows emit; `?sheet=` wins if both are present                                       |
| `flow-3-task/`  | `?task=`   | `task` (default) · `apk` · `local` · `login`                                         | **Which task the view renders** — flow-1's ↗ and flow-2's "Open thread" emit this                             |
| `flow-3-task/`  | `?view=`   | `task` (default) · `parent`                                                          | `parent` redirects to `flow-1-list/?peek=<task>` (v2 builds no parent-thread page)                            |
| `flow-3-task/`  | `?state=`  | `running` (default) · `complete` · `failed`                                          | The **mockups task's** lifecycle tails + composers; inert for the other three tasks                           |
| `state-matrix/` | `?state=`  | `queued` · `single` · `zero-fail` · `all-failed` · `cancelled` · `unread` · `native` | Rings that phone (`.device.picked`) and scrolls it into view                                                  |

Two collisions to know about, both deliberate: `?task=` means "open this sheet" on flow-2 and
"render this task" on flow-3 (each page's own canonical param — `?sheet=` / `?view=` — still
works; the alias exists because flow-1 emits `?task=<id>` for both hops). And `?state=` has
disjoint value sets on flow-3 (task lifecycle) and state-matrix (phone ring) — same vocabulary,
per-page meaning; unknown values fall back to each page's default.

Highlight pattern for a deep-linked row (from v1 option 1 — `.picked` is in the shared sheet,
the pulse animation is page-local):

```css
.sub.picked {
  animation: peek-pulse 1.6s ease-out 2;
}
@keyframes peek-pulse {
  0% {
    box-shadow: inset 0 0 0 1px rgba(96, 165, 250, 0.9);
  }
  100% {
    box-shadow: inset 0 0 0 1px rgba(96, 165, 250, 0.35);
  }
}
```

```js
const peek = params.get("peek");
if (peek) {
  const row = document.querySelector('.sub[data-unit="' + peek + '"]');
  if (row) {
    row.classList.add("picked");
    row.scrollIntoView({ block: "center" });
  }
}
```

## 4. The chrome skeleton

Copy this block to start every screen page. It is byte-identical to the block between
`CHROME-BEGIN` / `CHROME-END` in `chrome.html` — if you think it needs to change, you are
wrong or you report it back; you do not fork it.

```html
<div class="stage">
  <div class="device">
    <div class="phone">
      <div class="screen">
        <!-- Android status bar -->
        <div class="statusbar">
          <span>
            11:31
            <span class="notif">
              <svg
                style="width: 11px; height: 11px"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
              >
                <path d="M3 18v-6a9 9 0 0 1 18 0v6" />
                <path
                  d="M3 18a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3Zm18 0a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3Z"
                />
              </svg>
              <svg
                style="width: 11px; height: 11px"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
              >
                <rect x="3" y="4" width="18" height="16" rx="3" />
                <path d="m3 7 9 6 9-6" />
              </svg>
            </span>
          </span>
          <span class="sicons">
            <span style="font-size: 11px; font-weight: 700">5G</span>
            <svg
              style="width: 12px; height: 11px"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
            >
              <path d="M7 10v4M12 7v7M17 4v10" transform="translate(0 6)" />
            </svg>
            <svg style="width: 24px; height: 12px" viewBox="0 0 25 12" fill="none">
              <rect
                x="0.5"
                y="0.5"
                width="21"
                height="11"
                rx="3.5"
                stroke="currentColor"
                opacity="0.4"
              />
              <rect x="2" y="2" width="16" height="8" rx="2" fill="#34d399" />
              <path d="M23.5 4v4a2 2 0 0 0 0-4Z" fill="currentColor" opacity="0.4" />
            </svg>
            <span style="font-size: 11.5px">81</span>
          </span>
        </div>

        <!-- App home header -->
        <div class="appbar">
          <div class="brand-row">
            <span class="brand-name">T3 <span class="thin">Code</span></span>
            <span class="alpha">ALPHA</span>
            <span class="spacer"></span>
            <span class="circlebtn" title="Filter threads">
              <svg
                class="ic"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
              >
                <path d="M4 5h16l-6.2 7.2V19l-3.6 2v-8.8L4 5Z" />
              </svg>
            </span>
            <span class="circlebtn" title="Settings">
              <svg
                class="ic"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
              >
                <circle cx="12" cy="12" r="3" />
                <path
                  d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1"
                />
              </svg>
            </span>
          </div>
          <div class="searchbar">
            <svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="11" cy="11" r="7" />
              <path d="m21 21-4.3-4.3" />
            </svg>
            Search threads
          </div>
        </div>

        <!-- Content scroll region — your rows/cards go inside .mlist (or your
             own container inside .mscroll for non-list screens) -->
        <div class="mscroll">
          <div class="mlist">
            <!-- .trow / .subs content here -->
          </div>
        </div>

        <div class="fab" title="New thread">
          <svg
            style="width: 21px; height: 21px"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
          </svg>
        </div>
        <div class="gesturebar"></div>
        <div class="toast" id="toast"></div>
      </div>
    </div>
    <div class="devicecap"><b>Your page name.</b> One-line caption. <code>?yourparam=…</code></div>
  </div>
</div>
```

Furniture outside the phone, matching v1: `<a class="backlink" href="../index.html">← v2
index</a>` top-left, and a `.concept` pill bottom-right naming the screen. (`index.html` lives
one level up from the flow pages; `chrome.html` uses `index.html` directly.)

### Detail screens: swap the header and the FAB

`flow-3-task` (and any pushed view) replaces `.appbar` with `.tbar`, and the `.fab` with
`.composer-wrap`. Status bar, `.mscroll`, `.gesturebar`, `.toast` stay. From v1 option 4:

```html
<div class="tbar">
  <span class="tbar-back" title="Back to Add Wayfinder Constellation Sidebar View">
    <svg
      class="ic"
      style="width: 19px; height: 19px"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2.2"
    >
      <path d="M19 12H5M12 19l-7-7 7-7" />
    </svg>
  </span>
  <div class="tbar-titles">
    <div class="tbar-title">Create 4 mockups for the mobile app based on the image</div>
    <div class="tbar-sub">Task · runs in its own thread · Opus 4.7</div>
  </div>
  <span class="tbar-act"><!-- optional trailing icon --></span>
</div>
```

```html
<div class="composer-wrap">
  <div class="composer">
    <div class="ph">Steer this task…</div>
    <div class="bar">
      <span class="chipbtn">
        <svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path
            d="m21.4 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"
          />
        </svg>
        Attach
      </span>
      <span class="send">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4">
          <path d="M12 19V5M5 12l7-7 7 7" />
        </svg>
      </span>
    </div>
  </div>
</div>
```

## 5. Class inventory

Everything below already exists in `mockup.css`. Do not restyle it page-locally.

### Thread rows (the list anatomy traced from the reference)

- `.trow` → `.trow-top` (`.picon` + `.repo` + `.tago`) → `.ttitle` → `.trow-bot`
  (`.tbranch` + optional `.tbadge` + `.tprov`).
- `.trow.selected` marks the row that owns an open overlay (flow-2's sheet backdrop) with the
  `--selected` wash.
- `.picon` takes `--h` inline: `<span class="picon" style="--h: 215">T3</span>`.
  **Hues must stay in 200–260** (avatar rule, §7).
- `.tago` holds the time-ago (`13h`) or `<span class="working">Working</span>`; an expanded
  parent also carries `.clk` (clock icon) and `.settle` (✓ Settle pill) here.
- `.tbadge` is the green unread marker (`#10`). `.tprov` is the provider glyph (§6).

### Disclosure chip + guide-line sub-rows

```html
<span class="dchip" title="1 task · 10 agents in this thread">
  <svg …chevron-down…></svg>
  1 task · 10 agents
</span>
```

```html
<div class="subs">
  <div class="sub" data-unit="task">
    <span class="sic working-ic">…asterisk svg…</span>
    <span class="stitle">Create 4 mockups for the mobile app based on th…</span>
    <span class="smeta working">8s</span>
  </div>
  <div class="sub lvl2" data-unit="turn">
    <span class="sic" style="color: var(--dim)">…chevron-right svg…</span>
    <span class="stitle" style="color: var(--muted)">Latest turn · 10 agents</span>
    <span class="smeta">
      <span class="cnt-ok">✓ 6</span>
      <span class="cnt-fail">× 4</span>
      <span class="ret" title="Results returned to the task">…returned svg…</span>
    </span>
  </div>
</div>
```

- `.subs` is the guide-line container; `.sub` a nested row; `.sub.lvl2` nests a task's turn one
  level deeper. `data-unit` carries the deep-link id (§3).
- Sub-row state modifiers: `.done`, `.failed`, `.queued`, `.cancelled` on `.sub`; `.working` /
  `.failed` / `.cancelled` on `.smeta`. `.picked` marks the deep-linked row.
- Status icons: `.working-ic` (blue asterisk), `.ok` (green ✓), `.xfail` (red ⊗), `.clk` (dim
  clock — also the **queued** icon), `.cancel-ic` (amber — **cancelled**), `.spin` (spinner).
- Counters: `.cnt-ok` / `.cnt-fail` / `.cnt-cancel` (amber minus-in-circle for cancelled
  outcomes, inline SVG — a `⊖` text glyph is font-dependent over `file://`), plus `.ret` for the
  blue ↩ returned marker. Wording rules in §7.
- Unread indication: `.udot` (blue dot on the parent row) + `.unread` (the word "unread" on the
  row that returned). `.tbadge` stays the per-thread `#10` form, not a generic unread signal.
- `.picked` highlights the deep-linked row (`.sub.picked`); at whole-device granularity
  (state-matrix) `.device.picked .phone` rings the phone with an accent outline.

### Status chips

`.chip` with modifiers: `.agent` (creator was an agent), `.you` (creator was you), `.returned`
(↩ returned · woke parent), `.native` (agent · runs in the task session), `.danger` (failed /
usage on a failed row). Used inside `.sh-meta` on sheets and anywhere provenance is stated.

### Agent rows — `.wrow` is the only agent row

```html
<div class="wcard">
  <div class="wcard-head">
    …asterisk svg… <span>Latest turn · <b>10 agents</b></span>
    <span class="usage">38.2k tokens · 14 tools · 2m 14s</span>
  </div>
  <div class="wrow">
    <span class="sic ok">…check svg…</span>
    <span class="wname">Map screenshot chrome regions</span>
    <span class="wtype">Explore</span>
    <span class="wmeta"><span class="usage">4.1k tokens · 3 tools · 3s</span></span>
  </div>
  <div class="wrow failed">
    <span class="sic xfail">…x-circle svg…</span>
    <span class="wname">Reproduce provider glyph set</span>
    <span class="wtype">Explore</span>
    <span class="wmeta"><span class="wsub">failed — tool-use budget exceeded</span></span>
  </div>
</div>
```

`.wrow.failed .wname` dims itself; `.wrow.cancelled .wname` dims the same way (a cancelled run
is not still-active). The reason rides in `.wsub` (or `.usage` with the reason appended, v1
option 4 style: `Explore · 6.8k tokens · 5 tools · 9s · budget exceeded`). Inside a sheet, the
same rows live in `.sh-agents` under `.sh-agents-head` (whose `<b>` is styled exactly like
`.wcard-head b`). **Agent rows are view only** — the only action they may offer is "Show in
transcript".

### Bottom sheet (flow 2)

`.sheet-wrap` (add `.show` to open) → `.sheet-dim` + `.sheet` → `.sheet-grab`, `.sheet-scroll`.
Content: `.sh-top` (`.working`/`.done`/`.failed`/`.cancelled`; wraps to a second line rather
than clipping at 320 px, buttons `flex: none`), `.sh-title`, `.sh-meta` (chips),
`.sh-body` (`.sh-msg.user` / `.sh-msg.asst` / `.sh-evt` / `.sh-evt.failed` / `.sh-evt.cancelled`),
`.sh-agents`, `.sh-actions` (`.sh-btn`, `.sh-btn.danger`, `.sh-btn.primary`), and the composer:

```html
<!-- task sheet: enabled -->
<div class="sh-composer">
  <span class="grow">Steer this task…</span><span class="sh-send">…send svg…</span>
</div>

<!-- agent sheet: disabled, reason in words — mandatory pattern, see §7 -->
<div class="sh-composer disabled">
  <span class="grow"
    ><span class="composer-note"
      >Runs inside the task’s session — to stop it, interrupt the task’s turn.</span
    ></span
  >
  <span class="sh-send">…send svg…</span>
</div>
```

A disabled composer greys only its send pill (`.sh-composer.disabled .sh-send`) — there is
deliberately **no opacity dim**: at 0.65 the mandatory reason sentence measured ≈2.65:1
(CONTRAST.md). The disabled read comes from the greyed pill and the `--dim` note at full
strength. The standalone detail-screen composer has the same pattern (`.composer.disabled`
greys `.send`); its placeholder carries the task's state — "Steer this task…" while running,
"Message this task…" once done — and a failed/cancelled task disables the composer with the
reason in words and offers Retry instead.

### Timeline, event rows, misc

`.tl` feed with `.msg.user` / `.msg.asst` (`.who`, inline `code`); quiet lifecycle rows `.evt`
(`.wake` variant for returned-to-parent, `.failed` for failure sentences, `.open` link) —
provenance like “Created as a task by …” goes here; `.seg` segmented control (`.on`, `.cnt`);
`.usage` metric runs; `.pcard` collapsible “Parallel work” card (`.closed`, `.pcard-head .chev`,
`.pcard-body`); `.hl-flash` jump-target flash; `.toast` confirmations. State-toggle utilities:
`.tail` (`display: contents` wrapper — its rows keep the parent's flex gap while toggling as one
block) and `.hidden` (`display: none`, declared after `.tail` so the toggle wins the cascade).

## 6. Icons

Inline SVG only, `stroke="currentColor"`, sized inline. The canonical set (from v1):

| Use                         | Class                                   | Paths (`viewBox="0 0 24 24"`, `fill="none"` unless noted)                                                                                           |
| --------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Working (also Claude glyph) | `.working-ic` / `.tprov` `var(--coral)` | `stroke-width="2.2"` `<path d="M12 3v18M4.5 7.5l15 9M19.5 7.5l-15 9" />`                                                                            |
| Codex glyph                 | `.tprov` `var(--dim)`                   | `<path d="M12 3a9 9 0 1 0 9 9" /><path d="M12 7.5a4.5 4.5 0 1 0 4.5 4.5" /><circle cx="12" cy="12" r="1" fill="currentColor" />`                    |
| Done                        | `.ok`                                   | `stroke-width="2.4"` `<path d="M20 6 9 17l-5-5" />`                                                                                                 |
| Failed                      | `.xfail`                                | `<circle cx="12" cy="12" r="9" /><path d="m15 9-6 6M9 9l6 6" />`                                                                                    |
| Queued                      | `.clk`                                  | `<circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />`                                                                                          |
| Cancelled                   | `.cancel-ic`                            | **invented here** (v1 has no cancelled state): `<circle cx="12" cy="12" r="9" /><path d="M8 12h8" />` — minus-in-circle, distinct from the failed ⊗ |
| Returned                    | `.ret`                                  | `<path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5 5.5 5.5 0 0 1-5.5 5.5H11" />`                                                   |
| Expandable / disclosure     | `.sic` `var(--dim)`                     | right `<path d="m9 6 6 6-6 6" />` · down `<path d="m6 9 6 6 6-6" />`                                                                                |
| Show in transcript          | —                                       | `<circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3" />`                                                                       |
| Open (external)             | —                                       | `<path d="M7 17 17 7" /><path d="M8 7h9v9" />`                                                                                                      |
| Send                        | `.send` / `.sh-send`                    | `stroke-width="2.4"` `<path d="M12 19V5M5 12l7-7 7 7" />`                                                                                           |
| workflowharness `.picon`    | `--h: 255`                              | `fill="currentColor"` four `<rect width="8" height="8" rx="1.5" />` at 3/13 × 3/13 (see `chrome.html`)                                              |

## 7. Honesty rules — hard requirements, not taste

1. **A failed item ALWAYS carries its reason in words, never a bare marker.** Terse form in the
   row meta (`.wsub` / `.usage`: `failed — tool-use budget exceeded`), full sentence where there
   is room (sheet `.sh-evt.failed`: `✕ Tool-use budget exceeded before the sweep converged`).
   A red icon alone is a bug.
2. **A disabled or unsteerable control ALWAYS states why, in words, next to it.** The pattern is
   the agent sheet's disabled composer: `.sh-composer.disabled` + `.composer-note`
   ("Runs inside the task's session — to stop it, interrupt the task's turn"). A greyed-out
   control with no explanation reads as a defect.
3. **Counts read correctly at zero, one, and all-failed.**
   - One: `1 task`, `1 agent` — never `1 tasks`, `1 agents`.
   - Zero failures: show only `✓ 6`. No `× 0`, no red anywhere — failure styling when nothing
     failed teaches the user to distrust the indicator.
   - All failed: show only `× 4`. No `✓ 0`, no green — and every failed item still carries its
     reason (rule 1).
   - Nothing run yet (queued): no counters at all — say `Queued` in words.
   - Never divide: no `0 of 0`, no `6/10` forms — always `✓ n` / `× m`.
4. **Real data only.** Threads, repos, branches, agents, and times come from the shared scenario
   (below) — do not invent new ones. New lifecycle states are new _cardinalities of the same
   scenario_, not new threads.
5. **Avatar hues stay in 200–260.** `.picon` is `hsl(var(--h) 65% 38%)` with white initials;
   outside 200–260 a bright hue can drop below 4.5:1 (yellow 60 measures 2.79:1). The scenario's
   hues are `215` (pingdotgg/t3code) and `255` (paulodaniel1993/workflowharness).
6. **The scenario** (from `reference-mobile.png` + v1 — the only data you may use):
   - Threads: `Add Wayfinder Constellation Sidebar View` (pingdotgg/t3code, dev, 3h, Claude) ·
     `Build Standalone Android APK` (13h) · `Add Task Transformation to Threads` (11h) ·
     `Assess Local Build Feasibility` (14h) · `Finish Durable Chat Server Fixes` and
     `Finish Durable Chat Branch Work` (paulodaniel1993/workflowharness, feature/durable-chat,
     15h, #10) · `Fix T3 Connect Login` (Working) · `Fix T3 Connect Redirect Error` (13h).
   - The mockups task: `Create 4 mockups for the mobile app based on th…`, working 8s,
     agent-created, full thread context; latest turn **10 agents, ✓ 6 × 4** — the four failures
     are `Reproduce provider glyph set` (a4), `Fit expanded task group into 390px` (a6),
     `Bottom-sheet layout pass` (a7), `In-thread card layout pass` (a9), all
     `tool-use budget exceeded`. The six ✓: `Map screenshot chrome regions`,
     `Extract thread-row anatomy`, `Draft status bar + app header markup`,
     `Draft list-row CSS tokens`, `Compose thread-list variant`, `Assemble full-thread variant`.
   - The redirect thread's tasks: `Build a standalone, installable Android APK of t…` (19m, ↩,
     turn of 3 agents — `Locate Gradle wrapper + signing config` ✓, `Assemble release APK
locally` ✓, `Verify install on emulator` × budget exceeded) · `is it possible to build
locally?` (done, 59s, ↩) · `the t3 connect is not letting log in` (working, 24s, ↩).
   - New states reuse these names: the single-agent case is one of the ten; all-failed is the
     APK turn with all three failed; cancelled is the mockups task interrupted mid-turn;
     returned-unread is the APK task's ↩ with an unread marker on the parent.
7. **One wording for one concept** (converged across the four screens in T7 — diverging
   dialects for the same entity are a defect):
   - A turn rollup reads **“Latest turn · n agents”** everywhere (list rows, sheet agent
     blocks, the flow-3 card).
   - The returned-to-parent event reads **“Returned to the parent — woke ‹ParentName›”** in
     timelines and sheet event lines; the chip form stays terse: `↩ returned · woke parent`.
   - The composer placeholder carries the task's state: **“Steer this task…”** while running,
     **“Message this task…”** once done. A failed or cancelled task does not accept a steer at
     all: its composer is disabled with the reason in words and the offered action is Retry
     (a new turn with the same brief). Native in-session agents are never steerable (rule 2's
     mandatory note).
   - Cancelled outcomes count with `.cnt-cancel` (amber minus-in-circle) and rows say
     “cancelled — retry interrupted” — never red, never “failed”.

## 8. What to report back

In your final message to the coordinator: any shared style you needed that does not exist (with
the page-local stopgap you used), any class above that did not fit your screen, and any place
the honesty rules forced a layout compromise. Do not report convention violations you committed
deliberately — there should be none; if a rule fights your screen, say so loudly instead.
