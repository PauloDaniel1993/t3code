## ADDED Requirements

### Requirement: Discover wayfinder maps within the workspace root

The system SHALL discover wayfinder maps for a resolved workspace root using bounded probes of `<root>/.plan/maps`, `<root>/.plan`, and `<root>/wayfinder-map.md`. The system MUST NOT perform a recursive tree walk of the workspace to locate maps. Every path the system reads MUST be resolved through the existing workspace path resolution so that paths escaping the workspace root are rejected. Absence of a `.plan` directory MUST produce an empty snapshot rather than an error.

#### Scenario: Discover a map under the plan directory

- **WHEN** a workspace root contains `.plan/<effort>/map.md` with a sibling `tickets/` directory
- **THEN** the system returns one map whose nodes correspond to the ticket files

#### Scenario: No plan directory exists

- **WHEN** a workspace root contains no `.plan` directory and no `wayfinder-map.md`
- **THEN** the system returns a snapshot containing no maps and reports no error

#### Scenario: Path escaping the workspace root

- **WHEN** a discovered candidate path resolves outside the workspace root
- **THEN** the system rejects that path with a typed error and does not read it

#### Scenario: Discovery does not walk the workspace

- **WHEN** the workspace contains large unrelated directories such as `node_modules`
- **THEN** discovery reads only the bounded probe locations and does not enumerate those directories

### Requirement: Classify fenced content before parsing structure

The parser SHALL classify every line of a map or ticket file as structural or fenced before scanning for headings or metadata fields. Fence classification MUST honour both backtick and tilde fences and MUST respect the opening fence length so that a longer fence may contain a shorter one. Content inside a fence MUST NOT contribute to headings, metadata fields, or derived status.

#### Scenario: Fenced heading does not resolve a ticket

- **WHEN** a ticket contains a fenced code block whose body includes an `## Answer` heading followed by prose, and no unfenced answer
- **THEN** the ticket's derived status is `open`

#### Scenario: Tilde fence is honoured

- **WHEN** a ticket wraps an `## Answer` heading and prose inside a `~~~` fence
- **THEN** the ticket's derived status is `open`

#### Scenario: Longer fence contains a shorter fence

- **WHEN** a ticket opens a four-backtick fence containing a three-backtick fence and structural-looking headings
- **THEN** all content up to the matching four-backtick close is treated as fenced

### Requirement: Derive ticket status from prose

The system SHALL derive ticket status rather than read it from a stored field, using the precedence `out_of_scope` over `resolved` over `claimed` over `open`. A ticket SHALL be `out_of_scope` when prose appears under `## Ruled out`, `resolved` when prose appears under `## Answer` or `## Resolution` or when a `Status` field is `closed`, `claimed` when a `claimed_by` value is present, and `open` otherwise. A heading followed only by whitespace, or immediately by another heading, MUST NOT change the derived status.

#### Scenario: Answer with prose resolves the ticket

- **WHEN** a ticket has an `## Answer` heading followed by prose
- **THEN** the ticket's derived status is `resolved`

#### Scenario: Empty answer heading leaves the ticket open

- **WHEN** a ticket has an `## Answer` heading followed only by whitespace or immediately by another heading
- **THEN** the ticket's derived status is `open`

#### Scenario: Ruled out outranks a resolution

- **WHEN** a ticket has prose under both `## Ruled out` and `## Resolution`
- **THEN** the ticket's derived status is `out_of_scope`

#### Scenario: Claimed ticket without an answer

- **WHEN** a ticket sets a `claimed_by` value and has no answer, resolution, or ruled-out prose
- **THEN** the ticket's derived status is `claimed`

### Requirement: Normalise both file dialects to one model

The system SHALL parse metadata from YAML frontmatter when present and otherwise from `**Field:** value` lines among the leading structural lines. Both dialects MUST produce the same normalised model for equivalent content. The snapshot MAY carry a `dialect` literal for diagnostics only, and consumers MUST NOT be required to branch on it to interpret any other field.

