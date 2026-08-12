## 1. Harden Right-Panel Persistence

- [x] 1.1 Filter persisted surfaces in `migratePersistedRightPanelState` (`apps/web/src/rightPanelStore.ts:156`) through the existing `RIGHT_PANEL_KINDS` allowlist (`:17`), which the migration currently never consults, so unknown kinds are dropped instead of passing through at `:187`.
- [x] 1.2 Ensure a dropped surface can never remain the persisted active surface, falling back to a valid surface or none.
- [x] 1.3 Extend `apps/web/src/rightPanelStore.test.ts` with unknown-kind drop, dropped-active-surface fallback, and known-kind preservation cases.
- [x] 1.4 Land this group on its own, ahead of every other group; it is independently valuable and cannot be retrofitted into already-shipped builds.

## 2. Wayfinder Markdown Parser

- [x] 2.1 Add `apps/server/src/wayfinder/WayfinderMarkdown.ts` as a pure module with no Effect and no filesystem access.
- [x] 2.2 Implement the fence pre-pass classifying every line as structural or fenced before any heading or field scan, honouring backtick and tilde fences and opening-fence length.
- [x] 2.3 Implement frontmatter metadata parsing reusing the `FRONTMATTER_PATTERN` regex and `yaml` package pattern from `apps/server/src/provider/Drivers/ClaudeSkills.ts:19-33`.
- [x] 2.4 Implement `**Field:** value` metadata parsing over leading structural lines, normalising to the same model as the frontmatter dialect.
- [x] 2.5 Implement derived status with precedence `out_of_scope` > `resolved` > `claimed` > `open`, requiring prose rather than a bare heading.
- [x] 2.6 Implement blocker resolution: coerce references to string, match by `id` then `ordinal` then zero-pad-normalised, drop unresolvable references, and emit a lint naming the referencing ticket.
- [x] 2.7 Implement Kahn ranking with cycle handling, assigning unemitted nodes `maxRank + 1` and a cyclic flag, and guaranteeing termination.
- [x] 2.8 Derive `isFrontier` and `isUndermined` from blocker status and `undermines` edges.
- [x] 2.9 Parse fog entries, decisions, out-of-scope entries, destination, notes, and counts into the normalised map model.
- [x] 2.10 Emit lints for malformed frontmatter, malformed map metadata, unresolved blockers, and truncated content; never throw for content problems.
- [x] 2.11 Add `WayfinderMarkdown.test.ts` covering the status truth table as `it.each`; fence transparency in three forms (backtick fence containing `## Answer` plus prose leaves the ticket open, the same with `~~~`, and a four-backtick fence containing a three-backtick one); `blocked_by: [02, 03]` and `[2, 3]` resolving identically; `[99]` yielding a lint and no edge; both dialects' metadata; fog bullets with and without `<clears-with>`; and frontier derivation flipping when a blocker changes state.

## 3. Wayfinder Maps Service

- [x] 3.1 Add `apps/server/src/wayfinder/WayfinderMaps.ts` as an Effect service depending only on `WorkspacePaths`, `FileSystem`, and `Path`.
- [x] 3.2 Implement discovery as three bounded probes — `readDirectory(<root>/.plan/maps)`, `readDirectory(<root>/.plan)`, and `stat(<root>/wayfinder-map.md)` — with no tree walk, routing every path through `WorkspacePaths.resolveRelativePathWithinRoot` (`apps/server/src/workspace/WorkspacePaths.ts:202-231`).
- [x] 3.3 Enforce caps of 24 maps, 200 tickets per map, 600 total nodes, 64 KiB per ticket, 256 KiB per map, and 200-character titles, using bounded `open`/`read`/`close` (pattern at `WorkspaceFileSystem.ts:216-229`) rather than `readFileString`, and surface truncation as flags plus lints.
- [x] 3.4 Expose a public `refresh(cwd)` method that recomputes and publishes, so freshness is testable without driving the OS watcher.
- [x] 3.5 Implement fingerprint dedupe: sort tickets by filename and edges by `(from, to, kind)`, `JSON.stringify` the snapshot, and publish only on change, following the debounce reasoning at `apps/server/src/serverSettings.ts:529-547`.
- [x] 3.6 Watch `<root>/.plan` only, never the workspace root, and document in-file why recursive watching of the root would exhaust inotify watches.
- [x] 3.7 Implement the bootstrap re-arm probe for a missing `.plan` directory, with the interval injectable exactly as `VcsStatusBroadcaster` injects `automaticRemoteRefreshInterval` (see `ws.ts:1867`), stopping once the watcher arms.
- [x] 3.8 Refcount per-root instances with `LayerMap.Service`, following `WorkspaceSearchIndexMap` (`apps/server/src/workspace/WorkspaceSearchIndex.ts:555-561`), including `idleTimeToLive` and teardown on last release.
- [x] 3.9 Return an empty snapshot when `.plan` is absent, and reserve typed errors for workspace-root resolution and path-escape failures.
- [x] 3.10 Add `WayfinderMaps.test.ts` as a layer test copying the harness at `apps/server/src/workspace/WorkspaceFileSystem.test.ts:15-54` (`NodeServices.layer`, `makeTempDirectoryScoped`): discovers both dialects in one repo; caps produce `truncated` plus a lint; absent `.plan` returns an empty snapshot rather than an error; two `refresh` calls with no change emit once and a third with a change emits again; and the bootstrap probe is driven with `TestClock`, never a sleep.

