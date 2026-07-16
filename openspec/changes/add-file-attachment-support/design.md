## Context

T3's attachment pipeline is image-only end to end. `packages/contracts` exposes a one-member `ChatAttachment` union, the web composer and draft store use image-specific models, `Normalizer.ts` accepts only image data URLs and writes each file immediately, and every provider adapter assumes an image input. Attachment metadata is already stored as JSON and bytes already live in a server-managed attachment directory behind signed asset URLs, so additional discriminated variants do not require a database migration.

The two source proposals approached PDF and generic-file support sequentially: the generic-file design assumed the PDF design had already generalized the pipeline. This fused design introduces both variants together, extracts the common lifecycle once, and keeps format-specific validation and provider mapping explicit. The implementation crosses contracts, shared runtime utilities, web state and UI, server persistence, provider adapters, projections, handoff, and cleanup, so bounded resource use and failure atomicity are central constraints.

## Goals / Non-Goals

**Goals:**

- Support PDFs plus a deliberate allowlist of common text, code, data, and `.xlsx` files alongside images.
- Preserve each attachment's type and order through drafts, upload, persistence, optimistic reconciliation, history, reconnect, T3-local handoff, revert, replacement, and deletion.
- Validate content and resource bounds authoritatively before a turn is persisted or dispatched.
- Use native provider file/document representations where available and return actionable errors where they are not.
- Replace image-only branching with maintainable shared attachment paths while keeping type-specific behavior exhaustive.

**Non-Goals:**

- OCR, PDF page rendering, server-side PDF text extraction, or an embedded PDF viewer.
- Converting `.xlsx` to CSV or extracting OOXML content on the server.
- Supporting `docx`, `pptx`, archives, executables, arbitrary binaries, extensionless files such as `Dockerfile`, or dotfiles such as `.env`.
- Replacing the existing WebSocket data-URL upload transport with streaming, multipart upload, or resumable drafts.
- Increasing the existing maximum of eight attachments or the 10 MiB per-file limit.
- Bypassing provider-specific size, encryption, page-count, context-window, filesystem, or model restrictions.

## Decisions

### 1. Use three explicit attachment variants

Keep the existing image wire shape and add:

- `document`: PDF-only, with `mimeType: "application/pdf"`.
- `file`: an allowlisted non-image, non-PDF file with a canonical MIME type.

Both persisted variants contain `id`, original display `name`, canonical `mimeType`, and `sizeBytes`; upload variants additionally contain `dataUrl`. PDFs and generic files each use a 10 MiB decoded-byte limit and all three kinds share the existing maximum of eight attachments per message.

A single untyped binary variant was rejected because PDF validation, UI, asset behavior, and provider document blocks are distinct. Widening `document` to every file was rejected for the same reason: separate discriminants let exhaustive switches surface every required integration point without nested MIME checks.

### 2. Put schemas in contracts and file-classification logic in shared runtime

`packages/contracts` remains schema-only: it owns the discriminated schemas, bounded size/count constants, and protocol payloads. Add a `@t3tools/shared/attachmentFileTypes` subpath for the immutable extension-to-`{ mimeType, contentKind }` registry and runtime helpers used by both web and server. `contentKind` is `text` for the initial text/code/data entries and `binary` for `.xlsx`.

The initial registry covers common text, Markdown, logs, JSON/JSONL, CSV/TSV, XML, YAML, TOML, INI/config, HTML/CSS, GraphQL/protobuf, shell/PowerShell, SQL, and common source-language extensions represented in the specification. It deliberately excludes `.env`, extensionless names, and unrelated OOXML/archive types. Adding a supported extension remains a data-and-test change.

Classification is extension-first because browser MIME metadata for source files is inconsistent (`.ts` is often `video/mp2t`, while several source extensions have no MIME). Client and server replace advisory MIME metadata with the registry's canonical value. Keeping lookup functions out of contracts avoids introducing runtime policy into the schema package. Duplicating allowlists in web and server was rejected because they would drift.

### 3. Validate all attachments before committing any bytes

Extract type-directed upload validation from `Normalizer.ts`. Common validation strictly parses the base64 data URL, checks encoded and decoded bounds, rejects empty payloads, and verifies `sizeBytes` against decoded bytes. Format validation then applies:

- Images retain their current safe-MIME and extension inference behavior.
- PDFs canonicalize to `application/pdf` and require `%PDF-` within the first 1,024 bytes.
- Generic files require a registry extension. Text files reject NUL bytes in the first 8 KiB unless a UTF-16 BOM explains them; BOM-marked bytes remain unchanged in storage and are decoded correctly only when a provider needs inline text. `.xlsx` requires the ZIP local-file-header signature `PK\x03\x04`.

The normalizer validates the complete array before allocating final IDs or invoking a provider. It then writes to contained staging paths and commits atomically; any validation, write, projection, or commit failure removes files created for that command. This replaces the current per-item immediate write behavior, which could leave an earlier image behind if a later attachment failed. A full PDF or OOXML parser was rejected because it adds CPU/decompression attack surface without being necessary for basic type verification.

### 4. Reuse the attachment store with registry-owned extensions

Persist every attachment under a generated, thread-scoped ID. Images keep their inferred safe extensions, documents use `.pdf`, and generic files use only the canonical extension returned by the shared registry. Original filenames remain metadata and never participate in directory construction. ID-based lookup and cleanup recognize the safe image extensions, `.pdf`, and registry extensions while retaining path-containment and cross-thread ownership checks.

