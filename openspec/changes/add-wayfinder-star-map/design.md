## Context

A wayfinder map is a directory of markdown: one `map.md` describing an effort, and a `tickets/` directory of decision tickets linked by `blocked_by`. Two dialects exist in the wild — `rengwu/chartr`, which writes `**Field:** value` lines under headings, and the official skill, which writes YAML frontmatter. Both encode the same graph. Neither stores status: a ticket is resolved because someone wrote prose under `## Answer`, claimed because `claimed_by` is set, ruled out because prose sits under `## Ruled out`.

Three findings from exploring this repo shape every decision below.

**There is zero graphics infrastructure here.** No d3, reactflow, force-graph, konva, pixi, three, or framer-motion. No `<canvas>` is rendered anywhere. All 26 `requestAnimationFrame` call sites are one-shot layout/scroll plumbing; no render loop exists. This is fully greenfield, and nothing can be assumed to already work.

**`apps/web` tests run in Node with no DOM.** There is no `jsdom` dependency and no `environment` override in `apps/web/vite.config.ts`, so Vitest's `node` default applies; every component test in the repo asserts through `renderToStaticMarkup`. A canvas is untestable in this harness, which forces all testable logic into pure modules outside the renderer. That is a constraint, but it is also the right architecture.

**`migratePersistedRightPanelState` cannot version-gate.** Its signature is `(persistedState: unknown)` (`apps/web/src/rightPanelStore.ts:156`); zustand passes a version as a second argument that is not declared. Bumping `RIGHT_PANEL_STORAGE_VERSION` 7→8 is therefore pure ceremony. Worse, `:187` returns any non-`file`, non-`terminal` surface unchanged, so an unknown `kind` survives migration. A `RIGHT_PANEL_KINDS` allowlist already exists at `:17` and simply is not consulted.

The user has chosen fidelity to the reference renderer, live freshness, and support for both dialects. Those choices are settled; this document records how to honour them without regressing performance, accessibility, or the right panel.

## Goals / Non-Goals

**Goals:**

- Answer "what can I pick up now" and "what is this waiting on" at a glance, from the graph rather than from file names.
- Parse both dialects into one wire model, so no client code branches on dialect.
- Keep the steady-state cost of an open panel at zero bytes and the render loop at zero frames whenever the surface is not visible.
- Survive markdown written mid-turn by an LLM: malformed input produces lints and a partial map, never an empty panel or a thrown error.
- Keep every testable behaviour in pure modules that run under `environment: "node"`.
- Preserve spatial memory — a ticket keeps its position across reloads and as the map grows.
- Make the map fully usable without the canvas, by keyboard and screen reader.

**Non-Goals:**

- Mobile support. `apps/mobile` has no right panel, only `ThreadInspectorMode = "route" | "git" | "files"` (`apps/mobile/src/features/threads/thread-inspector-content-stack.tsx:4`).
- Editing maps or tickets from the panel. This surface reads; the agent writes.
- Tracker-hosted maps (Linear, GitHub Issues). Files on disk only.
- Generalising to "any planning artifact". This renders wayfinder maps, and the naming says so.
- Merging with `2026-07-25-thread-tasks`. That models work in flight with real lifecycle status and parent/child linkage; this reads decisions on disk. They share roughly 80% of a ticket shape and none of a data source.
- Upstreaming. This is fork-local by design.

## Decisions

### 1. Parse on the server, not the client

The decisive reason is not round-trip count — it is that **the client cannot discover maps cheaply**. `projects.listEntries` returns the whole workspace index (tens of thousands of entries) and `projects.searchEntries` is fuzzy and capped at 200. Neither is an exact-path enumerator, so a server method is needed for discovery no matter where parsing happens. Given that, parsing there is free.

It also holds the payload at ~12 KB instead of ~60 KB of raw markdown, which matters under the performance audit `AGENTS.md:17` describes and on tunnelled connections that `AGENTS.md:19-21` calls core.

Rejected: shipping raw markdown and parsing in the client (needs a discovery RPC anyway, then costs 5× the bytes on every write burst); reusing `projects.readFile` per ticket (N round-trips, and the client still cannot enumerate).

### 2. Derive status from prose, and make the fence pre-pass the load-bearing invariant

Status precedence is `out_of_scope` > `resolved` > `claimed` > `open`:

- `out_of_scope` — prose under `## Ruled out`
- `resolved` — prose under `## Answer` **or** `## Resolution`, or `**Status:** closed`
- `claimed` — `claimed_by` is set
- `open` — otherwise

It is the **prose** that closes a ticket, not the heading. A heading followed only by whitespace, or immediately by another heading, leaves the ticket open — agents write the skeleton first and fill it in later, and a map that marks every skeleton resolved is worse than no map.

Before any heading or field scan, classify every line as structural or fenced, honouring both ` ``` ` and `~~~` and the opening fence's length so a 4-backtick fence can contain a 3-backtick one. Without this pass, a ticket that documents the wayfinder format resolves itself, and that failure is silent — a wrong answer with no error, which is the worst outcome this feature can produce.

### 3. Normalise both dialects; carry `dialect` only as a diagnostic

Try YAML frontmatter first, reusing the `FRONTMATTER_PATTERN` regex plus `yaml` package pattern already established at `apps/server/src/provider/Drivers/ClaudeSkills.ts:19-33`. Otherwise scan leading **structural** lines for `**Field:** value`. The wire carries `dialect` as a literal for diagnostics only: **if any client code ever branches on it, normalisation has failed** and the fix belongs in the parser.

Two edge cases are landmines rather than details:

- **`blocked_by: [02, 03]` parses as strings in YAML 1.2** (a leading zero is not a valid integer) while `[2, 3]` parses as numbers. Coerce to string, then resolve by `id`, then `ordinal`, then zero-pad-normalised comparison.
- **An unresolvable blocker drops the edge and emits a lint.** A dangling edge in a graph renderer is either a crash or a line drawn to nowhere; neither is acceptable, and silently inventing a placeholder node would lie about the graph.

**Cycles are expected** — blocker lists are hand-authored and an agent will eventually write `A blocks B blocks A`. Rank via Kahn's algorithm; any node never emitted gets `rank = maxRank + 1` and a `cyclic` flag. The solver must terminate on bad data, always.

### 4. Discovery is three bounded probes, watching `.plan` only

Discovery is `readDirectory(<root>/.plan/maps)`, `readDirectory(<root>/.plan)`, and `stat(<root>/wayfinder-map.md)` — not a tree walk. Every path goes through `WorkspacePaths.resolveRelativePathWithinRoot` so the existing escape check (`apps/server/src/workspace/WorkspacePaths.ts:202-231`) is reused verbatim rather than reimplemented.

**Do not extend `WorkspaceEntries`.** `WorkspaceEntries.refresh(cwd)` runs on every `projects.writeFile` (`WorkspaceFileSystem.ts:296`); hanging map parsing off it would reparse every map on every file write anywhere in the workspace.

**Watch `<root>/.plan`, never the workspace root.** Effect's `fs.watch` is hardcoded to `{ recursive: true }` (`.repos/effect-smol/.../NodeFileSystem.ts:557-559`) and it works — which is the problem. On Linux, recursive watching means one inotify watch per directory, so watching the root would walk `node_modules` and `.git` straight into `fs.inotify.max_user_watches`. That is a repo-wide outage on the developer's machine, not a feature bug.

When `.plan` does not exist yet, arm a cheap `stat` re-arm probe on an interval that stops once the watcher arms. Expose that interval as an injectable parameter exactly as `VcsStatusBroadcaster` does for `automaticRemoteRefreshInterval` (injected at `ws.ts:1867`), so tests drive it with `TestClock` and never a sleep.

Refcount subscribers with **`LayerMap.Service`**, following `WorkspaceSearchIndexMap` (`WorkspaceSearchIndex.ts:555-561`): it gives refcounting, teardown-on-last-release, and `idleTimeToLive` in about ten lines. `VcsStatusBroadcaster`'s ~90-line `retainRemotePoller`/`releaseRemotePoller` pair exists because sharing a git fetch is expensive; sharing a file watcher is not, and copying that machinery here would be cargo cult.

### 5. Bound every read, and make truncation visible

Caps: 24 maps, 200 tickets per map, 600 total nodes, 64 KiB per ticket, 256 KiB per map, 200-character titles. Reads use bounded `open`/`read`/`close` (pattern at `WorkspaceFileSystem.ts:216-229`), **not** `readFileString`, so a 200 MB junk file in `.plan` costs one 64 KiB read rather than 200 MB of heap.

A truncated ticket emits a `ticket_truncated` lint, because prose past the cut could otherwise make a resolved ticket render as open. Silent truncation would produce a confidently wrong graph.

### 6. Fingerprint-dedupe before publishing

`fs.watch` fires three to five times per editor save; `serverSettings.ts:529-547` documents exactly this and is the debounce pattern to copy. Publish only when the `JSON.stringify` fingerprint of the parsed snapshot changes. Without it, a heading appearing one keystroke before its prose repaints the whole constellation and flips a ticket's state twice.

Sort tickets by filename and edges by `(from, to, kind)` before serialising the fingerprint, or `readDirectory` ordering alone will republish an identical map.

### 7. A plain snapshot struct, with ticket bodies and positions deliberately absent

One `stream: true` RPC carrying a plain struct rather than a tagged union — there are no partial updates, and `subscribeBackgroundPolicy` / `subscribeResourceTelemetry` (`rpc.ts:791-803`) are the precedent for exactly this shape.

```
WayfinderMapsSnapshot { maps, lints, truncated }
WayfinderMap  { id, dialect, title, mapRelativePath, destination, notes,
                nodes, edges, fog, decisions, outOfScope, counts, truncated }