#### Scenario: Frontmatter dialect

- **WHEN** a map and its tickets declare metadata in YAML frontmatter
- **THEN** the system produces normalised nodes, edges, and metadata for that map

#### Scenario: Field-line dialect

- **WHEN** a map and its tickets declare metadata as `**Field:** value` lines outside any fence
- **THEN** the system produces a normalised model equivalent to the frontmatter form of the same content

#### Scenario: Both dialects in one workspace

- **WHEN** a workspace root contains one map in each dialect
- **THEN** the system discovers both and returns them in one snapshot

### Requirement: Resolve blocker references tolerantly and drop unresolvable edges

The system SHALL coerce every blocker reference to a string and resolve it against ticket `id`, then ticket `ordinal`, then a zero-pad-normalised comparison, so that both quoted and numeric list forms resolve to the same tickets. When a blocker reference cannot be resolved, the system SHALL omit the edge and emit a lint identifying the referencing ticket and the unresolved reference. The system MUST NOT emit an edge that points at a node absent from the snapshot.

#### Scenario: Zero-padded blocker list

- **WHEN** a ticket declares `blocked_by: [02, 03]`
- **THEN** the system emits edges to the tickets with ordinals 2 and 3

#### Scenario: Unpadded blocker list

- **WHEN** a ticket declares `blocked_by: [2, 3]`
- **THEN** the system emits the same edges as the zero-padded form

#### Scenario: Unresolvable blocker

- **WHEN** a ticket declares a blocker reference matching no ticket in the map
- **THEN** the system emits no edge for that reference and emits a lint naming the referencing ticket

### Requirement: Rank nodes and terminate on cyclic blocker graphs

The system SHALL assign each node a rank derived from its blocker depth using a topological pass. When the blocker graph contains a cycle, the system SHALL assign every node not emitted by that pass a rank one greater than the maximum emitted rank and mark it as cyclic. Ranking MUST terminate for any input.

#### Scenario: Acyclic map ranks by depth

- **WHEN** a map's blocker relations form a directed acyclic graph
- **THEN** each node's rank reflects its depth from the unblocked roots

#### Scenario: Cyclic blocker relations

- **WHEN** two or more tickets block each other directly or transitively
- **THEN** the system completes ranking, marks the participating nodes as cyclic, and assigns them a rank above the maximum acyclic rank

### Requirement: Derive frontier and undermined state from blocker status

The system SHALL mark a node as frontier when it is open and every one of its blockers is resolved or out of scope. A claimed node is NOT frontier: the frontier answers "what can I pick up right now", and a ticket someone has already claimed is not takeable. This matches the wayfinder skill, which defines the frontier as the open, unblocked, and unclaimed children. The system SHALL mark a node as undermined when it is the target of an `undermines` edge from a node that is not resolved. Frontier and undermined state MUST be recomputed whenever any blocker's derived status changes.

#### Scenario: Unblocked open ticket is frontier

- **WHEN** an open ticket has no blockers, or all of its blockers are resolved
- **THEN** the system marks that node as frontier

#### Scenario: Frontier changes when a blocker resolves

- **WHEN** the only unresolved blocker of an open ticket becomes resolved
- **THEN** that ticket becomes frontier in the next snapshot

#### Scenario: Resolved ticket is not frontier

- **WHEN** a ticket is resolved or out of scope
- **THEN** the system does not mark it as frontier

#### Scenario: Claimed ticket is not frontier

- **WHEN** a ticket is claimed and every one of its blockers is resolved or out of scope
- **THEN** the system does not mark it as frontier, because someone is already working it

### Requirement: Bound every read and report truncation

The system SHALL enforce caps on maps per snapshot, tickets per map, total nodes, bytes per ticket, bytes per map, and title length. File reads MUST use bounded reads so that an oversized file costs at most the per-file cap. When any cap is reached, the system SHALL set a truncation flag on the affected scope and emit a lint identifying what was truncated.

#### Scenario: Oversized ticket file

