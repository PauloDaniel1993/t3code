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
