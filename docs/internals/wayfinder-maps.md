# Wayfinder Maps

> For maintainers. Using T3 Code? See [the user guide](../user/wayfinder-maps.md).

The wayfinder Map surface is deliberately asymmetric across clients. The server exposes a
workspace-scoped, read-only snapshot, while each client decides whether its navigation has a place
to present it.

## Discovery and Dialects

Discovery uses four bounded top-level probes rather than walking the workspace tree:

- directory listings for `.plan/maps`, `.plan`, and `.scratch`
- a file stat for `wayfinder-map.md`

Every path goes through `WayfinderFiles.ts`, which resolves its real location (symlinks and Windows
junctions followed) and only reads it when that is inside the real project root. Anything that
leaves the root, including a link to a folder or file outside it, reads as absent and is logged. A
file read is checked again after it opens, since a link could be swapped in between the check and
the open. The lexical check in `WorkspacePaths` alone is not enough for this.

The supported layouts are `.plan/<effort>/map.md` with `tickets/`,
`.plan/maps/<effort>/map.md` with `tickets/`, `.scratch/<effort>/map.md` with `issues/`, and the
root `wayfinder-map.md` with `.plan/tickets/`. Map ids preserve the existing `<effort>` and
`maps/<effort>` forms for `.plan`, use `scratch/<effort>` for `.scratch`, and use `wayfinder-map`
for the root file. The namespace keeps equally named `.plan` and `.scratch` efforts distinct.

Map and ticket markdown is normalised from three dialects into one snapshot model: YAML
frontmatter, bold `**Field:** value` lines, and plain `Field: value` lines. The plain-lines dialect
is used by the local-markdown tracker under `.scratch`; its `Type`, `Status`, and `Blocked by`
fields feed the same status and blocker model as the other dialects.

The service runs three supervised watchers, each with a missing-directory re-arm probe:

- `.plan` and `.scratch`, watched recursively, because Effect's `FileSystem.watch` is not recursive
  unless asked. This is what delivers a change to a ticket file in a nested directory.
- the workspace root, watched without recursion and filtered to `wayfinder-map.md`, for the root
  map file. Recursing here would also traverse `node_modules` and `.git`.

A watched directory is resolved to its real path first, so a link out of the project is never
watched. Each watcher takes its OS watch before its arming scan, so a change made before the watch
existed is still picked up.

A scan is bounded in what it looks at as well as in what it keeps. Directory listings stop at a
fixed number of entries, at most 128 candidate maps are probed, and a ticket folder is read up to a
fixed entry count; reaching any of them marks the snapshot truncated. Scans of one root are also
coalesced and spaced: callers that arrive while a scan is waiting or running share the next one, and
scans of one root start at most once a second. A fixed number of scans run at once across all roots.
The first scan of a root happens on first use, so a refresh of a fresh root is one scan.

The header reload action sends a workspace-scoped RPC through the active environment. It runs the
same refresh as the watchers and publishes a snapshot only when the parsed content changed, so
manual reloads work remotely without resending an unchanged graph.
The map, ticket, node, byte, and title caps apply once to the combined snapshot across both
discovery roots.

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
