## ADDED Requirements

### Requirement: LSP code-navigation tools are exposed via the t3-code MCP server

The internal `t3-code` MCP server SHALL expose a code-navigation toolkit with the following read-only tools: go-to-definition, find references, hover (type/signature information), document symbols, workspace symbol search, and file diagnostics. Every tool in the toolkit SHALL be annotated as read-only and SHALL NOT modify workspace files or state.

#### Scenario: Agent looks up references for a symbol

- **WHEN** an agent session calls the find-references tool with a file path and symbol position inside its workspace
- **THEN** the tool returns the workspace-relative locations (path, line, column) of all references known to the language server, including declarations when requested

#### Scenario: Agent requests hover information

- **WHEN** an agent calls the hover tool for a position that resolves to a typed symbol
- **THEN** the tool returns the language server's type/signature and documentation text for that symbol

#### Scenario: Agent requests diagnostics for a file

- **WHEN** an agent calls the diagnostics tool for a supported file in its workspace
- **THEN** the tool returns the current errors and warnings with severity, message, and position

### Requirement: Tool calls resolve against the calling session's workspace

Each LSP tool call SHALL resolve file paths against the project workspace root (including worktree checkouts) of the MCP session making the call. Paths outside the session workspace SHALL be rejected with a typed error.

#### Scenario: Session bound to a worktree

- **WHEN** an agent session running in a worktree checkout calls an LSP tool with a relative path
- **THEN** the path resolves inside that worktree and results reference files in that worktree only

#### Scenario: Path escapes the workspace

- **WHEN** an agent calls an LSP tool with a path that resolves outside the session workspace root
- **THEN** the tool fails with a typed invalid-path error and no language-server request is issued

### Requirement: Language servers are managed per workspace with bounded lifecycle

The server SHALL spawn language-server processes lazily on the first LSP tool call for a workspace, reuse the running process for subsequent calls in the same workspace, shut it down after a configurable idle period, restart it with bounded retries after a crash, and dispose all language-server processes on server shutdown.

#### Scenario: First call spawns the language server

- **WHEN** the first LSP tool call arrives for a workspace with TypeScript sources
- **THEN** the TypeScript language server is spawned for that workspace root and the call completes against it

#### Scenario: Idle shutdown

- **WHEN** no LSP tool call has targeted a workspace for the configured idle period
- **THEN** that workspace's language-server process is stopped and its resources released

#### Scenario: Crash recovery with bounded retries

- **WHEN** a language-server process exits unexpectedly and a new tool call arrives for its workspace
- **THEN** the server restarts the language server and completes the call, and after repeated consecutive crashes it stops retrying and returns a typed unavailable error

#### Scenario: Request timeout

- **WHEN** a language-server request exceeds the configured timeout
- **THEN** the tool call fails with a typed timeout error and the session remains usable for subsequent calls

### Requirement: Language support is registry-based, TypeScript-first

Language-server integrations SHALL be defined in a registry keyed by language/file type so additional servers can be added without changing the toolkit. The initial registry SHALL support TypeScript and JavaScript (including TSX/JSX) via the TypeScript language server. Calls for unsupported file types SHALL fail with a typed error naming the supported languages.

#### Scenario: Unsupported language

- **WHEN** an agent calls an LSP tool on a file type with no registered language server
- **THEN** the tool returns a typed unsupported-language error listing the currently supported languages

### Requirement: All tool-capable provider sessions receive the toolkit

The LSP toolkit SHALL be gated by a new `lsp` MCP capability that is included in the capability set of every issued MCP session credential. Because all tool-capable providers (Codex, Claude, Cursor, Grok, OpenCode) already receive the `t3-code` MCP server at session start, the LSP tools SHALL be callable in their sessions without adapter changes. Tool handlers SHALL reject invocations whose credential lacks the `lsp` capability with a typed error.

#### Scenario: Tool-capable provider session can call LSP tools

- **WHEN** a session is started for Codex, Claude, Cursor, Grok, or OpenCode and the agent calls an LSP tool
- **THEN** the credential issued for that session carries the `lsp` capability and the call succeeds

#### Scenario: Credential without the lsp capability

- **WHEN** an MCP request reaches an LSP tool with a credential whose capability set does not include `lsp`
- **THEN** the tool fails with a typed unavailable error and no language-server request is issued

### Requirement: Tool responses are size-bounded

LSP tool responses SHALL be bounded to a configured maximum size or item count. When results are truncated, the response SHALL state the total match count and that truncation occurred.

#### Scenario: Reference list exceeds the limit

- **WHEN** a find-references call matches more locations than the configured limit
- **THEN** the response contains at most the limit, reports the total count, and indicates truncation

### Requirement: Tool descriptions steer models toward symbol-aware navigation

Each LSP tool description SHALL state the symbol-navigation task it solves and that it is preferred over text search for that task (for example: "use this instead of grep to find all usages of a symbol").

#### Scenario: Descriptions include preference guidance

- **WHEN** the MCP tool list is served to an agent session
- **THEN** every LSP tool description names its use case and its preference over text search for symbol lookups