## 4. Contract and Server Wiring

- [x] 4.1 Add `packages/contracts/src/wayfinder.ts` defining `WayfinderMapsSnapshot`, `WayfinderMap`, `WayfinderNode`, `WayfinderEdge`, `WayfinderFogEntry`, and `WayfinderLint`, with no ticket bodies and no node positions.
- [x] 4.2 Export the new module from the contracts barrel in `packages/contracts/src/index.ts`.
- [x] 4.3 Register `subscribeWayfinderMaps` in `WS_METHODS`, `Rpc.make`, and `RpcGroup.make` in `packages/contracts/src/rpc.ts` as a plain `stream: true` struct, following `subscribeBackgroundPolicy` / `subscribeResourceTelemetry` at `:791-803`.
- [x] 4.4 Declare the method's authorization scope in `apps/server/src/auth/RpcAuthorization.ts` as `AuthOrchestrationReadScope`; the `satisfies Readonly<Record<WsRpcMethod, AuthEnvironmentScope>>` at `:105` makes omission a type error.
- [x] 4.5 Wire the service layer in `apps/server/src/server.ts` near `WorkspaceLayerLive`.
- [x] 4.6 Add the handler in `apps/server/src/ws.ts` via `observeRpcStream`, modelled on the `subscribeVcsStatus` handler at `:1863-1872`, resolving cwd as `thread.worktreePath ?? project.workspaceRoot` (`:1858`) and ensuring the map and its ticket relative paths resolve against that same root.
- [x] 4.7 Add a focused test proving a worktree thread's map path and node paths resolve against the worktree path rather than the project workspace root.

## 5. Client Plumbing

- [x] 5.1 Add `subscribeWayfinderMaps` to `EnvironmentSubscriptionRpcTag` in `packages/client-runtime/src/rpc/client.ts:42-55`.
- [x] 5.2 Add `packages/client-runtime/src/state/wayfinder.ts` exposing the subscription through `createEnvironmentRpcSubscriptionAtomFamily`, following `packages/client-runtime/src/state/preview.ts:37-46`.
- [x] 5.3 Add the `state/wayfinder` subpath entry to `packages/client-runtime/package.json` exports.
- [x] 5.4 Instantiate the atoms in `apps/web/src/state/wayfinder.ts`, mirroring `apps/web/src/state/preview.ts:1-5`.

## 6. Panel Shell and List View