The existing JSON attachment fields can store the additive union, so no database migration or backfill is required. Copying files into the project workspace was rejected because it would dirty user repositories, create naming conflicts, and make retention ambiguous.

### 5. Generalize file cards while constraining browser execution

Refactor image-only draft abstractions into generic composer attachment state, but continue to render images as thumbnails. PDFs and generic files share an accessible file-card component showing name, human-readable size, icon, and extension badge:

- Draft cards expose a labeled remove action and use object URLs only where needed.
- Persisted PDF cards expose labeled open and original-name download actions when a signed asset URL is available.
- Generic files expose download only; the server forces `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff` so attached HTML, SVG-like text, or scripts are not executed in T3's origin.
- Missing, expired, or unresolved URLs leave a metadata-only card without broken controls.

PDF open uses a separate browsing context with `noopener`; an embedded viewer was rejected to keep large documents and active PDF content outside the chat surface. Object URLs are revoked on removal, hydration replacement, thread switching, and unmount. Existing quota-safe draft persistence remains best-effort and must not destroy the live draft when storage is full.

### 6. Map each kind explicitly per provider

Resolve only contained server-managed paths, preserve attachment order, and use exhaustive provider mapping:

| Provider path       | Image                         | PDF `document`                          | Generic text file          | `.xlsx`                                      |
| ------------------- | ----------------------------- | --------------------------------------- | -------------------------- | -------------------------------------------- |
| Codex               | Existing data-URL image input | Local-path mention                      | Local-path mention         | Local-path mention                           |
| Claude              | SDK image block               | Base64 `application/pdf` document block | Labeled inline text block  | Labeled local-path reference for agent tools |
| OpenCode            | File part                     | File part                               | File part                  | File part                                    |
| ACP / Cursor / Grok | Embedded image block          | `resource_link`                         | `resource_link`            | `resource_link`                              |
| DeepSeek            | Existing behavior             | Actionable unsupported error            | Labeled inline prompt text | Actionable unsupported error                 |

Extract a shared ACP mapper so Cursor and Grok do not duplicate image/resource-link branching. Adapters must fail the entire turn for an unknown, missing, unreadable, or unsupported attachment and must never filter it out silently.

Providers that inline text enforce a cumulative `PROVIDER_INLINE_FILE_MAX_CHARS` limit of 256 KiB per turn. A turn that would exceed it fails with the offending filename and limit rather than truncating content. File-reference providers do not apply this prompt budget because their agents decide how much of a file to read. Server-side extraction or rasterization was rejected because it is lossy and can inflate context unpredictably.

### 7. Treat attachment lifecycle and version skew as one concern

Projection, snapshot hydration, history bootstrap, optimistic promotion, and handoff operate on `ChatAttachment` without dropping variants. Image preview/annotation logic remains image-only; signed asset resolution and cleanup apply to every kind. Revert, replacement, rollback, and thread deletion remove only unreferenced files owned by the relevant thread.

The protocol change is additive, but an older client cannot decode new variants from history. Existing protocol-version mismatch handling remains the compatibility boundary; no attempt is made to reinterpret files as images or plain text. Provider capability errors remain server-authoritative so reconnects and alternate clients behave consistently.

## Risks / Trade-offs

- [Eight 10 MiB base64 attachments can consume substantial WebSocket and process memory] → Enforce encoded and decoded caps before persistence, validate sequentially with bounded copies, and keep streaming upload as a follow-up.
- [Signature checks do not prove a PDF or workbook is readable, safe, or unencrypted] → Treat them only as type checks, never execute or parse the files on the server, and surface provider/tool errors.
- [Browser MIME values and uncommon source extensions are inconsistent] → Make the shared extension registry authoritative and keep expansion reviewable and test-driven.
- [Inline text can unexpectedly consume model context] → Enforce the cumulative 256 KiB character budget and fail explicitly without truncation.
- [Local file references require provider processes to share filesystem access] → Resolve only contained absolute paths, use platform-safe file URLs, and test Windows and POSIX construction; reject failures before dispatch.
- [Active content could execute if served inline] → Offer generic files as forced downloads with `nosniff`; allow only PDFs to use the explicit separate-context open action.
- [Draft persistence can exceed browser quota] → Preserve the current quota-safe fallback, retain the in-memory draft, and revoke object URLs deterministically.
- [A widened union creates a large compiler fallout surface] → Centralize reusable mapping/validation and require exhaustive switches plus focused lifecycle and provider tests.

## Migration Plan

1. Add the two contract variants, shared runtime registry, and generic client types without changing existing image payloads.
2. Land authoritative validation, transactional storage, safe lookup/serving, and lifecycle support before enabling composer selection.
3. Add composer ingestion, draft migration/hydration, file cards, history rendering, and signed-URL reconciliation.
4. Enable and test provider mappings one adapter at a time; unsupported combinations remain explicit failures.
5. Run focused suites, `vp test`, `vp check`, and `vp run typecheck` before considering the change ready.

Rollback reverts the additive schemas and UI/provider paths. No database rollback is needed. Files already stored under `.pdf` or registry extensions remain confined to the attachment directory and can be removed by normal thread cleanup or an orphan-cleanup pass; they must never be reclassified as images.

## Open Questions

- Whether a follow-up should introduce a streamed, resumable upload protocol with an aggregate per-turn byte limit.
- Whether provider capability metadata should be exposed to the client so unsupported combinations can be warned about before submission.
- Whether extensionless source files should be admitted later through a separate, content-sniffed registry category.
