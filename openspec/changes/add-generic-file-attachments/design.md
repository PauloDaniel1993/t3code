## Context

Attachments today are a two-kind union in `packages/contracts/src/orchestration.ts`: `ChatImageAttachment` (`image/*`, ≤10 MiB) and `ChatDocumentAttachment` (literal `application/pdf`, ≤10 MiB, PDF signature verified server-side). The pipeline is:

1. **Composer** (`apps/web/src/composerAttachments.ts`) filters files (`COMPOSER_ATTACHMENT_ACCEPT = "image/*,application/pdf,.pdf"`), builds draft attachments, persists them as data URLs.
2. **Upload** sends `UploadChatAttachment` (dataUrl payloads); `apps/server/src/orchestration/AttachmentPayload.ts` validates and decodes; `attachmentStore.ts` writes bytes to `<attachmentsDir>/<id><ext>` where the extension is _derived from the attachment record_ (`.pdf` for documents, sniffed extension for images).
3. **Delivery** per provider:
   - ACP mapping (`AcpAttachmentMapping.ts`, used by Grok, Cursor, and ACP providers): documents become `resource_link` blocks (name, mimeType, size, `file://` URI) — the agent reads the file itself.
   - Codex: documents become path `mention`s.
   - OpenCode (`toOpenCodeFileParts`): generic `file` parts (mime, filename, `file://` URL) — already type-agnostic; only the upstream guard restricts to image/document.
   - Claude: embeds base64 `document`/`image` content blocks into the SDK user message.
   - DeepSeek: rejects all attachments with actionable errors.

Every layer has an explicit `image`/`document` type guard, so adding a kind is mechanical but wide.

## Goals / Non-Goals

**Goals:**

- Accept common LLM-consumable files in the composer: text/code/data files (json, csv, tsv, xml, yaml, md, txt, log, html, css, js/ts/jsx/tsx, cs, py, java, go, rs, rb, php, c/cpp/h, sql, sh, ps1, toml, ini, and similar) plus `xlsx`.
- One new contract kind that flows through drafts, upload, persistence, history, handoff, revert, and cleanup exactly like PDFs do.
- Deliver files via the mechanism each provider already uses; degrade with actionable errors where a provider genuinely cannot accept a file.

**Non-Goals:**

- Server-side content extraction/conversion (e.g., xlsx→CSV, docx text extraction). Agentic providers parse files with their own tools.
- `docx`/`pptx`/other OOXML types beyond `xlsx` (the allowlist is designed so they can be added later as data entries, not new code paths).
- Extension-less files (`Dockerfile`, `.gitignore`-style dotfiles) — deferred; requires pure content-sniffing acceptance.
- Raising the 8-attachment or 10 MiB limits.

## Decisions

### D1: New `file` attachment kind, not a widened `document`

Add `ChatFileAttachment` (`type: "file"`, id, name, mimeType, sizeBytes) and `UploadChatFileAttachment` (+dataUrl) to the `ChatAttachment`/`UploadChatAttachment` unions. `document` stays PDF-only.

_Why not widen `document`_: PDF has bespoke handling everywhere (signature check, `.pdf` path derivation, Claude base64 `document` block, dedicated card). Overloading its mimeType literal would push per-type branching inside every `case "document"` arm; a third union member keeps each arm single-purpose and makes exhaustive `switch` statements surface every site the compiler needs updated.

### D2: Shared file-type registry in contracts

Add a registry module in `packages/contracts` mapping canonical extension → `{ mimeType, kind: "text" | "binary" }` (all initial entries are `text` except `.xlsx`). From it derive:

- the composer `accept` string and client-side classification,
- server-side extension/MIME validation and canonical MIME normalization,
- the storage extension for `attachmentRelativePath` (see D4).

_Why extension-first, not browser MIME_: browsers report unreliable MIMEs for code files (`.ts` → `video/mp2t`, `.cs`/`.rs`/`.toml` → empty string). The registry canonicalizes: extension is the lookup key; the declared MIME is advisory and gets replaced by the canonical one, mirroring how `canonicalizePdfFile` already repairs extension-only PDFs.

### D3: Server validation per kind

Extend `validateAttachmentPayload` with a `file` arm:

- Extension must be in the registry; canonical MIME is stamped onto the stored record.
- `text`-kind files: decoded bytes must not contain NUL bytes within the first 8 KiB (rejects binaries renamed to `.txt`); size ≤ `PROVIDER_SEND_TURN_MAX_FILE_BYTES` (10 MiB, matching PDF).
- `.xlsx`: must start with the ZIP local-file-header signature `PK\x03\x04` (same spirit as the `%PDF-` check).
- Declared `sizeBytes` must equal decoded length (as PDFs do today).

### D4: Storage path derives extension from the sanitized file name via the registry

`attachmentRelativePath` gains a `file` arm: take the extension from `attachment.name`, look it up in the registry, and use the canonical extension; this keeps path resolution deterministic from the record alone (required by `resolveAttachmentPath` callers) and keeps user input out of the filesystem path — only registry-owned extension strings are ever appended to the id. `resolveAttachmentPathById` iterates registry extensions in addition to the current image/pdf/bin list.

### D5: Delivery matrix — file reference where the agent has tools, inline text otherwise

| Provider path                   | Mechanism for `file`                                                                                                                                                                                                                                                                                                          |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ACP mapping (Grok, Cursor, ACP) | `resource_link` block — identical to PDFs; relax the type guard.                                                                                                                                                                                                                                                              |
| Codex                           | path `mention` — identical to PDFs; relax the type guard.                                                                                                                                                                                                                                                                     |
| OpenCode                        | `file` part — already generic; relax `findUnsupportedOpenCodeAttachmentType`.                                                                                                                                                                                                                                                 |
| Claude                          | `text`-kind: inline text content block wrapping the file body in a fenced section labeled with the file name. `.xlsx`: append a prompt line referencing the absolute stored path so the agent reads it with its own tools (it runs locally with file access). Inline content counts against a per-turn inline budget (below). |
| DeepSeek                        | `text`-kind: inline into the prompt text the same way. `.xlsx`: reject with an actionable error ("DeepSeek cannot read spreadsheet attachments").                                                                                                                                                                             |

Inline budget: providers that inline enforce `PROVIDER_INLINE_FILE_MAX_CHARS` (256 KiB of decoded text per turn); exceeding it yields an actionable error naming the file, instead of silently truncating. File-reference providers have no inline budget — the agent decides how much to read.

_Why not inline everywhere_: file-reference delivery is already the proven PDF path for ACP/Codex/OpenCode, avoids blowing context on large data files, and lets agents parse xlsx natively.

### D6: UI — generalize the PDF card

Rename/extend `PdfAttachmentCard` into a file card driven by attachment kind: icon + extension badge + name + size. PDFs keep their current open/download affordances; generic files get download (open-in-app is out of scope, and the PDF open-action bug is tracked separately in `openspec/changes/`). Draft-side error copy changes from "images or PDF files" to naming the accepted categories, and the file input `accept` comes from the registry.

## Risks / Trade-offs

- [Browser MIME chaos causes false rejections] → Extension is the source of truth (D2); MIME is normalized, never trusted for acceptance.
- [Text sniff false positives (UTF-16 files contain NULs)] → Accept BOM-prefixed UTF-16 by detecting the BOM before the NUL scan and transcoding to UTF-8 during validation; otherwise reject with a clear error.
- [Large inlined files degrade turns on Claude/DeepSeek] → Hard inline budget with an explicit per-file error (D5); users can switch to a file-capable provider.
- [Path-safety regression from user-controlled names] → Names never reach the filesystem; only registry extensions are appended to server-generated ids (D4).
- [Allowlist churn ("why not .xyz?")] → Registry is data, not code; adding an extension is a one-line entry plus a test row.
- [Secrets in attached files (.env, config with keys) sent to providers] → Same trust model as pasting text or attaching a PDF; no new mitigation, but error copy never echoes file contents.

## Migration Plan

Purely additive: new union member, new constants, relaxed guards. Existing persisted image/PDF attachments are untouched; old clients simply never produce `file` attachments. No data migration. Rollback = revert; stored `file` attachments would then fail schema validation on read, which matches the pre-change behavior for unknown types (actionable server error).

## Open Questions

- Should extension-less text files (`Dockerfile`, `Makefile`) be accepted via pure content sniffing in a follow-up?
- Is `.env` acceptance desirable, or should it be excluded from the registry to reduce accidental secret sharing?
