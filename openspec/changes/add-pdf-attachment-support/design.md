## Context

T3's attachment pipeline is image-specific from end to end. The contracts expose only `ChatImageAttachment`, the web draft store and composer use image-named state and callbacks, the normalizer accepts only `image/*` data URLs, storage derives only safe image extensions, and provider adapters always construct image input blocks. Persisted attachment metadata already lives in message JSON and bytes already live in a server-managed attachment directory behind signed asset URLs, so PDF support can extend the current lifecycle without a database migration.

The implementation crosses shared schemas, client draft state and rendering, server validation and storage, provider adapters, projection/handoff behavior, and cleanup. Reliability and bounded resource use matter because uploads travel as base64 inside the existing WebSocket command before being written to disk.

## Goals / Non-Goals

**Goals:**

- Make PDFs first-class attachments with behavior consistent with existing image attachments.
- Validate PDF identity and bounds before persistence or provider invocation.
- Preserve PDFs across the existing message, reconnect, handoff, revert, and deletion lifecycles.
- Use native or protocol-standard provider file inputs where available and fail explicitly elsewhere.
- Refactor image-specific client and server attachment logic into maintainable shared attachment paths where the behavior is genuinely common.

**Non-Goals:**

- OCR, server-side PDF text extraction, page rendering, or inline PDF viewing inside T3.
- Support for Word documents, spreadsheets, archives, or arbitrary files.
- Circumventing a provider's own document size, page-count, encryption, or model limitations.
- Replacing the existing WebSocket data-URL upload transport with streaming or multipart upload in this change.
- Persisting external-provider files that are referenced during import but whose bytes are not available to T3.

## Decisions

### 1. Extend the attachment union with a document variant

Add `ChatDocumentAttachment` and `UploadChatDocumentAttachment` variants with `type: "document"` and a MIME type restricted to `application/pdf`. Keep the existing image variant unchanged, then rename image-only client abstractions to generic composer attachment abstractions with image- and document-specific refinements.

This makes exhaustive switches identify every place that needs PDF behavior and leaves room for future document formats without treating every binary file as valid. A generic untyped `file` attachment was considered, but it would weaken validation and imply support the providers do not have.

PDFs and images share the existing count limit of eight. PDFs use a distinct 10 MiB decoded-byte constant so future provider or transport constraints can change independently even though it initially matches the image limit.

### 2. Keep the current upload transport and make the server authoritative

The browser accepts `application/pdf` or a case-insensitive `.pdf` filename, canonicalizes PDF uploads to `application/pdf`, and serializes them through the existing data-URL command envelope. The server decodes the payload, compares actual and declared byte lengths, enforces 10 MiB, and checks for `%PDF-` within the first 1,024 bytes before allocating an attachment ID or staging a file.

Relying only on browser MIME metadata was rejected because MIME values can be absent or spoofed. A full PDF parser was also rejected: native provider/file tooling consumes the original PDF, and parsing adds a large dependency and decompression/CPU attack surface without being needed to establish a basic PDF signature. Streaming upload would reduce base64 overhead, but it requires a separate authenticated upload protocol and resumability lifecycle; that can be proposed independently.

Validation and normalization should be extracted into type-directed helpers rather than adding PDF branches to image MIME utilities. The persistence stage continues to use atomic staging/commit behavior so a failed command or projection does not leave orphan files.

### 3. Persist PDFs in the existing attachment store

Extend attachment path resolution to map document attachments only to `.pdf`, and include `.pdf` in ID-based lookup and cleanup. The stored filename remains the generated attachment ID, while the original filename remains metadata used by the UI and provider payloads. Existing path containment, thread-scoped IDs, signed asset claims, and cleanup rules remain the security boundary.

Using the existing store avoids duplicating retention and rollback behavior. Copying PDFs into the project workspace was rejected because it would dirty user repositories, create naming conflicts, and make cleanup ambiguous.

### 4. Render document cards, not PDF previews

