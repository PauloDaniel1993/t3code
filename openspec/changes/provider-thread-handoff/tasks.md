## 1. Contracts And Settings

- [x] 1.1 Add DeepSeek provider settings schemas, defaults, model metadata, and contract tests
- [x] 1.2 Add `handoffCompressionModelSelection` to server settings with `null` automatic default
- [x] 1.3 Add handoff metadata schemas to orchestration thread detail and shell contracts
- [x] 1.4 Add strict message source schemas and historical role-derived decode fallback
- [x] 1.5 Add `thread.handoff.create` and internal bootstrap completion/skip command schemas
- [x] 1.6 Add handoff events and imported message payload source metadata

## 2. Persistence And Projection

- [x] 2.1 Add migration `999_ProviderThreadHandoff` for thread handoff JSON and message source fields
- [x] 2.2 Register the migration in `apps/server/src/persistence/Migrations.ts`
- [x] 2.3 Update projection reads and writes for handoff metadata and message source fields
- [x] 2.4 Ensure replay projects non-handoff threads with `handoff: null`
- [x] 2.5 Ensure shell latest-user and summary projection ignore imported user messages
- [ ] 2.6 Add projection and migration tests for historical source fallback and handoff replay

## 3. DeepSeek Provider

- [x] 3.1 Add DeepSeek provider metadata to server built-in driver registration and web provider driver metadata
- [x] 3.2 Implement DeepSeek API URL normalization, auth headers, streaming parser, non-streaming requests, and timeout handling
- [x] 3.3 Implement DeepSeek adapter local session startup, send sequencing, interruption, and cursor persistence
- [x] 3.4 Implement DeepSeek unsupported capability responses for tools, file edits, approvals, and user input
- [x] 3.5 Implement DeepSeek text generation with local structured-output validation
- [ ] 3.6 Add DeepSeek provider tests for readiness, streaming success, failure, interrupt, corrupt cursor, and text generation

## 4. Text Generation And Compression

- [x] 4.1 Extend the `TextGeneration` service with `generateHandoffSummary`
- [x] 4.2 Add handoff summary prompt builder and summary sanitizer utilities
- [x] 4.3 Implement handoff compression model resolution with DeepSeek flash auto default and text-generation fallback
- [x] 4.4 Implement summary cache keys with source message id, model selection, and SHA-256 source text hash
- [x] 4.5 Implement bounded head/tail summarizer input, malformed output retry, and deterministic truncation fallback
- [ ] 4.6 Add tests for model resolution, prompt construction, sanitization, cache matching, retry, and fallback

## 5. Server Handoff Command Handling

- [ ] 5.1 Add thread handoff domain helpers for import eligibility, target validation, and deterministic imported message ids
- [x] 5.2 Implement `thread.handoff.create` decider handling with server-derived source data
- [x] 5.3 Emit target `thread.created`, imported `thread.message-sent`, and import activity events atomically
- [ ] 5.4 Reject missing source, deleted/archived/running/waiting source, empty transcript, existing target id, and not-ready target provider
- [x] 5.5 Add chain handoff guard requiring a native message after previous imports
- [ ] 5.6 Add server tests for successful handoff, rejection cases, ordering, import caps, attachment-only messages, and source immutability

## 6. Bootstrap Context And Reactor Integration

- [x] 6.1 Add pure bootstrap context builder with XML-style wrapper, escaping, attachment metadata, and deterministic trimming
- [x] 6.2 Integrate compression into bootstrap context building for oversized individual imported messages
- [x] 6.3 Add in-memory bootstrap in-flight tracking keyed by target thread id
- [x] 6.4 Wrap provider input in `ProviderCommandReactor` after session ensure and before provider request construction
- [x] 6.5 Dispatch deterministic bootstrap completion command after successful first wrapped `sendTurn`
- [x] 6.6 Retry bootstrap completion dispatch with backoff while the reactor is alive
- [ ] 6.7 Add tests for one-shot wrapping, retry after failure, no source cursor transfer, concurrent send behavior, and completion replay

## 7. Client Runtime

- [x] 7.1 Add `handoffThread` command helper to client runtime operations
- [x] 7.2 Expose `threadEnvironment.handoff` from thread command state
- [x] 7.3 Add command concurrency handling keyed by source thread id
- [x] 7.4 Add runtime tests for command payload shape and concurrency behavior

## 8. Web Handoff Domain

- [x] 8.1 Add pure handoff eligibility helpers under `apps/web/src/threadHandoff`
- [x] 8.2 Add target provider resolution using existing provider instance derivation/settings helpers
- [x] 8.3 Add target instance and model selection precedence with sticky source-provider preferences
- [x] 8.4 Add draft-copy helper for copying source unsent composer draft to target draft after navigation
- [x] 8.5 Add web domain tests for eligibility, target disabled reasons, selection precedence, and draft copy behavior

## 9. Web UI

- [x] 9.1 Add active chat `ThreadActionsMenu` with `Hand off to...` action and disabled reasons
- [x] 9.2 Add `ThreadHandoffDialog` with source provider, target provider list, target model picker, and importable count
- [x] 9.3 Wire dialog submit to command dispatch, acknowledgement close, target projection wait, navigation, timeout toast, and draft copy
- [x] 9.4 Render imported timeline messages with imported marker and adjusted user/assistant actions
- [x] 9.5 Add settings UI row for handoff compression model selection with automatic reset and resolved model helper text
- [ ] 9.6 Add UI tests for dialog behavior, navigation timeout, imported message rendering, and compression setting selection

## 10. Verification

- [x] 10.1 Run focused contract, server, and web tests added by this change
- [x] 10.2 Run `vp check`
- [x] 10.3 Run `vp run typecheck`
- [ ] 10.4 Manually verify handoff with isolated `--base-dir` or `T3CODE_HOME`
- [x] 10.5 Record any deferred follow-ups in `.plans/23-provider-thread-handoff.md` if scope changes during implementation
