## 1. Shared Contracts and File-Type Policy

- [ ] 1.1 Add `@t3tools/shared/attachmentFileTypes` with the specified extension-to-canonical-MIME/content-kind registry, case-insensitive filename lookup, accepted-extension enumeration, and composer accept-string generation; export the subpath and test every registry row, misleading browser MIME values, `.env`, and extensionless names.
- [ ] 1.2 Add 10 MiB PDF/file limits, the cumulative 256 KiB inline-character limit, bounded `ChatDocumentAttachment`/`UploadChatDocumentAttachment` and `ChatFileAttachment`/`UploadChatFileAttachment` schemas, and both variants to the persisted/upload unions in `packages/contracts` without changing the existing image wire shape.
- [ ] 1.3 Extend contract tests for valid document/file metadata and uploads, empty and boundary sizes, encoded data-URL caps, canonical PDF MIME, malformed variants, mixed ordering, and the combined eight-attachment maximum.
- [ ] 1.4 Audit contract consumers for exhaustive handling of the widened union and keep all runtime classification or mapping helpers out of `packages/contracts`.

## 2. Authoritative Server Validation and Transactional Storage

- [ ] 2.1 Extract strict, type-directed attachment payload validation from `Normalizer.ts`, including base64 data-URL parsing, non-empty and encoded/decoded bounds, declared-size equality, image behavior preservation, canonical metadata, and actionable filename-scoped errors.
- [ ] 2.2 Implement PDF validation (`application/pdf` canonicalization and `%PDF-` within 1,024 bytes) and generic-file validation (registry extension, canonical MIME, 8 KiB text NUL sniff with UTF-16 BOM recognition, and `.xlsx` `PK\x03\x04` signature), preserving BOM-marked source bytes.
- [ ] 2.3 Refactor turn normalization to validate the full attachment array before provider invocation and stage/commit its files atomically; on validation, write, projection, or commit failure, remove every file created for that command.
- [ ] 2.4 Extend `attachmentRelativePath`, contained path resolution, ID lookup, and parsing to support `.pdf` and registry-owned extensions without using original filenames; test traversal, mixed-case names, missing IDs, cross-thread ownership, and Windows/POSIX-safe paths.
- [ ] 2.5 Extend signed attachment asset handling so PDFs can open or download with their original names and generic files are forced to download with `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`; test valid, missing, expired, and tampered claims.
- [ ] 2.6 Add focused server tests for malformed base64, mismatched sizes, spoofed PDFs, binary-renamed text, valid UTF-8/UTF-16 text, fake/valid `.xlsx`, mixed attachment order, transactional rollback, and no provider call or orphan file on failure.

## 3. Client Attachment State and Composer Ingestion

- [ ] 3.1 Generalize web and `packages/client-runtime` attachment types, selectors, reducers, and optimistic state from image-only models to discriminated image/document/file variants while keeping image preview-only properties narrowed to images.
- [ ] 3.2 Create a shared composer preparation path used by picker, drag-and-drop, and clipboard paste that recognizes images, filename- or MIME-identified PDFs, and registry files; canonicalize MIME values, preserve candidate order, retain valid items from a partially rejected batch, and generate category-specific errors.
- [ ] 3.3 Enforce per-kind 10 MiB bounds and the combined eight-item limit in composer preparation, and update send-state logic so PDF-only, generic-file-only, and mixed attachment turns are enabled.
- [ ] 3.4 Extend composer draft persistence and hydration schemas for document/file data URLs, including the storage-version migration, deduplication, quota-safe fallback, thread switching, and deterministic object-URL revocation without losing the live draft.
- [ ] 3.5 Update turn serialization, optimistic message construction, server-asset URL promotion, and failed-send recovery to preserve every attachment variant and its order.
- [ ] 3.6 Add composer and draft tests for picked/dropped/pasted PDFs and registry files, misleading or absent MIME values, unsupported candidates, oversized/count-limited batches, attachment-only sends, persistence failure, hydration, removal, thread switching, and mixed ordering.

## 4. Accessible File Cards and History Rendering

