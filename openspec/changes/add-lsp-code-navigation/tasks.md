## 1. LSP client foundation

- [ ] 1.1 Add `typescript-language-server` and `typescript` dependencies to `apps/server/package.json` (catalog-pinned) and verify the server's JS entry can be spawned with `process.execPath` on Windows
- [ ] 1.2 Create `apps/server/src/lsp/protocol.ts` â€” `effect/Schema` definitions for the LSP message subset (initialize/initialized, shutdown/exit, didOpen/didClose, definition, references, hover, documentSymbol, workspace/symbol, textDocument/diagnostic, publishDiagnostics) plus shared types (Position, Range, Location, Diagnostic) and typed errors (`LspServerUnavailableError`, `LspInvalidPathError`, `LspWorkspaceUnavailableError`, `LspTimeoutError`, `LspUnsupportedLanguageError`)
- [ ] 1.3 Create `apps/server/src/lsp/framing.ts` â€” Content-Length framed JSON-RPC 2.0 encode/decode over stdio streams, with tests covering split/merged chunks
- [ ] 1.4 Create `apps/server/src/lsp/LspClient.ts` â€” scope-bound client over a spawned child (`ChildProcessSpawner` + `resolveSpawnCommand`): request/response correlation, server-notification subscription (publishDiagnostics), per-request timeout, initialize handshake capturing server capabilities; unit tests against a scripted fake server process
- [ ] 1.5 Create `apps/server/src/lsp/uri.ts` â€” pathâ†”URI conversion via `pathToFileURL`/`fileURLToPath` and workspace-root containment check; tests must cover Windows drive-letter paths and backslashes

## 2. Language-server lifecycle manager

- [ ] 2.1 Create `apps/server/src/lsp/languageRegistry.ts` â€” registry mapping file extensions to language-server specs, with the TypeScript/JavaScript entry (ts, tsx, js, jsx, mts, cts, mjs, cjs) resolving the bundled `typescript-language-server` entrypoint
- [ ] 2.2 Create `apps/server/src/lsp/LspSessionManager.ts` â€” `Context.Service` with `SynchronizedRef` registry keyed by normalized workspace root: lazy spawn on first use, reuse across calls, `lastUsedAt` tracking, in-flight request counting
- [ ] 2.3 Implement idle reaping (Schedule.spaced sweep, default 60 s interval / 10 min idle, skip entries with in-flight requests) and bounded workspace pool (default 4, LRU eviction), following the `ProviderSessionReaper` pattern
- [ ] 2.4 Implement disposal and crash handling: shutdown-request â†’ SIGTERM â†’ SIGKILL escalation on stop (per `terminal/Manager.ts`), transparent restart on next call after a crash, 3-consecutive-crash tombstone returning `LspServerUnavailableError`, all children scope-bound to the manager
- [ ] 2.5 Tests for the manager: spawn-on-first-call, reuse, idle reap, crash restart, tombstone after repeated crashes, pool eviction (use a fake language-server spec from the registry)

## 3. MCP toolkit

- [ ] 3.1 Add `"lsp"` to the `McpCapability` union in `apps/server/src/mcp/McpInvocationContext.ts` and to the issued capability set in `McpSessionRegistry.issue`; update `McpSessionRegistry.test.ts`
- [ ] 3.2 Create `apps/server/src/mcp/toolkits/lsp/tools.ts` â€” `Tool.make` definitions for `lsp_definition`, `lsp_references`, `lsp_hover`, `lsp_document_symbols`, `lsp_workspace_symbols`, `lsp_diagnostics`, all annotated Readonly/Idempotent/not-Destructive/not-OpenWorld with `Tool.Title`; 1-based line/column inputs; adoption-oriented descriptions naming each tool's grep-replacement use case; `LspToolkit = Toolkit.make(...)`
- [ ] 3.3 Create `apps/server/src/mcp/toolkits/lsp/handlers.ts` â€” `Toolkit.toLayer`: gate on `requireMcpCapability("lsp")`, resolve workspace root via `ProviderSessionDirectory.getBinding(scope.threadId)` + `readPersistedCwd`, validate path containment, call `LspSessionManager`, convert positions (1-based â†” 0-based) and URIs to workspace-relative paths with one-line excerpts
- [ ] 3.4 Implement response bounding: 200-item / 64 KB caps with `totalCount` and `truncated` fields; diagnostics via pull when the server advertises `diagnosticProvider`, else didOpen + publishDiagnostics settle-debounce fallback
- [ ] 3.5 Register the toolkit: `LspToolkitRegistrationLive` in `McpHttpServer.ts` merged into `T3ToolkitRegistrationLive`, provide `LspSessionManager.layer` there and in `makeRoutesLayer` (`apps/server/src/server.ts`)
- [ ] 3.6 Toolkit tests: tool schemas/annotations (`tools.test.ts` following the preview toolkit test), handler tests for capability gating, workspace resolution failure, path escape rejection, truncation reporting, unsupported-language error

## 4. End-to-end verification

- [ ] 4.1 Integration test: spawn the real `typescript-language-server` against a fixture TS workspace and assert definition/references/hover/documentSymbol/workspaceSymbol/diagnostics round-trips through `LspSessionManager`
- [ ] 4.2 Manual verification per spec scenarios: start a Claude or Codex session in this repo, confirm `lsp_*` tools are listed and callable, references on a `packages/contracts` symbol return cross-package results, and a worktree-bound session resolves paths inside the worktree
- [ ] 4.3 Confirm idle reap and shutdown behavior locally (language server exits after idle period; no orphaned processes after server stop)
- [ ] 4.4 Run `vp check` and `vp run typecheck`; fix any findings