- [x] 6.1 Add the `map` kind to `RIGHT_PANEL_KINDS` and `RightPanelSurface` in `apps/web/src/rightPanelStore.ts`, and extend `singletonSurface()` (`:85-96`) with the `{ id: "map"; kind: "map" }` case.
- [x] 6.2 Add the `map` case to `surfaceTitle()` (`RightPanelTabs.tsx:189-219`) and to `SurfaceIcon()` (`:237-270`), and give `SurfaceIcon` an explicit return type so a missing case is a compile error rather than an icon-less tab.
- [x] 6.3 Add the map entry to the right-panel empty-state actions (`RightPanelTabs.tsx:98-131`) and the add-surface menu (`:446-473`), with a disabled reason when unavailable.
- [x] 6.4 Add a **required** `mapAvailable` prop to `RightPanelTabsProps` and pass `activeProject !== null` at **both** call sites in `ChatView.tsx` — the inline site at `:6273` and the sheet site at `:6300` — alongside the existing `browserAvailable` / `diffAvailable` / `filesAvailable` gates at `:6291-6293`.
- [x] 6.5 Add the `map` branch to the `rightPanelContent` ternary chain in `ChatView.tsx:5789-5862` with a lazy import, so the surface never renders as an empty body.
- [x] 6.6 Add `apps/web/src/components/map/StarMapPanel.tsx` with the header — back affordance, title, counts, and the map/list toggle — reusing the existing `.surface-subheader` class at `apps/web/src/index.css:399-401`, and add no maximize or close control of its own.
- [x] 6.7 Implement the accessible list view: canvas region marked `aria-hidden`, an adjacent `<ul>` of tickets sorted by rank then ticket number, each a `<button>` with a descriptive `aria-label` covering title, status, and blockers.
- [x] 6.8 Implement the two distinct empty states — no map in this project, and a map found but unparseable with its lints shown — plus the partially-parsed case that renders the map and keeps lints reachable.
- [x] 6.9 Add `StarMapPanel.logic.ts` as a pure reducer over `{ level, selectedMapId, selectedTicket }` with back and Escape transitions and selection reset when the selected ticket vanishes.
- [x] 6.10 Add `StarMapPanel.logic.test.ts` covering back and Escape transitions, level pushes, and selection reset on a snapshot that no longer contains the selected ticket.
- [x] 6.11 Add `rightPanelStore.test.ts` cases for map singleton open, idempotent reopen, close, and persistence round trip.

## 7. Pure Geometry

- [x] 7.1 Add `starMapGraph.ts` converting a snapshot to a normalised graph with derived status, Kahn rank, and cycle flags.
- [x] 7.2 Add `starMapLayout.ts` performing rank-biased relaxation in a panel-independent 1000-unit virtual space, seeding each node's angle from `hash32(ticketNumber)` alone rather than a rank-sorted index or golden-angle spiral.
- [x] 7.3 Implement the force set: linear-falloff repulsion with a hard cutoff, edge springs with rest length scaled by rank gap, radial pull toward `targetR(rank)`, and centroid subtraction in place of a gravity term, cooling linearly to exactly zero over roughly 300 iterations with no velocity and no live simulation.
- [x] 7.4 Add the deterministic 10-iteration separation post-pass that guarantees minimum pairwise separation, and return `{ iterations, pairChecks }` from the solver.
- [x] 7.5 Add `starMapCamera.ts` with fit-to-bounds, clamping, and screen↔world transforms.
- [x] 7.6 Add `starMapLabels.ts` with deterministic placement, collision suppression favouring the lower ticket number, and degradation to ticket numbers only below the narrow-label threshold.
- [x] 7.7 Run layout once per map content revision inside a `useMemo` keyed on a content revision string rather than array identity, so panel resize never re-runs the solver.
- [x] 7.8 Add geometry tests: determinism (two calls deep-equal), order independence (shuffled input yields identical output), stability (one added leaf moves existing nodes less than 2% of the bounding radius), rank monotonicity across at least 90% of edges, minimum pairwise separation, no `NaN`, and assertions on the returned `{ iterations, pairChecks }` rather than wall-clock time.

## 8. Canvas Engine

