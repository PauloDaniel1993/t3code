## Why

A wayfinder map is markdown an agent leaves on disk while charting a large, foggy effort as a graph of decision tickets linked by `blocked_by`. T3 Code can already run the skill that produces one, but has no way to see what it produced: reading a map today means opening twenty markdown files one at a time in the Files panel, which answers neither question a map exists to answer — **what can I pick up right now**, and **what is this one waiting on**. Both answers are graph-shaped, and no surface in the app renders a graph.

This is a **fork-local** feature and the design says so plainly. A wayfinder map is the output of one third-party skill, not a T3 Code concept, and a bespoke renderer for a third-party markdown convention is a fair thing for upstream to decline. `AGENTS.md:13` explicitly blesses forks; this is exactly the kind of thing that belongs in one.

## What Changes

- Add a server-side wayfinder map reader that discovers maps under a project's `.plan/` directory, parses both known file dialects into one normalised model, and watches for changes.
- Add one streaming RPC, `subscribeWayfinderMaps`, that pushes a ~12 KB snapshot only when the parsed content actually changes, so a project with no map and a project mid-edit both cost zero bytes at steady state.
- Derive ticket status (`open` / `claimed` / `resolved` / `out_of_scope`) from prose rather than storing it, and derive `frontier` (unblocked and actionable) from blocker status — the two things a map is read for.
- Degrade malformed markdown to typed **lints**, never errors: this markdown is written by an LLM mid-turn, and a hard error would blank the panel exactly when the user wants to see what the agent produced.
- Add a seventh right-panel surface kind, `map`, as a **singleton** alongside Diff / Files / Plan — not one tab per map. Effort selection is in-panel navigation.
- Render the map as a Canvas 2D constellation faithful to the reference (`rengwu/chartr`): parallax starfield, glowing stars per ticket, curved `blocked_by` edges, frontier pulse, and flow particles along satisfied edges.
- Ship a parallel accessible **List** view — canvas content is invisible to keyboard and screen readers — and surface it as a Map/List toggle that defaults to List below 380 px and under `prefers-reduced-motion`.
- Harden `migratePersistedRightPanelState` to drop persisted surfaces whose `kind` is not in the existing `RIGHT_PANEL_KINDS` allowlist, so older builds loading newer state no longer render an unlabelled, icon-less ghost tab.
- Record mobile as explicitly **not supported**: `apps/mobile` has no right panel, only `ThreadInspectorMode = "route" | "git" | "files"`.

## Capabilities

### New Capabilities

- `wayfinder-maps`: Server-side discovery, dialect-normalising parse, status/frontier derivation, bounded resource limits, lint reporting, filesystem watching, and the `subscribeWayfinderMaps` wire contract.
- `wayfinder-star-map`: The right-panel map surface — singleton surface lifecycle and persistence hardening, three-level Maps → Map → Ticket navigation, deterministic constellation layout, demand-driven canvas rendering, the accessible list view, responsive and theme behaviour, and empty/error states.

### Modified Capabilities

None.

## Impact

- **New** `apps/server/src/wayfinder/` — `WayfinderMarkdown.ts` (pure parse, no I/O) and `WayfinderMaps.ts` (Effect service over `WorkspacePaths` + `FileSystem` + `Path`, refcounted via `LayerMap.Service`).
- `apps/server/src/server.ts` layer wiring, `apps/server/src/ws.ts` handler via `observeRpcStream`, and a scope entry in `apps/server/src/auth/RpcAuthorization.ts` (the `satisfies Record<WsRpcMethod, …>` at `:105` makes omission a type error).
- **New** `packages/contracts/src/wayfinder.ts` plus `WS_METHODS` / `Rpc.make` / `RpcGroup.make` registration in `rpc.ts`.
- `packages/client-runtime` — `EnvironmentSubscriptionRpcTag` in `src/rpc/client.ts`, a new `src/state/wayfinder.ts` atom family, and a `package.json` subpath export.
- `apps/web` — `rightPanelStore.ts` (new kind + migration hardening), `RightPanelTabs.tsx` (title, icon, empty-state action, `+` menu, disabled reason), **both** `RightPanelTabs` call sites in `ChatView.tsx` (`:6273` inline and `:6300` sheet), and a new `apps/web/src/components/map/` module set.
- **Deliberate departure from `AGENTS.md:142`** ("No continuously repainting animations"): this ships a `requestAnimationFrame` loop. It is demand-driven — hard-stopped on `document.hidden`, window blur, inactive surface, `IntersectionObserver` off-screen, and `prefers-reduced-motion` — with ambient motion on a ~30 fps accumulator that decays after idle. The design names this as an accepted trade with a pre-agreed fallback, not an oversight.
- No relation to `2026-07-25-thread-tasks`: that models **work in flight** with real lifecycle status; this reads **decisions on disk**. They do not merge.
- Docs: `docs/user/` copy plus `docs/internals/glossary.md` entries for _wayfinder map_, _ticket_, _frontier_, _fog_, and _undermined_.
- No mobile implementation, no new dependency (the renderer is hand-written Canvas 2D — the repo has no graphics library today and this adds none).
