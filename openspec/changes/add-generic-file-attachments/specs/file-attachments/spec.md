# file-attachments Specification

## ADDED Requirements

### Requirement: Composer accepts common text, code, data, and spreadsheet files

The chat composer SHALL accept files whose extension appears in the shared attachment file-type registry (text, code, and data formats such as json, csv, tsv, xml, yaml, md, txt, log, html, css, js, jsx, ts, tsx, cs, py, java, go, rs, rb, php, c, cpp, h, sql, sh, ps1, toml, ini, plus xlsx) via the file picker, drag-and-drop, and paste, in addition to the existing image and PDF support. Files outside the registry SHALL be rejected with an error naming the file and the accepted categories.

#### Scenario: Attaching a source file via the picker

- **WHEN** the user selects `Program.cs` from the attachment picker
- **THEN** the composer adds a `file` draft attachment with the canonical MIME type from the registry and shows a file card with name, extension badge, and size

#### Scenario: Attaching an unsupported binary

- **WHEN** the user drops `installer.exe` onto the composer
- **THEN** the composer rejects the file with an error naming `installer.exe` and the accepted file categories, and other files in the same drop are still processed

#### Scenario: Browser reports a misleading MIME type

- **WHEN** the user attaches `video.ts` (a TypeScript source file the browser labels `video/mp2t`) or `app.cs` (labeled with an empty MIME type)
- **THEN** the composer accepts the file based on its extension and stamps the registry's canonical MIME type

### Requirement: Shared contracts model generic file attachments

The contracts package SHALL define a `file` attachment kind (id, name, canonical MIME type, size) and a corresponding upload payload (with data URL), included in the `ChatAttachment` and `UploadChatAttachment` unions, with size bounded by a `PROVIDER_SEND_TURN_MAX_FILE_BYTES` constant of 10 MiB. The combined per-message attachment limit SHALL remain `PROVIDER_SEND_TURN_MAX_ATTACHMENTS` across images, PDFs, and files.

#### Scenario: File attachment within limits validates

- **WHEN** a `file` attachment with a registry MIME type and size ≤ 10 MiB is decoded against the contracts schema
- **THEN** validation succeeds

#### Scenario: Attachment count limit spans all kinds

- **WHEN** a send-turn command carries 6 images, 2 PDFs, and 1 file attachment
- **THEN** the command is rejected for exceeding the 8-attachment limit

### Requirement: Server validates file uploads by kind

The server SHALL validate each uploaded `file` attachment before storage: the extension MUST be present in the registry; text-kind files MUST contain no NUL bytes within the first 8 KiB of decoded content (UTF-16 files with a BOM SHALL be transcoded to UTF-8 instead of rejected); `.xlsx` files MUST begin with the ZIP signature `PK\x03\x04`; and the declared size MUST equal the decoded byte length. Failures SHALL produce actionable errors naming the file without echoing its contents.

#### Scenario: Binary renamed to .txt is rejected

- **WHEN** a client uploads a `file` attachment named `data.txt` whose decoded bytes contain NUL bytes in the first 8 KiB and no UTF-16 BOM
- **THEN** the server rejects the upload with an error identifying `data.txt` as not a readable text file

#### Scenario: Valid xlsx is stored

- **WHEN** a client uploads `report.xlsx` whose decoded bytes begin with `PK\x03\x04` and whose declared size matches
- **THEN** the server stores the bytes under the attachment id with the `.xlsx` extension and persists the attachment on the message

#### Scenario: Fake xlsx is rejected

- **WHEN** a client uploads `report.xlsx` whose decoded bytes do not begin with the ZIP signature
- **THEN** the server rejects the upload with an error naming `report.xlsx`

### Requirement: File attachments are delivered through each provider's supported mechanism

Providers that already receive PDFs as file references (ACP-mapped providers including Grok and Cursor, Codex, OpenCode) SHALL receive `file` attachments through the same mechanism (`resource_link`, path mention, or file part). The Claude adapter SHALL inline text-kind file contents as labeled text blocks and reference `.xlsx` files by stored path. The DeepSeek adapter SHALL inline text-kind file contents into the prompt and SHALL reject `.xlsx` with an actionable error. Providers that inline SHALL enforce a per-turn inline budget (`PROVIDER_INLINE_FILE_MAX_CHARS`) and reject over-budget turns with an error naming the offending file rather than truncating silently.

#### Scenario: JSON file to an ACP provider

- **WHEN** a turn with a `config.json` file attachment is sent to a provider using the ACP attachment mapping
- **THEN** the provider receives a `resource_link` block with the file name, canonical MIME type, size, and `file://` URI of the stored attachment

#### Scenario: CSV file to Claude

- **WHEN** a turn with a `sales.csv` attachment under the inline budget is sent to the Claude adapter
- **THEN** the SDK user message contains a text block labeled with `sales.csv` wrapping the file contents

#### Scenario: xlsx to DeepSeek is rejected

- **WHEN** a turn with a `report.xlsx` attachment is sent to the DeepSeek adapter
- **THEN** the turn fails with an actionable error stating that DeepSeek cannot read spreadsheet attachments

#### Scenario: Oversized text file on an inlining provider

- **WHEN** a turn with a text file exceeding `PROVIDER_INLINE_FILE_MAX_CHARS` is sent to an adapter that inlines file contents
- **THEN** the turn fails with an error naming the file and the inline limit, and no truncated content is sent

### Requirement: File attachments persist across the message lifecycle

`file` attachments SHALL survive optimistic sends, reconnects, thread history reloads, provider handoff, and revert, and SHALL be deleted by the same cleanup that removes image and PDF attachment files, matching existing PDF behavior.

#### Scenario: History reload renders file card

- **WHEN** a thread containing a message with a `notes.md` attachment is reloaded
- **THEN** the message renders a file card for `notes.md` with its size and extension badge

#### Scenario: Thread deletion removes stored files

- **WHEN** a thread whose messages include `file` attachments is deleted
- **THEN** the stored attachment files for that thread are removed from the attachments directory
