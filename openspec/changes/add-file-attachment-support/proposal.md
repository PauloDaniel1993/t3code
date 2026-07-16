## Why

T3's composer only supports image attachments, forcing users to copy PDFs, source files, logs, datasets, and spreadsheets into a workspace before an agent can inspect them. A unified file-attachment capability removes that workaround and avoids building separate, overlapping pipelines for PDFs and other files.

## What Changes

- Accept PDFs and an allowlisted set of common text, code, data, and spreadsheet files through the file picker, drag-and-drop, and clipboard paste, alongside existing images.
- Add PDF `document` and generic `file` variants to shared attachment contracts, draft state, upload commands, persisted messages, history, and attachment storage.
- Validate every upload authoritatively on the server using per-kind size, signature, extension, MIME, and content checks before persistence or provider dispatch.
- Generalize the attachment UI into accessible file cards while retaining image thumbnails and PDF-specific open behavior.
- Deliver each attachment through the best supported provider-native representation, preserving order and rejecting unsupported combinations with actionable errors instead of silently dropping files.
- Preserve all attachment kinds through optimistic sends, reconnects, history reloads, T3-local handoff, revert, replacement, and deletion cleanup.

## Capabilities

### New Capabilities

- `file-attachments`: Selecting, validating, persisting, displaying, lifecycle-managing, and provider-delivering PDF and allowlisted generic file attachments.

### Modified Capabilities

None.

## Impact

- Shared attachment schemas, limits, file-type registry, and WebSocket payloads in `packages/contracts`.
- Shared client attachment state in `packages/client-runtime`.
- Composer ingestion, draft persistence, attachment cards, optimistic reconciliation, and history rendering in `apps/web`.
- Server validation, normalization, safe attachment storage, signed asset delivery, lifecycle cleanup, and handoff behavior in `apps/server`.
- Codex, Claude, OpenCode, ACP/Cursor/Grok, and DeepSeek provider adapters and their attachment-delivery tests.
- Focused contract, client-runtime, web, server, persistence, reconnect, handoff, cleanup, and provider-adapter tests.
