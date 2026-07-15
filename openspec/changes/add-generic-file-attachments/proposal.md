## Why

The composer only accepts images and PDFs, yet users routinely want an agent to look at a data file (JSON, CSV, XML, XLSX), a source file (`.cs`, `.js`, `.py`), or a log without first copying it into the workspace. Every other common file type an LLM can consume is rejected at the picker with "Unsupported file type".

## What Changes

- Accept any common LLM-consumable file in the chat composer (picker, drag-drop, paste): text and code files (txt, md, json, csv, tsv, xml, yaml, html, css, js, ts, cs, py, and other source extensions), plus structured binary spreadsheets (xlsx).
- Add a generic `file` attachment kind to shared contracts, drafts, persisted messages, uploads, and attachment storage, alongside the existing `image` and `document` (PDF) kinds.
- Validate uploads server-side: extension/MIME allowlist, size caps, text-content sniffing for text files (reject NUL-byte binaries masquerading as text), and ZIP signature check for xlsx.
- Render generic file attachments as file cards (name, type badge, size) in drafts and message history, generalizing the existing PDF card.
- Deliver file attachments through each provider's best mechanism: file references (`resource_link` / path mention) for agentic providers with filesystem access, inline text blocks for API-style providers, with actionable errors when a provider cannot accept a given file (e.g., xlsx on a text-only API provider).
- Preserve generic file attachments through optimistic sends, reconnects, thread history, handoff, revert, and deletion cleanup, mirroring PDF behavior.

## Capabilities

### New Capabilities

- `file-attachments`: Uploading, validating, persisting, displaying, and delivering generic (non-image, non-PDF) file chat attachments to providers, including text/code files and xlsx spreadsheets.

### Modified Capabilities

None. (No existing main spec covers attachments; the in-flight `add-pdf-attachment-support` change introduced `pdf-attachments`, which this change extends by analogy rather than by modifying its requirements.)

## Impact

- Shared attachment schemas, upload payloads, and size-limit constants in `packages/contracts` (`orchestration.ts`).
- Composer accept filter, file preparation, draft persistence, and attachment cards in `apps/web` (`composerAttachments.ts`, `composerDraftStore.ts`, `ChatComposer.tsx`, `PdfAttachmentCard.tsx` generalization, `MessagesTimeline.tsx`).
- Server-side upload validation, attachment path resolution, and storage in `apps/server` (`orchestration/AttachmentPayload.ts`, `attachmentStore.ts`).
- Provider delivery paths: ACP mapping (`AcpAttachmentMapping.ts`), Claude, Codex, OpenCode, Cursor, Grok adapters; DeepSeek keeps explicit rejection for unsupported shapes but gains inline text delivery where feasible.
- Client-runtime attachment state (`packages/client-runtime/src/state/attachments.ts`) and history bootstrap in `apps/web`.
- Focused tests across contracts, web composer, server validation, provider adapters, and persistence.