- **WHEN** a ticket file exceeds the per-ticket byte cap
- **THEN** the system reads at most the cap, emits a `ticket_truncated` lint, and marks the map as truncated

#### Scenario: Too many tickets in one map

- **WHEN** a map directory contains more ticket files than the per-map cap
- **THEN** the system returns the capped set, marks the map as truncated, and emits a lint

#### Scenario: Truncation never silently changes status

- **WHEN** a ticket is truncated
- **THEN** the snapshot reports the truncation so that a derived status computed from partial content is identifiable as such

### Requirement: Degrade malformed markdown to lints

The system SHALL report malformed map or ticket content as lints attached to the snapshot and SHALL return every map and node it could parse. Malformed content MUST NOT produce a failed subscription or an empty snapshot. Typed errors SHALL be reserved for workspace-root resolution failures and path-escape failures.

#### Scenario: Broken frontmatter in one ticket

- **WHEN** one ticket in a map has unparseable frontmatter
- **THEN** the system returns the map with the remaining tickets and emits a lint for the malformed ticket

#### Scenario: Broken map metadata

- **WHEN** a `map.md` has unparseable metadata
- **THEN** the system returns the map with default metadata and its parseable tickets, and emits a lint

#### Scenario: Errors are reserved for path failures

- **WHEN** the workspace root cannot be resolved
- **THEN** the system fails the request with a typed error rather than an empty snapshot

### Requirement: Watch the plan directory and publish only on content change

The system SHALL watch `<root>/.plan` for changes and MUST NOT install a watcher on the workspace root. When `.plan` does not exist, the system SHALL re-arm using a periodic existence probe whose interval is injectable for tests, and SHALL stop probing once the watcher arms. The system SHALL compute a fingerprint over the parsed snapshot with tickets ordered by filename and edges ordered by source, target, and kind, and SHALL publish a new snapshot only when that fingerprint changes.

#### Scenario: Repeated filesystem events for one save

- **WHEN** a single editor save produces several filesystem events with no resulting content change
- **THEN** the system publishes at most one snapshot

#### Scenario: Content change republishes

- **WHEN** a ticket's content changes such that its derived status changes
- **THEN** the system publishes a new snapshot reflecting the change

#### Scenario: Directory ordering does not republish

- **WHEN** directory enumeration returns the same ticket files in a different order
- **THEN** the fingerprint is unchanged and the system does not publish

#### Scenario: Plan directory created later

- **WHEN** a subscription starts in a workspace with no `.plan` directory and `.plan` is created afterwards
- **THEN** the system arms its watcher and publishes the newly discovered maps

### Requirement: Expose maps through one authorized streaming subscription

The system SHALL expose a single streaming RPC that emits a wayfinder maps snapshot for the requesting thread's workspace and re-emits on change. The subscription SHALL resolve its workspace root the same way other workspace-scoped subscriptions do, preferring the thread's worktree path over the project workspace root, and every relative path in the snapshot MUST be interpreted against that same root. The method SHALL declare an authorization scope. The snapshot MUST NOT include ticket body text or node positions.

#### Scenario: Subscribe and receive an initial snapshot

- **WHEN** a client subscribes for a thread whose project contains maps
- **THEN** the system emits one snapshot describing those maps, their nodes, edges, counts, and lints

#### Scenario: Worktree thread paths

- **WHEN** the subscribing thread has a worktree path distinct from the project workspace root
- **THEN** the map path and every node path in the snapshot resolve against the worktree path

#### Scenario: Snapshot excludes ticket bodies

- **WHEN** the system emits a snapshot
- **THEN** each node carries a relative path for later retrieval and no ticket body text or layout position

#### Scenario: Missing authorization scope

- **WHEN** the RPC method is registered
- **THEN** it declares a required authorization scope alongside every other websocket method

#### Scenario: Subscriber release stops the watcher

- **WHEN** the last subscriber for a workspace root disconnects
- **THEN** the system releases the shared watcher for that root