- [ ] 4.1 Build a reusable kind-driven file attachment card with icon, extension badge, original name, formatted size, and accessible keyboard controls; support draft removal, PDF open/download, generic download, and metadata-only disabled states.
- [ ] 4.2 Render document/file cards in `ChatComposer` and `MessagesTimeline` while keeping image thumbnails, expanded-image behavior, and preview-annotation handoff strictly image-only.
- [ ] 4.3 Connect draft object URLs and persisted signed asset URLs through optimistic reconciliation and history bootstrap; fix and regression-test PDF opening in a separate `noopener` browsing context and original-name downloads.
- [ ] 4.4 Add component and history tests for accessible labels, keyboard operation, extension/size metadata, unavailable or expired URLs, active-content download safety, optimistic-to-server URL promotion, reconnect hydration, and mixed image/PDF/file rendering.

## 5. Provider Delivery and Failure Semantics

- [ ] 5.1 Add shared contained-path/file-URI and BOM-aware text-decoding helpers for provider adapters, with exact Windows/POSIX URL tests and cumulative inline-budget enforcement that names the first overflowing file without truncating content.
- [ ] 5.2 Extend Codex turn mapping so images remain data-URL image inputs and documents/files become ordered local-path mentions containing the original name; reject missing or unreadable paths and add exact turn-parameter tests.
- [ ] 5.3 Extend Claude user-message construction so images remain validated image blocks, PDFs become base64 `application/pdf` document blocks, generic text becomes filename-labeled inline blocks under the cumulative budget, and `.xlsx` becomes a labeled safe local-path reference; test PDF-only, mixed order, UTF-16, overflow, and read failures.
- [ ] 5.4 Verify OpenCode's generic file-part path accepts all three attachment variants with canonical MIME, original filename, and contained platform-safe file URL; remove image-only guards and test missing paths and mixed ordering.
- [ ] 5.5 Extract a shared ACP attachment mapper and use it in Cursor and Grok so images remain embedded blocks while documents/files become ordered `resource_link` blocks with name, MIME, size, and contained file URI; add adapter tests for mixed turns and invalid/missing files.
- [ ] 5.6 Extend the DeepSeek delivery path to inline labeled generic text under the same cumulative budget and reject PDFs and `.xlsx` with actionable whole-turn errors; add tests proving no partial prompt or silent omission.
- [ ] 5.7 Audit secondary text-generation and prompt-building paths for the widened union so file metadata remains available, image materialization stays image-only, and no unknown attachment kind is skipped without an intentional, tested policy.

## 6. Persistence, Handoff, and Cleanup Lifecycle

- [ ] 6.1 Update projection schemas, snapshot hydration, persistence services, history bootstrap, and optimistic reconciliation to round-trip image/document/file arrays without a database migration or order changes.
- [ ] 6.2 Update T3-local handoff and import paths to retain PDF and generic-file metadata and resolvable attachment references, with mixed and file-only handoff tests.
- [ ] 6.3 Extend revert, attachment replacement, projection rollback, orphan cleanup, and thread-deletion behavior for `.pdf` and registry extensions; prove unreferenced files are removed without affecting referenced files or another thread's attachments.
- [ ] 6.4 Add reconnect/version-skew coverage showing compatible clients reload every variant and incompatible protocol versions fail through the existing mismatch path rather than reclassifying or dropping files.

## 7. End-to-End Verification

- [ ] 7.1 Run focused tests across contracts, shared registry utilities, client-runtime, composer/drafts/cards/history, server validation/storage/assets/projection/handoff/cleanup, and every provider adapter; resolve widened-union and lifecycle regressions.
- [ ] 7.2 Run `vp test` and fix failures in the built-in Vite+ suite.
- [ ] 7.3 Run `vp check` and `vp run typecheck` and fix all reported issues before marking the implementation complete.
- [ ] 7.4 Manually smoke-test picker, drag/drop, and paste with image/PDF/JSON/CSV/TypeScript/UTF-16 text/`.xlsx` mixtures; verify attachment-only sends, cards across reload/reconnect, provider reference and inline paths, PDF open, generic download headers, and actionable unsupported/overflow errors.
