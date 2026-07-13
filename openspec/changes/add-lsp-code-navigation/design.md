## Context

Agents in T3 Code navigate code purely through text search and file reads. T3 already runs an internal MCP server (`t3-code`) built on Effect's `effect/unstable/ai` stack (`Tool`, `Toolkit`, `McpServer`, `McpSchema`) — there is no `@modelcontextprotocol/sdk` dependency — and injects it into every tool-capable provider session:

- Codex: `-c mcp_servers.t3-code.*` flags + `T3_MCP_BEARER_TOKEN` env (`provider/Layers/CodexAdapter.ts`)
- Claude: `ClaudeQueryOptions.mcpServers` (`provider/Layers/ClaudeAdapter.ts`)
- Cursor / Grok: ACP `session/new` / `session/load` `mcpServers` array (`provider/acp/AcpSessionRuntime.ts`, `CursorAcpSupport.ts`, `GrokAcpSupport.ts`)
- OpenCode: `client.mcp.add(...)` (`provider/Layers/OpenCodeAdapter.ts`, local server only)
- DeepSeek: **no MCP/tool support** — raw chat-completions adapter; out of reach until `add-deepseek-tool-calling` (pending change) or equivalent lands.

Existing toolkits (`preview`, `userInput`) live under `apps/server/src/mcp/toolkits/<name>/{tools,handlers}.ts`: tools via `Tool.make(name, { description, parameters, success, failure, dependencies })` with `.annotate(Tool.Readonly/Destructive/Idempotent/OpenWorld/Title, ...)`, handlers via `Toolkit.toLayer({...})`, registered with `McpServer.toolkit(...)` and merged into `T3ToolkitRegistrationLive` in `McpHttpServer.ts`. Auth: bearer tokens issued by `McpSessionRegistry` (hash-stored, 30 min idle / 8 h max), resolved by middleware into `McpInvocationContext`. The invocation scope carries `environmentId, threadId, providerSessionId, providerInstanceId, capabilities` — **not** the workspace cwd.

The monorepo has no existing LSP dependency. Long-lived child processes are managed with `ChildProcessSpawner` (`effect/unstable/process`) + `resolveSpawnCommand` (`@t3tools/shared/shell`, handles Windows `.cmd` wrapping), scope-bound so children die with their scope. Reference lifecycle patterns: `terminal/Manager.ts` (registry keyed map, kill escalation SIGTERM→grace→SIGKILL, per-key locking) and `provider/Layers/ProviderSessionReaper.ts` (spaced `Schedule` sweep, `lastSeenAt` idle threshold, skip-active guard).

## Goals / Non-Goals

**Goals:**

- Give every MCP-capable provider session symbol-level navigation tools: definition, references, hover, document symbols, workspace symbol search, diagnostics.
- Read-only, size-bounded, workspace-scoped tool surface with typed errors.
- Language-server processes managed like other server resources: lazy spawn per workspace, reuse, idle reap, crash restart with bounded retries, clean shutdown.
- TypeScript/JavaScript support at launch via `typescript-language-server`, behind a registry that admits more languages later.
- Tool descriptions that make models prefer these tools over grep for symbol lookups.

**Non-Goals:**

- Write operations (rename, code actions, refactors).
- Codebase indexing, embeddings, or semantic search.
- UI surfaces (diagnostics in the diff panel is a natural follow-up, not this change).
- DeepSeek coverage (blocked on tool-calling support in its adapter).
- Non-TS/JS language servers (registry makes them possible; none ship here).

## Decisions

### D1: Deliver via the internal `t3-code` MCP server, not an external MCP server

Alternatives: (a) user-configured external server (e.g. Serena) — requires per-user setup, a Python runtime, and user-MCP management T3 doesn't have; (b) per-CLI config injection of a third-party server — inconsistent across providers. The internal toolkit reuses existing injection, auth, and capability plumbing, works headless/remote, and reaches all five MCP-capable providers with zero adapter changes.

### D2: Minimal in-house Effect LSP client over stdio

Add `apps/server/src/lsp/` with a small LSP client: Content-Length framed JSON-RPC 2.0 over the child's stdio, `effect/Schema`-validated for only the messages we use (`initialize`/`initialized`, `shutdown`/`exit`, `textDocument/didOpen`/`didClose`, `textDocument/definition`, `references`, `hover`, `documentSymbol`, `workspace/symbol`, `textDocument/diagnostic` pull + `textDocument/publishDiagnostics` push).

