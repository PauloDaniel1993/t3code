## 1. Shared Attachment Contracts

- [x] 1.1 Add the 10 MiB PDF limit, persisted and upload document schemas, and the document variants to `ChatAttachment` and `UploadChatAttachment` without changing the existing image wire shape.
- [x] 1.2 Update contract schema tests for valid PDF metadata/uploads, missing or incorrect MIME values, size boundaries, mixed attachment arrays, and the shared eight-attachment limit.
- [x] 1.3 Update web and client-runtime attachment types to expose discriminated image and document variants, keeping runtime helpers outside `packages/contracts`.

## 2. Server Validation and Storage

- [x] 2.1 Extract type-directed attachment payload validation and implement PDF data-URL decoding, MIME canonicalization, declared-size checks, the 10 MiB limit, and `%PDF-` signature detection within the first 1,024 bytes.
- [x] 2.2 Add focused normalizer tests for valid PDFs, filename-based browser MIME fallback, spoofed content, malformed base64, mismatched sizes, oversized files, mixed ordering, and no persisted file on validation failure.
- [x] 2.3 Extend attachment path and lookup helpers to map document attachments to `.pdf`, include PDFs in contained ID lookup, and cover traversal, extension, and cross-thread safety with tests.
- [x] 2.4 Extend signed attachment asset serving for `application/pdf` and verify successful resolution, missing/expired asset behavior, `nosniff` handling, and original-name downloads through web behavior.
- [x] 2.5 Verify projection, snapshot hydration, optimistic reconciliation inputs, and T3-local handoff preserve PDF and mixed attachment metadata without image-only assumptions.
- [x] 2.6 Extend revert, attachment replacement, projection rollback, and thread-deletion tests to prove unreferenced PDFs are cleaned up without touching files owned by other threads.

## 3. Web Composer and Draft State

- [x] 3.1 Refactor image-only draft models, selectors, actions, deduplication, persistence, and hydration into generic composer attachment paths with image- and PDF-specific variants.
- [x] 3.2 Preserve existing quota-safe draft persistence and object-URL cleanup behavior for PDFs, with tests for thread switching, hydration, removal, persistence failure, and mixed image/PDF drafts.
- [x] 3.3 Update picker accept values, clipboard paste, and drag-and-drop handling to recognize PDF MIME or `.pdf` filenames, canonicalize browser files with missing MIME, and reject unrelated types with actionable messages.
- [x] 3.4 Enforce the 10 MiB PDF limit and combined eight-item limit in the composer, and update send-state logic so PDF-only and mixed-attachment turns are enabled.
- [x] 3.5 Update turn serialization and optimistic message construction to preserve attachment type and order, and keep failed-send recovery from losing valid PDF draft files.
- [x] 3.6 Add composer tests covering picked, dropped, pasted, oversized, count-limited, PDF-only, and mixed attachment flows.

## 4. PDF Attachment UI and History

- [x] 4.1 Add a reusable accessible PDF attachment card showing the original filename and formatted size with draft-remove, open, and original-name download actions as appropriate.
- [x] 4.2 Partition timeline attachments by discriminant so image thumbnails and preview-annotation handoff remain image-only while PDFs render as document cards.
- [x] 4.3 Connect optimistic blob URLs and persisted signed asset URLs to PDF cards, disabling open/download controls while a URL is missing or expired and avoiding broken previews.
- [x] 4.4 Add component and history tests for accessible labels, keyboard operation, metadata-only states, optimistic-to-server URL promotion, reconnect hydration, and mixed image/PDF rendering.
- [ ] 4.5 Fix the PDF attachment card's open action (external-link icon in `PdfAttachmentCard`) not opening the PDF; verify `assetUrl`/signed URL resolution and `target="_blank"` behavior in both draft and history modes, and add a regression test.

## 5. Provider Delivery

- [x] 5.1 Extend Codex turn input types and mapping so images remain data-URL inputs and PDFs become `mention` inputs containing the original filename and safe persisted path; add exact turn-parameter tests.
- [x] 5.2 Extend Claude user-message construction with base64 `application/pdf` document blocks while retaining image MIME validation; add PDF-only, mixed-order, missing-file, and unsupported-type tests.
- [x] 5.3 Verify and test OpenCode's generic file-part mapping for PDF filename, MIME type, and platform-safe local file URL.
- [x] 5.4 Extract a shared ACP attachment mapping helper and use it in Cursor and Grok so PDFs become `resource_link` blocks with name, MIME type, byte size, and platform-safe file URI while images remain embedded image blocks.
- [x] 5.5 Add Cursor and Grok adapter tests for PDF-only, mixed-order, invalid-path, and missing-file turns.
- [x] 5.6 Update adapters without PDF representations, including DeepSeek, to reject PDF-bearing turns explicitly and add regression tests proving no adapter silently drops unknown attachment variants.

## 6. Verification

- [x] 6.1 Run focused contract, server normalizer/storage/projection, web composer/timeline, handoff, and provider-adapter tests and fix all failures.
- [x] 6.2 Run `vp test` for the built-in Vite+ test suite and resolve regressions.
- [x] 6.3 Run `vp check` and `vp run typecheck`, and record successful verification before considering the implementation complete.

## Verification

- `vp test run` (PDF-focused contracts, runtime, normalizer, storage, web composer, timeline, and history): 13 files and 193 tests passed.
- Direct server Vitest (assets, projection lifecycle, handoff, and provider adapters): 10 files and 203 tests passed, with 15 unrelated Codex text-generation tests skipped by the focused filter.
- `vp run lint:mobile`: passed; optional native linters were not installed on this Windows host.
- `vp check`: passed with pre-existing repository warnings only.
- `vp run typecheck`: passed across all 15 packages.
- The repository-wide `vp test` command was run. Its PDF-focused regression was fixed; the remaining failures are outside this change and include existing Effect/Vite+ registration failures, Windows shell-fixture `spawn EFTYPE` failures, an unchanged projector expectation drift on `dev`, and orchestration-ingestion timing failures.
