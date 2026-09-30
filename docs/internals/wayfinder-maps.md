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
junctions followed) and only reads it when that is the path itself under the real project root.
Nothing is read through a link, even one that stays inside the project: the watches do not follow
links, so a map read through one would never update. Watching link targets would need a changing
set of extra watches, which a map behind a link is not worth. A path that goes through a link reads
exactly as a missing file does. The lexical check in `WorkspacePaths` alone is not enough for this.

A link swapped in while a file is read is the hard case, because Node has no `openat` and no call
that names an open handle. On Linux the check is made on the descriptor, through `/proc/self/fd`.
On Windows and macOS the path is resolved again after the open and must name the same file, which a
process renaming a project folder away, back and away again within one read can defeat. The comment
on `makeWayfinderFiles` states the guarantee; do not widen it without a handle-based check.

The supported layouts are `.plan/<effort>/map.md` with `tickets/`,
`.plan/maps/<effort>/map.md` with `tickets/`, `.scratch/<effort>/map.md` with `issues/`, and the
root `wayfinder-map.md` with `.plan/tickets/`. Map ids preserve the existing `<effort>` and
`maps/<effort>` forms for `.plan`, use `scratch/<effort>` for `.scratch`, and use `wayfinder-map`
for the root file. The namespace keeps equally named `.plan` and `.scratch` efforts distinct.

Map and ticket markdown is normalised from three dialects into one snapshot model: YAML
frontmatter, bold `**Field:** value` lines, and plain `Field: value` lines. The plain-lines dialect
is used by the local-markdown tracker under `.scratch`; its `Type`, `Status`, and `Blocked by`
fields feed the same status and blocker model as the other dialects.

The service runs three supervised watchers, each with a missing-directory re-arm probe: `.plan`
and `.scratch` recursively, so a ticket in a nested folder is seen, and the workspace root without
recursion, for `wayfinder-map.md`. Recursing on the root would traverse `node_modules` and `.git`.

Agents write thousands of unrelated files under `.scratch`, so the watches use Node's `fs.watch`
directly rather than `FileSystem.watch`, which stats every renamed path and queues every event
before any filter runs. Each event is checked against `wayfinderPathKind`, the same rule discovery
uses for names, and a relevant one fills a single pending slot per root. A folder's `change` events
are ignored: on Windows they are timestamp updates caused by the files inside. A root is ready only
once its watches are armed, and every subscriber and refresh waits for that, so no scan precedes the
watches and no change can fall between them and the first scan.

A scan is bounded in what it looks at as well as in what it keeps. Directory listings stop at a
fixed number of entries, at most 128 candidate maps are probed, and a ticket folder is read up to a
fixed entry count; reaching any of them marks the snapshot truncated. Scans of one root are
coalesced and start at least a second apart, measured from when a scan actually starts, and two
scans run at once across all roots. The last start is kept by real path outside the root, so
closing and reopening a folder does not reset the spacing. That record holds only starts younger
than the interval and at most 256 of them, so the spacing can lapse for a folder only when 256
others start scans within that second.

Roots are keyed by real path, so every spelling of a folder shares one root. A root lives only
while a subscription holds it: it closes, watches and all, when its last subscriber leaves or that
subscriber's connection closes. A refresh never creates, revives or holds one: it rescans only a
root that has a subscriber when it arrives, and one whose root closes during the scan ends as a
refresh of a folder with no maps does. A connection holds at
most 16 subscriptions; past that a subscription fails with `capacity_reached`, which the panel
shows. There is deliberately no server-wide cap: roots are released promptly and the scan gate
bounds disk work across clients, so a server cap would only let one client shut the others out.

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
