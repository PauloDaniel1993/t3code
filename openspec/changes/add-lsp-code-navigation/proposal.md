## Why

Agents running in T3 Code navigate code with text search and file reads through their CLIs; they have no symbol-level view of the workspace, so cross-package refactors miss call sites, "where is this used" questions burn turns on grep false positives, and type errors are only discovered after edits. T3 already injects an internal `t3-code` MCP server into agent sessions, which is the natural delivery path for IDE-grade navigation tools that work headless (no desktop IDE dependency), across every provider.

## What Changes

- Add a new read-only `lsp` toolkit to the internal `t3-code` MCP server exposing code-navigation tools: go-to-definition, find references, hover (type/signature info), document symbols, workspace symbol search, and file diagnostics.
- Add a generic LSP client layer in `apps/server` that spawns and manages language-server processes per project workspace — TypeScript-first via `typescript-language-server`, designed so additional languages can be registered later.
- Manage language-server lifecycle like other long-lived server resources: lazy spawn on first tool call, idle shutdown, crash restart with bounded retries, disposal on server shutdown.
- Register the toolkit behind a new `lsp` MCP capability so it is issued with session credentials. All tool-capable providers (Codex, Claude, Cursor, Grok, OpenCode) already receive the `t3-code` MCP server at session start, so the toolkit reaches them with no adapter changes. DeepSeek is excluded: its adapter has no tool-calling support (raw chat completions); it gains these tools only after tool calling lands (see the pending `add-deepseek-tool-calling` change).
- Write tool descriptions that steer models to prefer symbol tools over text search for symbol lookups; enforce result-size limits and read-only tool annotations consistent with the preview toolkit.
- Out of scope: rename/refactoring or any write operations, codebase indexing/embeddings, editor UI changes, non-TypeScript language servers (beyond the pluggable registry).

## Capabilities

### New Capabilities

- `lsp-code-navigation`: Defines the LSP-backed code-navigation MCP toolkit, the language-server lifecycle management, workspace resolution for tool calls, provider coverage (including ACP MCP injection), and result-size/read-only guarantees.

### Modified Capabilities

- None.

## Impact

- Affected server systems:
  - MCP capability union and credential issuance (`apps/server/src/mcp/McpInvocationContext.ts`, `McpSessionRegistry.ts`)
  - toolkit registration and routes wiring (`apps/server/src/mcp/McpHttpServer.ts`, `apps/server/src/server.ts`)
  - new LSP toolkit (`apps/server/src/mcp/toolkits/lsp/`) and LSP client/manager service (language-server spawn, LSP-over-stdio client, lifecycle reaping)
- Affected packages:
  - `apps/server/package.json` — `typescript-language-server` (and bundled `typescript` fallback) dependency
- No provider adapter, contract (`packages/contracts`), `packages/effect-acp`, or web UI changes expected; tools are provider-facing via MCP.
- Required verification:
  - focused server tests for the LSP client, lifecycle manager, and toolkit tool handlers
  - `vp check`
  - `vp run typecheck`