Alternatives considered: `vscode-languageclient`/`vscode-jsonrpc` (rejected — callback/Disposable lifecycle fights Effect scoping and interruption; brings its own transport management we'd wrap anyway); full protocol schema generation (rejected — we consume ~10 message types; `packages/effect-codex-app-server` already demonstrates the in-repo pattern for a typed JSON-RPC-over-stdio client). File↔URI conversion must go through `node:url` `pathToFileURL`/`fileURLToPath` for Windows drive-letter correctness.

### D3: `LspSessionManager` service owns per-workspace language servers

`class LspSessionManager extends Context.Service<...>()("t3/lsp/LspSessionManager")` with a `SynchronizedRef` registry keyed by normalized absolute workspace root. Semantics copied from proven code:

- **Lazy spawn** on first tool call for a workspace; single instance per (workspace, language) reused across sessions and threads.
- **Idle reaping**: track `lastUsedAt` per entry; `Effect.forkScoped` a `Schedule.spaced` sweep (default: sweep every 60 s, reap after 10 min idle), skipping entries with in-flight requests — mirror of `ProviderSessionReaper`.
- **Kill escalation** on stop: `shutdown` request → grace → SIGTERM → grace → SIGKILL — mirror of `terminal/Manager.ts`.
- **Crash restart**: consecutive-failure counter per workspace; restart transparently on next call, give up after 3 consecutive crashes with a typed `LspServerUnavailableError` until the idle sweep clears the tombstone.
- **Bounded pool**: cap concurrent workspaces with language servers (default 4, LRU eviction) to bound memory on multi-project servers.
- Children spawned via `ChildProcessSpawner` + `resolveSpawnCommand`, bound to the manager's scope so server shutdown reaps everything.

### D4: TypeScript-first via `typescript-language-server`, workspace TS preferred

Ship `typescript-language-server` + `typescript` as `apps/server` dependencies and spawn the server's JS entry with `process.execPath` (no global install, no PATH/npx dependency — important under the desktop app's managed backend). `typescript-language-server` resolves the target workspace's own `typescript` when present, falling back to the bundled one, so type answers match the project's compiler. The language registry maps file extensions (`.ts .tsx .js .jsx .mts .cts .mjs .cjs`) → server spec `{ id, command, args, matches }`; adding a language later is one registry entry.

### D5: Workspace resolution via `ProviderSessionDirectory`

`McpInvocationScope` has no cwd, so handlers resolve it: `scope.threadId → ProviderSessionDirectory.getBinding → readPersistedCwd(binding.runtimePayload)`. That cwd is the session's effective working directory — which is the worktree checkout path when worktrees are in use, so worktree scoping falls out for free. Tool inputs take workspace-relative or absolute paths; after `path.resolve` against the root, any path that escapes the root fails with a typed `LspInvalidPathError` before any language-server traffic. Missing binding/cwd → typed `LspWorkspaceUnavailableError`.

### D6: New `lsp` MCP capability

Add `"lsp"` to the `McpCapability` union (`McpInvocationContext.ts`) and to the issued capability set (`McpSessionRegistry.issue`). Handlers gate on `requireMcpCapability("lsp")`, same as `preview`. This keeps the ability to scope future credentials (e.g. subagents) down.

### D7: Diagnostics via pull, push fallback

If the server advertises `diagnosticProvider`, use `textDocument/diagnostic` (pull). Otherwise `didOpen` the file (content read from disk), collect `publishDiagnostics` for that URI with a settle debounce (~500 ms after last notification, bounded by the request timeout), then `didClose`. `typescript-language-server` supports pull on current versions; the fallback keeps the registry honest for future servers.

### D8: Tool surface, naming, annotations, bounds

Tools: `lsp_definition`, `lsp_references`, `lsp_hover`, `lsp_document_symbols`, `lsp_workspace_symbols`, `lsp_diagnostics` (matching the `preview_*` naming convention). All annotated `Readonly=true`, `Idempotent=true`, `Destructive=false`, `OpenWorld=false`, with `Tool.Title`. Position inputs are 1-based line/column (matching how models read files) converted to LSP 0-based internally; results return workspace-relative paths with 1-based positions plus a one-line text excerpt per location. Responses capped (default 200 locations / 200 symbols / 64 KB serialized, consistent with the preview broker's limit); truncated responses report `totalCount` and `truncated: true`. Per-request timeout default 30 s (first call on a cold workspace pays tsserver startup; the spawn itself is awaited outside the request timeout). Each description names its job and the grep-replacement framing, e.g. `lsp_references`: "Find every usage of a symbol across the workspace. Prefer this over text search (grep) when looking for usages — it is type-aware and has no false positives from same-named identifiers."

## Risks / Trade-offs

- [tsserver memory/CPU on large repos] → single instance per workspace, bounded pool with LRU eviction, 10 min idle reap, kill escalation on dispose.
- [Cold-start latency on first call] → spawn awaited outside the per-request timeout; subsequent calls hit the warm server. Acceptable: first symbol query on a workspace may take seconds.
- [Models ignore the tools and keep grepping] → adoption-oriented descriptions (D8). If transcripts still show low adoption, add a one-line nudge via `provider/CodexDeveloperInstructions.ts` in a follow-up — deliberately not part of this change.
- [Windows path/URI bugs (drive letters, backslashes, case)] → all conversions through `pathToFileURL`/`fileURLToPath`; workspace-root containment check on normalized absolute paths; tests must cover Windows-style paths since dev/prod run there.
- [Stale results from unsaved/agent-edited files] → v1 reads from disk only (agents edit via disk anyway); `didOpen` content is re-read per diagnostics call. Documented limitation: no in-memory document sync.
- [Diagnostics debounce returns partial results on slow projects] → bounded by request timeout and reported as such; pull-based path (TS default) avoids the issue entirely.
- [New dependency surface (`typescript-language-server`, `typescript`)] → both are plain-JS, spawned as a child process (crash-isolated from the server), pinned via catalog.

## Migration Plan

Purely additive: no contracts, persistence, or adapter changes; no migration. Rollout is "merge and run" — new capability + toolkit registration ship together. Rollback = remove `LspToolkitRegistrationLive` from `T3ToolkitRegistrationLive` (and the `"lsp"` capability entry); nothing persists.

## Open Questions

- Pool size and idle-timeout defaults (4 workspaces / 10 min) are guesses; revisit after observing real memory use with tsserver on this monorepo.
- Should `lsp_workspace_symbols` fan out across all registered languages in a workspace or stay per-language? v1: single TS server makes this moot; registry API should not preclude fan-out.
- Whether to surface language-server health (running/crashed per workspace) in Diagnostics settings — deferred, needs a UI opinion.
