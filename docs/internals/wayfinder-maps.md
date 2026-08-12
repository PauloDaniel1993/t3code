# Wayfinder Maps

> For maintainers. Using T3 Code? See [the user guide](../user/wayfinder-maps.md).

The wayfinder Map surface is deliberately asymmetric across clients. The server exposes a
workspace-scoped, read-only snapshot, while each client decides whether its navigation has a place
to present it.

## Discovery and Dialects

Discovery uses four bounded top-level probes rather than walking the workspace tree:

- directory listings for `.plan/maps`, `.plan`, and `.scratch`
- a file stat for `wayfinder-map.md`

The supported layouts are `.plan/<effort>/map.md` with `tickets/`,
`.plan/maps/<effort>/map.md` with `tickets/`, `.scratch/<effort>/map.md` with `issues/`, and the
root `wayfinder-map.md` with `.plan/tickets/`. Map ids preserve the existing `<effort>` and
`maps/<effort>` forms for `.plan`, use `scratch/<effort>` for `.scratch`, and use `wayfinder-map`
for the root file. The namespace keeps equally named `.plan` and `.scratch` efforts distinct.

Map and ticket markdown is normalised from three dialects into one snapshot model: YAML
frontmatter, bold `**Field:** value` lines, and plain `Field: value` lines. The plain-lines dialect
is used by the local-markdown tracker under `.scratch`; its `Type`, `Status`, and `Blocked by`
fields feed the same status and blocker model as the other dialects.

The service watches only the `.plan` and `.scratch` directories, each with its own supervised
watcher and missing-directory re-arm probe. It never watches the workspace root because Effect's
recursive filesystem watcher would also traverse directories such as `node_modules` and `.git`.
The header reload action sends a workspace-scoped RPC through the active environment. It runs the
same bounded refresh as the watchers and publishes a snapshot only when the parsed content changed,
so manual reloads work remotely without resending an unchanged graph.
The map, ticket, node, byte, and title caps apply once to the combined snapshot across both
discovery roots.

## Root Scope

The subscription is workspace-scoped and takes the root from the client, so choosing between a
thread's worktree and its project workspace root is entirely a client decision — `ws.ts` passes
`input.cwd` through untouched and `WayfinderMapsMap` keys one supervised watcher per normalised
root.

Web reads one root at a time. A thread whose worktree differs from the project root gets a control
at the map list; the choice persists on the thread's `map` right-panel surface (`scope`), and its
absence is meaningful — it means the panel may still pick automatically. The automatic pick prefers
the thread's own worktree and only leaves it when the worktree reports no maps and the project root
reports at least one, which is the common case because `.plan/` is rarely committed to a feature
branch. It is latched per worktree rather than re-derived, so a map appearing later never moves the
panel under the user.

Both roots are subscribed only while that choice is pending. The atom family keys on cwd, so
latching onto the project root reuses the probe's subscription rather than opening a second one,
and the worktree's watcher is released instead of being left running behind a snapshot nobody
reads.

Every relative path in a snapshot belongs to the root it came from, so the ticket level reads
through the same cwd the snapshot did, and the header's reload sends that cwd rather than the
thread's. The two hand-offs are what cannot follow: `openFile` is wired to
`thread.worktreePath ?? project.workspaceRoot`, and the task draft cites the ticket's relative path
for an agent working in that same root. So while the panel reads the other root, the ticket level
discloses it and withdraws both actions rather than opening — or briefing an agent against — a
same-named file with different contents.

## Client Support

Web owns the right-panel surface. Desktop wraps the web client, so it presents the same Map surface
without a separate desktop implementation.

Mobile is intentionally not supported. It has no right-panel surface model: its thread inspector
defines [`ThreadInspectorMode`][mobile-inspector] as exactly `"route" | "git" | "files"` and renders
those mobile-specific panes. This feature does not add a `map` inspector mode or another mobile
entry point, and no file under `apps/mobile` should change for it.

The wayfinder subscription appearing in shared contracts and client runtime does not imply a mobile
surface. Do not add a mobile map mode as a parity fix. Supporting wayfinder maps on mobile would
require a separate product and navigation decision for the mobile inspector.

[mobile-inspector]: ../../apps/mobile/src/features/threads/thread-inspector-content-stack.tsx

## Map Rendering

The normalized graph keeps every declared `blocks` and `undermines` edge authoritative. The web
renderer derives a separate display backbone by transitively reducing only the acyclic portion of
the blocks graph. `undermines` edges and edges in or downstream of a cycle are always retained;
guessing a reduction there could hide the relationship that explains the cycle.

The resting map renders that backbone through a deterministic layered layout. Rank becomes the
vertical dependency phase, equal-rank tickets share a row, and downward/upward barycentric sweeps
order each row to reduce crossings. Broad rows use bounded spacing so the 200-ticket cap still fits
the camera. Edges use cubic curves with vertical row entry and exit handles; only same-rank cycle
links use a seeded side.

Focusing or selecting a ticket reveals all of its directly declared incoming and outgoing edges
and dims unrelated content. The all-links toggle restores the complete declared graph. Ticket
detail, frontier derivation, accessibility labels, and List view continue to consume the
authoritative edge set rather than the display backbone.
