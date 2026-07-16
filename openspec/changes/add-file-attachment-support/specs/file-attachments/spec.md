## ADDED Requirements

### Requirement: Composer accepts supported file attachments

The system SHALL allow users to add PDFs and registry-supported generic files through the file picker, drag-and-drop, or clipboard paste alongside existing images. Supported generic files SHALL include common text, code, and data extensions (`txt`, `md`, `markdown`, `log`, `json`, `jsonl`, `csv`, `tsv`, `xml`, `yaml`, `yml`, `toml`, `ini`, `cfg`, `conf`, `html`, `htm`, `css`, `scss`, `less`, `graphql`, `gql`, `proto`, `js`, `mjs`, `cjs`, `jsx`, `ts`, `mts`, `cts`, `tsx`, `cs`, `py`, `java`, `kt`, `kts`, `go`, `rs`, `rb`, `php`, `c`, `cc`, `cpp`, `cxx`, `h`, `hh`, `hpp`, `hxx`, `sql`, `sh`, `bash`, `zsh`, `fish`, `ps1`, `swift`, `dart`, `lua`, `r`, `vue`, and `svelte`) plus the binary spreadsheet extension `xlsx`. A turn containing supported attachments SHALL be sendable without text.

#### Scenario: Add a PDF from the file picker

- **WHEN** the user selects a file whose MIME type is `application/pdf` or whose name ends in `.pdf` case-insensitively
- **THEN** the composer adds it as a PDF `document` attachment with canonical MIME type `application/pdf`

#### Scenario: Add a source file with misleading browser MIME

- **WHEN** the user selects `video.ts` reported as `video/mp2t` or `Program.cs` reported without a MIME type
- **THEN** the composer accepts the file by extension as a `file` attachment and applies the registry's canonical MIME type

#### Scenario: Drop or paste a mixed set

- **WHEN** the user drops or pastes supported images, PDFs, source files, and spreadsheets into the composer
- **THEN** the composer processes every candidate through the same attachment preparation path and preserves the type and order of all accepted attachments

#### Scenario: Send attachments without text

- **WHEN** a draft contains at least one valid PDF or generic file and no text
- **THEN** the composer allows the user to submit the turn

#### Scenario: Reject an unsupported file without discarding valid candidates

- **WHEN** an input batch contains a valid `notes.md` file and an unsupported `installer.exe` file
- **THEN** the composer retains `notes.md`, rejects `installer.exe`, and reports the rejected filename and accepted categories

### Requirement: Shared contracts distinguish attachment kinds and enforce bounds

The contracts SHALL model existing images as `image`, PDFs as `document`, and allowlisted non-image files as `file` in both persisted and upload attachment unions. Persisted PDF and generic-file metadata SHALL contain a stable ID, original display name, canonical MIME type, and decoded byte size; upload variants SHALL additionally contain a bounded data URL. Each PDF or generic file MUST contain between 1 byte and 10 MiB of decoded data, and images, PDFs, and generic files together MUST NOT exceed eight attachments per message.

#### Scenario: Decode a valid mixed attachment command

- **WHEN** a turn command contains an image, a PDF document, a text file, and an `.xlsx` file within their size and encoded-data bounds
- **THEN** contract decoding succeeds and retains each discriminated variant in its original order

#### Scenario: Reject an oversized file

- **WHEN** an upload declares a PDF or generic file larger than 10 MiB or carries a data URL exceeding its encoded bound
- **THEN** contract decoding rejects the command before provider dispatch

#### Scenario: Enforce the combined attachment count

- **WHEN** a turn command carries six images, two PDFs, and one generic file
- **THEN** contract decoding rejects the command for exceeding the combined limit of eight

### Requirement: File classification policy is shared and extension-authoritative

The web and server SHALL use one shared runtime registry to map supported generic-file extensions to canonical MIME types and text or binary content kinds. Generic-file acceptance MUST be based on the case-insensitive final extension, MUST NOT trust a browser-declared MIME type over the registry, and MUST exclude unregistered, extensionless, and dotfile-only names. The contracts package SHALL remain schema-only and SHALL NOT contain file-classification lookup logic.

#### Scenario: Canonicalize a misleading MIME type

- **WHEN** a supported extension arrives with an empty, generic, or conflicting browser MIME type
- **THEN** both client preparation and server validation select the same canonical registry MIME type