- [x] 8.1 Add `starMapTheme.ts` scoping map tokens under `[data-star-map]` with light and dark variants, following the `[data-sidebar-version]` technique at `apps/web/src/index.css:949-997`, and basing status hues on `--success` / `--warning` / `--info` / `--destructive`, which `APPEARANCE_MANAGED_SEMANTIC_PROPERTIES` (`apps/web/src/appearance/applyAppearance.ts:18-37`) does not manage.
- [x] 8.2 Add `starMapRenderer.ts` as an engine class owning the `requestAnimationFrame` loop, reading theme tokens once per theme change rather than per frame.
- [x] 8.3 Implement device-pixel-ratio handling with `ResizeObserver` for sizing plus a `matchMedia('(resolution: Xdppx)')` listener for monitor-to-monitor drags; `devicePixelRatio` appears nowhere in the repo today, so this is new code to write rather than a pattern to copy.
- [x] 8.4 Implement hard stops on `document.hidden`, window blur, inactive surface, and `IntersectionObserver` off-screen; the visibility gate is required because `RightPanelSheet` uses `keepMounted`, so hidden is not unmounted.
- [x] 8.5 Implement `prefers-reduced-motion` handling: render exactly one static frame, never start the loop, and default the surface to the list view.
- [x] 8.6 Implement the dual rate — interaction at full refresh, ambient motion on a ~30 fps accumulator decaying to a slow tick after roughly 10 s idle.
- [x] 8.7 Render the constellation: parallax starfield, per-status star glow, curved `blocked_by` edges, frontier pulse, and flow particles drifting blocker to dependent along satisfied edges.
- [x] 8.8 Mount the canvas in `StarMapPanel.tsx` and implement pan and zoom, registering the wheel handler as a **native** listener with `{ passive: false }` because React's synthetic `onWheel` is registered passively at the root and `preventDefault()` there is a no-op (precedent: `apps/web/src/components/chat/MessagesTimeline.tsx:606`).
- [x] 8.9 Implement selection with eased camera movement, keeping the canvas selection and the accessible list selection in sync in both directions.
- [x] 8.10 Implement the ticket detail view rendering the file read through the existing workspace file read path and `apps/web/src/components/ChatMarkdown.tsx`, with blocker chips that navigate to the blocking ticket, and add no wayfinder-specific ticket retrieval RPC.
- [x] 8.11 Implement the container-query split above roughly 720 px using `@container` (already used at `apps/web/src/index.css:286-292`) rather than a viewport media query, because `PreviewPanelShell` sets an explicit pixel width independent of the viewport.

## 9. Reverse States and Documentation

- [x] 9.1 Add a reset-view control that refits the camera to the current map, so panning or zooming into empty space is recoverable.
- [x] 9.2 Decide and implement the ticket-to-file action: `openFile(ref, relativePath)` silently closes an open standalone Files surface (`apps/web/src/rightPanelStore.ts:262-267`), so either accept and document that behaviour or route through an explorer-preserving variant.
- [x] 9.3 Handle the selected map disappearing from disk while the panel is open by returning to the map list with the appropriate empty state.
- [x] 9.4 Add `docs/user/` copy for the map surface in shipped-product voice, with no repo tooling or source paths.
- [x] 9.5 Add `docs/internals/glossary.md` entries for _wayfinder map_, _ticket_, _frontier_, _fog_, and _undermined_, as required by `AGENTS.md:75`.
- [x] 9.6 Record the explicit mobile decision — not supported, because `apps/mobile` has no right panel and `ThreadInspectorMode` is `"route" | "git" | "files"` (`apps/mobile/src/features/threads/thread-inspector-content-stack.tsx:4`) — and confirm no mobile surface changed.

## 10. Verification

- [x] 10.1 Run the focused suites only with `vp test run <files>` for `WayfinderMarkdown.test.ts`, `WayfinderMaps.test.ts`, the geometry tests, `StarMapPanel.logic.test.ts`, and `rightPanelStore.test.ts`; run no repo-wide checks.
- [x] 10.2 Run targeted lint and typecheck across only the touched scopes.
- [x] 10.3 Seed a manual fixture: `.plan/design/map.md` plus `.plan/design/tickets/01..14-*.md` covering resolved, claimed, frontier, blocked, and out-of-scope states, one cycle, one dangling `blocked_by`, and one ticket that quotes the wayfinder format inside a fence.
- [x] 10.4 Start `vp run dev` in a worktree, reading the real port from the `[dev-runner]` line, then open the right panel, add the Map surface, and confirm the constellation, the frontier stars, and that the fenced ticket did not resolve itself.
- [x] 10.5 Verify live update: with the panel open, add answer prose to a frontier ticket and save, then confirm the star changes state and its dependents ignite without a reload.
- [ ] 10.6 Walk the interactions: pan, zoom, select a star, open ticket detail, follow a blocker chip, and press Escape twice.
- [ ] 10.7 Resize the panel to 360 px and then below 980 px so it becomes a sheet, confirming labels degrade and List becomes the default.
- [ ] 10.8 Toggle light theme and a custom appearance theme, confirming the panel stays legible and status colours stay distinguishable in both.
- [ ] 10.9 Enable `prefers-reduced-motion` and confirm exactly one static frame with no loop.
- [ ] 10.10 Switch to another right-panel surface and confirm the loop stops, via a DevTools performance profile or a frame counter behind a debug flag; if idle GPU cost is still meaningful on a high-refresh display, apply the pre-agreed fallback of dropping ambient motion to interaction-only.
- [ ] 10.11 Verify both empty states: a project with no `.plan/`, and a `map.md` with deliberately broken frontmatter.
- [ ] 10.12 Capture a before/after image and a short video of the motion for the eventual pull request, per the repository's pull-request rules.