Refactor composer attachments and timeline rendering to partition image and document variants. Images retain thumbnails and the expanded-image handoff logic. PDFs render a compact card with a PDF/file icon, original name, formatted size, and accessible controls. Draft cards use the local object URL only for opening; persisted cards switch to the signed server asset URL during optimistic reconciliation. Download uses the original filename, and unavailable URLs leave a metadata-only disabled state.

Embedding a PDF viewer was rejected because browser behavior is inconsistent, large documents increase client memory pressure, and active PDF content would broaden the web security surface. Opening a signed asset in a separate context keeps the chat lightweight.

### 5. Map PDFs to provider-native file representations

Provider adapters resolve the safe persisted path once and branch by attachment type:

- Codex: emit a `mention` user-input item with the original name and local PDF path; images remain data-URL image items.
- Claude: emit an SDK `document` block with a base64 `application/pdf` source; images remain image blocks.
- OpenCode: reuse its existing file part, which already carries MIME type, filename, and a file URL.
- Cursor and Grok ACP adapters: emit `resource_link` with the original name, MIME type, size, and `file:` URI; images remain embedded image blocks.
- Adapters with no file representation, currently DeepSeek, return a provider-specific validation error before dispatch.

Server-side text extraction or rasterizing pages into images was rejected because both approaches are lossy, can exceed prompt limits unpredictably, and would not preserve figures or document structure. Native document/file inputs also let each agent use its own reading tools. No adapter may skip an unknown attachment variant: exhaustive mapping returns an explicit error instead.

### 6. Reuse message metadata and asset reconciliation

The existing JSON attachment columns can store the new discriminated variant without a schema migration. Projection, snapshot, reducer, and handoff code should remain generic over `ChatAttachment`; tests will cover mixed arrays and PDF-only messages. Preview URL promotion remains image-only, while signed asset URL resolution applies to both images and documents.

No backfill is required because existing attachment JSON contains only the unchanged image variant. Protocol schemas become additive; clients and servers with incompatible schema versions continue to use the existing version-skew handling rather than attempting to reinterpret document attachments.

## Risks / Trade-offs

- [Base64 makes a 10 MiB PDF roughly one-third larger in memory and on the wire] → Keep the conservative per-file and eight-item limits, validate encoded and decoded bounds, and avoid extra copies where the Effect/file APIs permit.
- [A valid PDF signature does not guarantee a readable, unencrypted, or safe document] → Treat signature validation as type verification only and surface provider/tool errors; do not execute or parse active content on the server.
- [Provider support differs and can change] → Keep mapping isolated per adapter, test the exact wire representation, and fail the whole turn explicitly when a mapping is unavailable.
- [Local file URIs require the provider process to share host filesystem access] → Resolve only server-managed contained paths and convert them with platform-safe URL/path helpers; adapter integration tests cover Windows and POSIX-safe construction where practical.
- [Older clients cannot decode the new attachment variant] → Rely on the existing protocol-version mismatch flow and keep image schemas backward compatible.
- [Browser draft persistence may exceed storage quota] → Preserve the current quota-safe fallback behavior, keep the live draft intact, and avoid promising durable offline storage for large unsent PDFs.

## Migration Plan

1. Add the document schemas and generic attachment helpers while preserving image wire shapes.
2. Extend server validation, storage, lookup, asset serving, projection, cleanup, and lifecycle tests.
3. Refactor the web draft/composer/timeline paths and add PDF cards without changing image behavior.
4. Enable and test provider mappings one adapter at a time; unsupported adapters remain explicit failures.
5. Run focused tests, `vp check`, and `vp run typecheck` before enabling the feature by default.

Rollback consists of reverting the additive contracts and UI/provider paths. Existing `.pdf` files created before rollback are harmless server-managed attachments; the normal thread cleanup process can remove them, and no database rollback is required.

## Open Questions

- Whether a later change should add a streamed attachment-upload protocol for larger documents and durable draft blobs.
- Whether provider capabilities should become client-visible so unsupported PDF attachment controls can be disabled before submission rather than reporting an adapter error.