#### Scenario: Reject an extensionless or secret-prone dotfile

- **WHEN** the user attempts to attach `Dockerfile` or `.env`
- **THEN** the composer rejects it because its name has no registered final extension

#### Scenario: Registry expansion remains consistent

- **WHEN** a new extension is added to the shared registry
- **THEN** composer acceptance, server validation, safe storage extension resolution, and accept-filter generation all use that entry without a duplicated allowlist

### Requirement: Server validates uploaded content authoritatively and atomically

Before persisting or dispatching a turn, the server MUST strictly decode every attachment data URL, reject empty or malformed data, verify declared size against decoded length, enforce encoded and decoded limits, canonicalize type metadata, and complete kind-specific validation. A PDF MUST contain `%PDF-` within the first 1,024 bytes. A generic text file MUST NOT contain unexplained NUL bytes in the first 8 KiB, while a valid UTF-16 BOM MUST permit the original bytes to be retained. An `.xlsx` file MUST begin with `PK\x03\x04`. If any attachment fails validation or persistence, the entire turn MUST fail before provider invocation and no file created for that command may remain committed.

#### Scenario: Reject spoofed PDF content

- **WHEN** an upload is declared or named as a PDF but has no `%PDF-` signature within its first 1,024 decoded bytes
- **THEN** the server rejects the turn without persisting any attachment or invoking a provider

#### Scenario: Reject mismatched size metadata

- **WHEN** any decoded attachment length differs from its declared `sizeBytes`
- **THEN** the server rejects the turn with an attachment validation error naming the file

#### Scenario: Reject a binary renamed as text

- **WHEN** `data.txt` contains NUL bytes in its first 8 KiB and has no recognized UTF-16 BOM
- **THEN** the server rejects it as unreadable text without echoing file contents

#### Scenario: Accept BOM-marked UTF-16 text

- **WHEN** a registry text file begins with a valid UTF-16 byte-order mark and otherwise satisfies its bounds
- **THEN** the server accepts and stores the original bytes and an inlining provider decodes the text according to the BOM

#### Scenario: Validate spreadsheet signature

- **WHEN** `report.xlsx` has a matching declared size and begins with the ZIP local-file-header signature
- **THEN** the server accepts it as an `.xlsx` file

#### Scenario: Roll back a partially staged batch

- **WHEN** one attachment in a multi-attachment command fails validation, staging, projection, or commit after another attachment has been processed
- **THEN** the turn fails and cleanup removes every staged or committed file created for that command

### Requirement: Stored attachments remain contained and lifecycle-safe

The system SHALL store attachments under generated thread-scoped IDs using only implementation-owned safe extensions: inferred safe image extensions for images, `.pdf` for documents, and registry extensions for generic files. Original filenames MUST remain metadata and MUST NOT influence directory paths. Attachment metadata and bytes SHALL survive optimistic reconciliation, projection, reconnect, history reload, and T3-local handoff. Revert, replacement, projection rollback, and thread deletion SHALL remove only attachments that became unreferenced and are owned by the affected thread.

#### Scenario: Ignore traversal characters in an original filename

- **WHEN** a valid generic file has an original name containing path separators or traversal segments before its registered final extension
- **THEN** its stored path consists only of the contained generated ID and the registry-owned extension

#### Scenario: Reload mixed attachment history

- **WHEN** a client reconnects to a thread containing image, PDF, and generic-file attachments
- **THEN** history preserves each attachment's metadata, order, and resolvable signed asset reference

#### Scenario: Hand off a thread with files

- **WHEN** a T3-local thread handoff imports user messages containing PDF and generic-file attachments
- **THEN** the imported messages retain their attachment variants and resolvable references

#### Scenario: Delete unreferenced files without crossing thread ownership

- **WHEN** a revert, replacement, rollback, or thread deletion makes attachments unreferenced
- **THEN** cleanup removes only the corresponding files owned by that thread and leaves other threads' files unchanged

### Requirement: Non-image attachments render as accessible file cards

The composer and user-message history SHALL render PDFs and generic files as accessible file cards rather than image thumbnails. Each card SHALL show the original filename, human-readable size, icon, and extension badge. Draft cards SHALL expose a labeled remove action. Persisted PDF cards SHALL expose labeled open and original-name download actions when a valid signed asset URL exists; generic file cards SHALL expose original-name download only. Missing or expired URLs SHALL leave metadata visible without broken actions.