## 11. Local-Markdown Tracker Dialect

Added after implementation: the wayfinder skill's local-markdown tracker writes a third
on-disk shape that neither existing dialect reads. Verified empirically — `Blocked by:`
produced zero edges and `Status: claimed` parsed as `open`, so the graph was lost entirely.

- [x] 11.1 Add the `plain-lines` metadata dialect to `WayfinderMarkdown.ts`: unbolded `Field: value` lines over leading structural lines, normalising `Type:`, `Status:`, and `Blocked by:` into the same model as the other two dialects.
- [x] 11.2 Map `Status: resolved` and `Status: claimed` into the existing derived-status precedence rather than adding a parallel status path; `## Answer` prose still resolves, and the fence pre-pass still governs.
- [x] 11.3 Parse `Blocked by: 01, 02` (bare comma-separated numbers, no YAML array) through the existing id/ordinal/zero-pad blocker resolution, including the unresolvable-reference lint.
- [x] 11.4 Extend `WayfinderMarkdown.test.ts` with the plain-lines dialect: all four statuses, comma-separated blockers, an empty `Status:` line, and fence transparency in the new dialect.
- [x] 11.5 Extend discovery in `WayfinderMaps.ts` to probe `<root>/.scratch` alongside `<root>/.plan`, and to accept an `issues/` ticket directory as well as `tickets/`.
- [x] 11.6 Extend `WayfinderMaps.test.ts` to discover a `.scratch/<effort>/issues/` map, and confirm `.plan/` and `.scratch/` maps coexist in one snapshot without id collisions.
- [x] 11.7 Document the third dialect and the `.scratch/` location in `docs/internals/wayfinder-maps.md`; confirm `docs/user/` copy stays location-agnostic.

## 12. Worktree Root Scope

Added after implementation: the panel followed `thread.worktreePath ?? project.workspaceRoot` and
nothing else, so a worktree thread read its own root — which is usually a clean checkout without the
uncommitted `.plan/` — and the map went empty the moment work moved into a worktree. The two roots
are both legitimate, so the choice is the user's.

- [x] 12.1 Add `resolveStarMapScope`, `autoStarMapScope`, and `workspaceRootLabel` to `StarMapPanel.logic.ts`, plus a `reset` reducer action for the root switch, and cover them in `StarMapPanel.logic.test.ts`.
- [x] 12.2 Widen the persisted map surface to `{ id: "map"; kind: "map"; scope?: StarMapScope }` with a `setMapScope` action, a `selectMapSurfaceScope` selector, and migration that re-arms the automatic pick for an unrecognised scope; cover all three in `rightPanelStore.test.ts`.
- [x] 12.3 Pass both roots from `ChatView.tsx` and key the panel on the project root, so choosing a root does not remount the panel and discard camera and selection.
- [x] 12.4 Subscribe to the second root only while the choice is undecided, relying on the cwd-keyed atom family so latching onto the project root reuses that subscription instead of opening another.
- [x] 12.5 Render the root control at the map list only, labelled with the worktree's own name, and name the searched root in the absent-map empty state.
- [x] 12.6 Disclose the root on the ticket level and withdraw open-as-file whenever the panel is not reading the thread's own root, because the file surface can only address that root.
- [x] 12.7 Update `docs/internals/wayfinder-maps.md` and `docs/user/wayfinder-maps.md` for the two roots and the control.
- [ ] 12.8 Walk it in a worktree thread whose `.plan/` lives only in the project root: confirm the automatic fall-back, the control, persistence across a reload, and that switching roots does not claim the map was removed from disk.
