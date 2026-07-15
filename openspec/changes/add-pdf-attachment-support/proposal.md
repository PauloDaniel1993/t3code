## Why

T3 currently rejects PDF files at the composer even though coding agents commonly need to review specifications, reports, and other document-based context. Supporting PDFs as first-class attachments removes the manual workaround of copying a document into the workspace and describing its path.

## What Changes

- Allow users to select, drag, or paste PDF files into the chat composer alongside images.
- Represent PDFs as a distinct document attachment in shared contracts, drafts, persisted messages, and attachment storage.
- Validate PDF type, signature, size, and attachment-count limits before a turn reaches a provider.
- Render PDFs as accessible file cards in drafts and message history, with open/download behavior instead of image previews.
- Deliver persisted PDFs through each provider's supported file/document input mechanism and return an actionable error when a provider cannot accept PDFs.
- Preserve PDF attachments through optimistic sends, reconnects, thread history, handoff, revert, and deletion cleanup.

## Capabilities

### New Capabilities

- `pdf-attachments`: Uploading, validating, persisting, displaying, and delivering PDF chat attachments to providers.

### Modified Capabilities

None.

## Impact

- Shared attachment schemas and WebSocket command/event payloads in `packages/contracts`.
- Composer draft state, attachment controls, message rendering, and accessibility in `apps/web`.
- Server-side normalization, attachment path resolution, asset serving, persistence, cleanup, and handoff behavior in `apps/server`.
- Codex, Claude, OpenCode, Cursor, and Grok provider adapters; providers without PDF support retain explicit validation errors.
- Focused contract, web, server, provider-adapter, persistence, and reconnect/handoff tests.