#### Scenario: Display and remove a draft file

- **WHEN** a valid PDF or generic file is present in the current draft
- **THEN** the composer displays its metadata and a keyboard-operable remove control with an accessible label

#### Scenario: Open and download a persisted PDF

- **WHEN** a persisted PDF card has a valid signed asset URL
- **THEN** the user can open it in a separate browsing context using `noopener` or download it using its original filename

#### Scenario: Download active generic content safely

- **WHEN** the user downloads a persisted HTML, script, or other generic text attachment
- **THEN** the asset response forces attachment disposition, uses the original download filename, and includes `X-Content-Type-Options: nosniff`

#### Scenario: Signed asset URL is unavailable

- **WHEN** a file card's signed asset URL is missing, expired, unresolved, or still loading
- **THEN** the card retains its metadata and does not expose a broken open or download action

#### Scenario: Release draft resources

- **WHEN** a draft file is removed, replaced during hydration, moved by thread switching, or discarded on unmount
- **THEN** the client revokes any object URL that is no longer referenced without losing other valid draft attachments

### Requirement: Providers receive supported attachments without silent degradation

Each provider adapter MUST map every attachment in order to a supported native representation or reject the entire turn with an actionable error. Codex SHALL receive images as image inputs and PDFs or generic files as safe local-path mentions. Claude SHALL receive images as image blocks, PDFs as base64 `application/pdf` document blocks, generic text as labeled text blocks, and `.xlsx` as a labeled safe local-path reference. OpenCode SHALL receive all variants as file parts. ACP-mapped providers including Cursor and Grok SHALL receive images as embedded image blocks and PDFs or generic files as `resource_link` blocks containing name, canonical MIME type, byte size, and a platform-safe local file URI. DeepSeek SHALL inline generic text and SHALL reject PDF or `.xlsx` inputs as unsupported.

#### Scenario: Deliver a mixed turn to Codex

- **WHEN** a Codex turn contains an image, PDF, source file, and spreadsheet
- **THEN** the adapter emits the image input followed by safe local-path mentions for the remaining attachments in attachment order

#### Scenario: Deliver native and inline blocks to Claude

- **WHEN** a Claude turn contains a PDF and a UTF-encoded text file within the inline budget
- **THEN** the SDK user content includes a PDF document block followed by a filename-labeled, correctly decoded text block

#### Scenario: Deliver resource links through ACP

- **WHEN** a Cursor or Grok turn contains a PDF and an `.xlsx` file
- **THEN** the shared ACP mapping emits ordered `resource_link` blocks with contained platform-safe file URIs and complete metadata

#### Scenario: Deliver file parts to OpenCode

- **WHEN** an OpenCode turn contains any supported attachment kind
- **THEN** the prompt includes an ordered file part with the attachment's filename, MIME type, and contained local file URL

#### Scenario: Reject an unsupported DeepSeek attachment

- **WHEN** a DeepSeek turn contains a PDF or `.xlsx` attachment
- **THEN** the adapter rejects the entire turn with an error naming the unsupported attachment category and sends no partial prompt

#### Scenario: Reject a missing attachment path

- **WHEN** any adapter cannot resolve or read a referenced attachment from the contained attachment store
- **THEN** it rejects the entire turn before dispatch and does not omit the attachment

### Requirement: Inline providers enforce a cumulative text budget

Any provider adapter that inlines generic text files MUST enforce a cumulative per-turn limit of 256 KiB decoded characters across those files. The adapter MUST reject the entire turn when adding a file would exceed the limit, MUST name the offending file and the limit, and MUST NOT silently truncate or partially send content. Providers that pass contained file references SHALL NOT inline files merely to satisfy this requirement.

#### Scenario: Inline text within the budget

- **WHEN** the cumulative decoded text attached to a Claude or DeepSeek turn is at most 256 KiB characters
- **THEN** the adapter includes every file in full with an unambiguous filename label

#### Scenario: Reject cumulative inline overflow

- **WHEN** adding `large.log` would make a provider's cumulative inline content exceed 256 KiB characters
- **THEN** the adapter rejects the turn with an error naming `large.log` and the 256 KiB limit and sends no truncated content