WayfinderNode { id, ordinal, label, relativePath, type, status, isFrontier,
                isUndermined, claimedBy }
WayfinderEdge { from, to, kind: "blocks" | "undermines" }
WayfinderFogEntry { title, description, clearsWith }
```

**Ticket bodies are not on the wire.** Inlining them is ~60 KB instead of ~12 KB, re-sent on every write burst, for prose the constellation does not render. Each node carries `relativePath`, so opening a ticket is the already-shipped `projects.readFile` rendered through the already-shipped `apps/web/src/components/ChatMarkdown.tsx`. There is no `wayfinder.getTicket` RPC and there should not be one.

**Node positions are not on the wire.** Layout runs client-side from a deterministic seed, so positions survive reconnects and the data plane never couples to panel width.

Malformed markdown degrades to lints. Typed errors are reserved for workspace-root resolution and path-escape failures, which already have precedent and are genuine faults rather than expected input.

### 8. One singleton `map` surface, not a tab per map

The surface is `{ id: "map"; kind: "map" }`, joining `diff` / `files` / `plan` — **not** `map:${effortId}`.

Multi-instance costs a dedicated action, a factory, a reconcile pass, per-entry migration validation, and a cleanup path. Worse, when the agent deletes `.plan/<effort>/` mid-session — which is exactly what agents do to their own scratch directories — a per-map tab renders nothing, forever, across restarts. A singleton has no such failure mode. Effort switching becomes in-panel local state, which is what the reference's `< Back` chip already implies.

Two tripwires are compile-enforced and will catch themselves: `singletonSurface()` (`rightPanelStore.ts:85-96`, exhaustive switch with no `default`) and `surfaceTitle()` (`RightPanelTabs.tsx:189-219`, declared `: string`). Five will not:

| Site                                                                      | Failure if missed                                                                                                                      |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `SurfaceIcon()` `RightPanelTabs.tsx:237-270`                              | No declared return type, so it infers `Element \| undefined`, which React 19 renders happily. Tab with no icon, no compiler complaint. |
| `rightPanelContent` ternary `ChatView.tsx:5789-5862`                      | Chain ends `: null`. A titled, icon'd, closable tab with an empty body.                                                                |
| Empty-state actions `RightPanelTabs.tsx:98-131` and `+` menu `:446-473`   | Panel is unreachable from the UI.                                                                                                      |
| **Both** `RightPanelTabs` call sites, `ChatView.tsx:6273` **and** `:6300` | The `:6300` sheet site is the classic miss. Make the new props **required** so the compiler catches it.                                |
| `migratePersistedRightPanelState` `:156`                                  | Ghost tab in older builds. See decision 9.                                                                                             |

### 9. Harden the persist migration first, and land it independently

`migratePersistedRightPanelState` currently returns unknown surface kinds unchanged (`rightPanelStore.ts:187`). Filter surfaces through the `RIGHT_PANEL_KINDS` allowlist that already exists at `:17` and is simply never consulted.

This lands **on its own, before anything else**, and is worth landing even if the map never ships: it is what makes every _future_ build degrade cleanly instead of showing an unlabelled ghost tab, and it cannot be fixed retroactively in builds already in users' hands. Bumping the storage version is not a substitute — the migration cannot see the version.

### 10. Gate on `activeProject !== null`, and let the panel own its own emptiness

The `+` menu gate is `activeProject !== null` — cheap and synchronous, matching `browserAvailable` / `diffAvailable` / `filesAvailable` (`ChatView.tsx:6291-6293`).

Do **not** probe the server for "does this project have a map". The `+` menu renders on every panel open, so a round-trip there means the menu item pops in after the menu is already on screen, on exactly the tunnelled connections that matter most.

The panel therefore owns emptiness, with **two distinct empty states**: "no map in this project" and "found a map but could not parse it". One generic state would hide parse failures forever, and parse failures are the thing a user most needs to see.

### 11. Canvas fidelity, with the loop on a leash

This ships a real `requestAnimationFrame` engine — parallax starfield, frontier pulse, and flow particles drifting blocker→dependent along satisfied edges. That is a **deliberate departure from `AGENTS.md:142`** ("No continuously repainting animations; they peg the GPU on high-refresh displays"), named here as an accepted trade rather than an oversight. What makes it defensible is that the loop is demand-driven:

- **Hard stops** — `document.hidden`, window blur, surface not active, off-screen per `IntersectionObserver`, and `prefers-reduced-motion` (which renders exactly one static frame and never starts the loop). `RightPanelSheet` uses `keepMounted`, so "not visible" is not "unmounted"; the visibility gate is required, not a nicety.
- **Two rates** — interaction (pan, zoom, selection easing) runs at full refresh; ambient motion runs on a ~30 fps accumulator and decays to a slow tick after roughly 10 s idle. Full-rate ambient animation on a 240 Hz display is the specific thing the rule exists to prevent.
- **DPR handling is new code.** `devicePixelRatio` appears in zero files today, so backing-store sizing via `ResizeObserver` plus a `matchMedia('(resolution: Xdppx)')` listener for monitor-to-monitor drags has to be written correctly rather than assumed to work.

If a frame profile still shows meaningful idle GPU cost on a high-refresh display, the fallback is pre-agreed: keep the canvas, drop ambient motion to interaction-only. Nothing else in this design changes.

### 12. Deterministic layout in panel-independent space, seeded per ticket

Everything testable lives outside the canvas:

- **`starMapGraph.ts`** — snapshot to normalised graph, derived status, Kahn rank, cycle flags.
- **`starMapLayout.ts`** — rank-biased relaxation in a **virtual 1000-unit-radius space**, so resizing the panel never re-runs the solver.
- **`starMapCamera.ts`** — fit-to-bounds, clamping, screen↔world transforms.
- **`starMapLabels.ts`** — deterministic placement and collision suppression, lower ticket number winning.
- **`StarMapPanel.logic.ts`** — pure reducer over `{ level, selectedMapId, selectedTicket }`.

Seed each node's starting angle from `hash32(ticketNumber)` **alone** — not from a rank-sorted index and not from a golden-angle spiral. With an index-derived seed, inserting ticket 15 shifts every later node and "tickets keep spatial memory across loads" becomes a lie the first time the agent adds a ticket.

Forces: linear-falloff repulsion with a hard cutoff (bounded, so no explosions), edge springs whose rest length scales with rank gap, radial pull toward `targetR(rank)`, and centroid subtraction instead of a gravity term. Relaxation cools linearly to exactly zero over ~300 iterations — no velocity, no live simulation, roughly 4–8 ms at 60 nodes, run once in a `useMemo` keyed on a **content revision string** rather than array identity.

**Non-overlap is not guaranteed by forces.** Add a deterministic 10-iteration separation post-pass and assert minimum pairwise separation in a test, rather than claiming a proof the forces do not provide.

### 13. Three-level push navigation, and a container query for the split

Navigation is `Maps → Map → Ticket` with `< Back` at each level and Escape going back one. A slide-in overlay is wrong at this width: 70% of a 360 px panel leaves a 108 px sliver of star map, which is not a map.

Above roughly 720 px (maximised), split side by side using a **container query** — `@container` is already in use at `index.css:286-292` — not a viewport media query, because `PreviewPanelShell` sets an explicit pixel width independent of the viewport.

Do not build expand or close controls. `RightPanelMaximizeControl` (`PanelLayoutControls.tsx:81-112`) and the per-tab `X` already exist; the reference has its own only because it has no tab bar.

### 14. The accessible list is a first-class view, not an afterthought

A canvas is a black hole for keyboard and screen readers, so mark it `aria-hidden` and render an adjacent `<ul>` of tickets sorted by rank then number, each a `<button>` with a descriptive `aria-label`. Focusing an item highlights the corresponding star and eases the camera to it.

Since it exists anyway, surface it as a **Map / List toggle** in the header and default to List below 380 px — it is a better use of 320 sheet pixels than a constellation, and it is what `prefers-reduced-motion` users get.

### 15. Scope theme tokens to the panel and read them once per theme change

The starfield is intrinsically dark, so the panel scopes its own token block under `[data-star-map]` with light and dark variants — the same technique as `[data-sidebar-version]` at `index.css:949-997`. Read tokens **once per theme change** into the engine; never call `getComputedStyle` per frame.

Build status hues on `--success` / `--warning` / `--info` / `--destructive`: `APPEARANCE_MANAGED_SEMANTIC_PROPERTIES` (`apps/web/src/appearance/applyAppearance.ts:18-37`) does **not** include them, so they are theme-invariant and a user's custom theme cannot turn the status palette into mush.

## Risks / Trade-offs

- **The render loop is the headline risk** → Demand-driven gating, dual rates, idle decay, and reduced-motion. Pre-agreed fallback: keep the canvas, drop ambient motion to interaction-only.
- **Recursive `fs.watch` could exhaust inotify watches** → Watch `<root>/.plan` only, never the workspace root. This is called out as a hard rule, not a preference.
- **`fs.watch` bursts could thrash the panel** → Fingerprint dedupe with deterministic sort ordering before serialisation.
- **A huge or hostile file under `.plan` could blow up memory** → Bounded `open`/`read`/`close` with per-ticket and per-map caps; truncation surfaces a lint.
- **The canvas cannot be asserted in tests** → All logic in pure modules with real coverage; the canvas gets a documented manual end-to-end pass instead of a fake one.
- **`add-project-browser-sidebar` (`design.md:31`) explicitly rejected expanding `rightPanelStore` for its own feature** → A seventh kind is not a collision (no pending change adds a surface kind or bumps the storage version), but it moves against a documented instinct. The distinction: that change needed _project_ scope, which the thread-scoped store genuinely cannot express; this one is thread-scoped like every existing surface.
- **Ticket links 404 in worktree threads if roots diverge** → cwd resolution follows `thread.worktreePath ?? project.workspaceRoot` (`ws.ts:1858`), and the map _and_ its ticket links must use the same root.
- **`openFile` silently closes an open Files tab** (`rightPanelStore.ts:265-267`) → Either accept and document it, or route through a variant that preserves the explorer. Decided during Phase 8, not left implicit.
- **Layout instability would break spatial memory** → Per-ticket hash seeding plus an explicit test that adding one leaf moves existing nodes less than 2% of the bounding radius.

## Migration Plan

1. Land decision 9 (the `RIGHT_PANEL_KINDS` allowlist in `migratePersistedRightPanelState`) alone, ahead of everything else. It is independently valuable and cannot be retrofitted into shipped builds.
2. Land the server parser and service with no client consumer. Inert until an RPC exists.
3. Land the contract and handler. Inert until a client subscribes.
4. Land client plumbing, then the panel shell and list view — usable at this point without any canvas.
5. Land pure geometry, then the canvas engine on top.

Rollback at any step is removal of the surface kind; the allowlist from step 1 then drops the persisted `map` surface cleanly, which is precisely the behaviour step 1 exists to guarantee. There is no server-side persisted state and no schema migration, so nothing outlives an uninstall.

## Open Questions

- Does `openFile` closing the Files tab get accepted-and-documented, or does the map route through an explorer-preserving variant? Deferred to Phase 8, when the interaction can actually be felt.
- Should the `+` menu entry be hidden or shown-disabled when the project has no `.plan/`? Current answer is shown, with the panel owning emptiness, because hiding requires the server probe decision 10 rejects — but this is worth revisiting once the two empty states are real.
- Are there additional wayfinder dialects in circulation beyond the two handled here? The parser degrades to lints rather than errors on an unknown shape, so a third dialect is a lint-and-partial-map, not an outage.
