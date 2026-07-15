## 1. Contracts: file-type registry and `file` attachment kind

- [ ] 1.1 Add an attachment file-type registry module to `packages/contracts` mapping canonical extension â†’ `{ mimeType, kind: "text" | "binary" }` for the initial allowlist (design D2), with lookup helpers (by extension, by file name) and an exported accept-string builder; unit-test misleading-MIME cases (`.ts` â†’ `video/mp2t`, empty MIME).
- [ ] 1.2 Add `ChatFileAttachment` and `UploadChatFileAttachment` schemas in `packages/contracts/src/orchestration.ts` (type `"file"`, registry-validated mimeType, `PROVIDER_SEND_TURN_MAX_FILE_BYTES` = 10 MiB, data-URL char cap) and include them in the `ChatAttachment`/`UploadChatAttachment` unions; add `PROVIDER_INLINE_FILE_MAX_CHARS`.
- [ ] 1.3 Extend contracts attachment tests (`orchestrationAttachments.test.ts`) for the new kind: valid file, oversized file, non-registry mimeType, attachment-count limit spanning all three kinds.

## 2. Server: upload validation and storage

- [ ] 2.1 Add `validateFileAttachmentPayload` in `apps/server/src/orchestration/AttachmentPayload.ts`: registry extension check, canonical-MIME stamping, NUL-byte text sniff over the first 8 KiB with UTF-16 BOM transcode, ZIP signature check for `.xlsx`, declared-vs-decoded size check; wire into `validateAttachmentPayload`.
- [ ] 2.2 Extend `attachmentRelativePath`/`resolveAttachmentPathById` in `apps/server/src/attachmentStore.ts` to derive `file` storage extensions from the registry (never from raw user input) and include registry extensions in id-based lookup.
- [ ] 2.3 Add server tests: binary-renamed-to-txt rejection, UTF-16 BOM acceptance, fake-xlsx rejection, valid xlsx round-trip to disk, path-safety (name with traversal characters never influences the stored path).

## 3. Web: composer acceptance, drafts, and cards

- [ ] 3.1 Rework `apps/web/src/composerAttachments.ts`: build `COMPOSER_ATTACHMENT_ACCEPT` from the registry, accept registry files in `prepareComposerAttachments` with extension-first classification and canonical-MIME stamping (mirroring `canonicalizePdfFile`), per-kind size errors, and updated rejection copy naming accepted categories.
- [ ] 3.2 Extend `ComposerAttachment`/`PersistedComposerAttachment` in `composerDraftStore.ts` and serialization for the `file` kind; update draft persistence tests.
- [ ] 3.3 Generalize `PdfAttachmentCard` into a kind-driven file card (icon, extension badge, name, size; download for generic files, existing open/download for PDFs) and render `file` attachments in `ChatComposer.tsx` and `MessagesTimeline.tsx`; update component tests.
- [ ] 3.4 Update client-runtime attachment state (`packages/client-runtime/src/state/attachments.ts`) and `apps/web/src/historyBootstrap.ts` for the `file` kind, with tests for optimistic send and history reload.

## 4. Providers: delivery paths

- [ ] 4.1 Relax the type guard in `AcpAttachmentMapping.ts` so `file` attachments map to `resource_link` blocks (covers Grok, Cursor, ACP); extend `AcpAttachmentMapping.test.ts`.
- [ ] 4.2 Relax the Codex adapter guard so `file` attachments become path mentions; update `CodexAdapter` tests and check `CodexTextGeneration.ts` attachment handling for the new kind.
- [ ] 4.3 Relax `findUnsupportedOpenCodeAttachmentType` so `file` parts flow through `toOpenCodeFileParts`; update opencode runtime/adapter tests.
- [ ] 4.4 Claude adapter: inline text-kind files as labeled text content blocks with the `PROVIDER_INLINE_FILE_MAX_CHARS` budget (error naming the file when exceeded), reference `.xlsx` by stored path in the prompt; update `ClaudeAdapter` tests.
- [ ] 4.5 DeepSeek adapter: inline text-kind files into the prompt under the same budget, reject `.xlsx` with an actionable error; update `DeepSeekAdapter`/`DeepSeekProvider` tests.

## 5. Lifecycle and end-to-end verification

- [ ] 5.1 Verify handoff, revert, reconnect, and deletion cleanup treat `file` attachments like PDFs (persistence projections, cleanup, `decider.handoff` paths), adding coverage where a type switch was extended.
- [ ] 5.2 Run the full affected test suites (contracts, client-runtime, web, server) and typecheck; fix fallout from the widened unions (compiler-surfaced exhaustive switches).
- [ ] 5.3 Manual smoke test in the dev instance: attach json/csv/cs/xlsx via picker, drag-drop, and paste; send to one file-reference provider and Claude; confirm cards render in draft and history and errors read correctly for an unsupported type.
