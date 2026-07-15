## ADDED Requirements

### Requirement: Composer accepts PDF attachments

The system SHALL allow a user to add PDF files to a chat draft through the file picker, drag and drop, or clipboard paste. A PDF MAY be combined with image attachments, and a turn containing a PDF SHALL be sendable without text.

#### Scenario: Add a PDF from the file picker

- **WHEN** the user chooses a file whose MIME type is `application/pdf` or whose filename ends in `.pdf`
- **THEN** the composer adds the file as a PDF document attachment

#### Scenario: Drop or paste a PDF

- **WHEN** the user drops or pastes a PDF file onto the composer
- **THEN** the composer accepts it through the same attachment validation path as a picked file

#### Scenario: Send a mixed attachment turn

- **WHEN** a draft contains both supported images and PDFs
- **THEN** the system preserves the type and order of every attachment in the submitted turn

#### Scenario: Send a PDF-only turn

- **WHEN** a draft contains at least one valid PDF and no text
- **THEN** the composer allows the user to submit the turn

### Requirement: PDF attachment limits are enforced

The system SHALL limit each PDF to 10 MiB of decoded file data and SHALL count PDFs and images together toward the existing maximum of eight attachments per message. The composer SHALL present an actionable validation message and SHALL leave already-valid draft attachments intact when a candidate file is rejected.

#### Scenario: Reject an oversized PDF

- **WHEN** the user attempts to attach a PDF larger than 10 MiB
- **THEN** the composer rejects that file and identifies the 10 MiB PDF limit

#### Scenario: Enforce the combined count limit

- **WHEN** adding PDFs would cause the draft to contain more than eight total image and PDF attachments
- **THEN** the composer accepts no attachments beyond the eighth and reports the combined attachment limit

#### Scenario: Reject an unrelated file type

- **WHEN** the user attempts to attach a file that is neither a supported image nor a PDF candidate
- **THEN** the composer rejects that file and states that images and PDFs are supported

### Requirement: Server validates PDF payloads authoritatively

The server MUST validate uploaded PDF data before persistence or provider dispatch. Validation MUST require a valid base64 data URL, canonicalize the MIME type to `application/pdf`, enforce the decoded 10 MiB limit and declared-size match, and find the PDF `%PDF-` signature within the first 1,024 decoded bytes. Client-provided filenames and MIME types MUST NOT bypass this validation.

#### Scenario: Accept a browser PDF with a missing MIME type

- **WHEN** a `.pdf` file accepted by the composer has no browser-provided MIME type and its decoded content has a valid PDF signature
- **THEN** the upload uses and persists the canonical MIME type `application/pdf`

#### Scenario: Reject spoofed PDF content

- **WHEN** an uploaded attachment is declared as a PDF but its decoded content has no PDF signature within the first 1,024 bytes
- **THEN** the server rejects the turn before writing the attachment or invoking a provider

#### Scenario: Reject mismatched size metadata

- **WHEN** the decoded PDF byte length differs from the attachment's declared size or exceeds 10 MiB
- **THEN** the server rejects the turn with an attachment validation error

### Requirement: PDF metadata and bytes persist with the message lifecycle

The system SHALL model a PDF as a document attachment with a stable identifier, original display name, canonical MIME type, and byte size. It SHALL persist the bytes under a safe `.pdf` attachment path and preserve the attachment through optimistic reconciliation, message projection, reconnect, T3-local thread handoff, and history reload. Existing revert, replacement, and thread-deletion cleanup SHALL remove unreferenced PDF files under the same rules as image files.

#### Scenario: Reconnect after sending a PDF

- **WHEN** the client reconnects or reloads history after a PDF turn was persisted
- **THEN** the user message contains the same PDF attachment metadata and resolves to the persisted PDF asset

#### Scenario: Hand off a thread with a PDF

- **WHEN** a T3-local thread handoff imports a user message containing a PDF attachment
- **THEN** the imported message retains the PDF metadata and a resolvable attachment reference

#### Scenario: Revert or delete PDF-bearing history

- **WHEN** a PDF attachment becomes unreferenced because its turn is reverted, its attachment set is replaced, or its thread is deleted
- **THEN** attachment cleanup removes only the corresponding unreferenced PDF file and does not remove attachments owned by other threads

### Requirement: PDF attachments have document-specific UI

The composer and user-message history SHALL render PDFs as accessible document cards rather than image thumbnails. Each card SHALL show the filename and human-readable size, expose a labeled remove action while drafting, and expose labeled open and download actions after an asset URL is available.

#### Scenario: Display and remove a draft PDF

- **WHEN** a valid PDF is present in the current draft
- **THEN** the composer shows a PDF card with its name, size, and an accessible remove control

#### Scenario: Open or download a persisted PDF

- **WHEN** a persisted PDF card has a valid signed asset URL
- **THEN** the user can open the PDF in a new browsing context or download it using its original filename

#### Scenario: Signed asset URL is unavailable

- **WHEN** a PDF card's signed asset URL is expired, unresolved, or still loading
- **THEN** the card remains visible with its metadata and does not expose a broken open or download action

### Requirement: Providers receive PDFs without silent degradation

Each provider adapter that can represent a local PDF SHALL translate the persisted document into its supported input form without changing attachment order. Codex SHALL receive a local file mention, Claude SHALL receive a base64 PDF document block, OpenCode SHALL receive a file part, and ACP providers such as Cursor and Grok SHALL receive a PDF resource link. An adapter that cannot represent PDFs MUST reject the entire turn with an actionable unsupported-provider error and MUST NOT silently omit the PDF.

#### Scenario: Deliver a PDF to Codex

- **WHEN** a PDF-bearing turn is dispatched through the Codex adapter
- **THEN** the Codex turn input includes a file mention containing the original name and safe persisted PDF path

#### Scenario: Deliver a PDF to Claude

- **WHEN** a PDF-bearing turn is dispatched through the Claude adapter
- **THEN** the Claude user content includes a document block with `application/pdf` base64 data

#### Scenario: Deliver a PDF to OpenCode

- **WHEN** a PDF-bearing turn is dispatched through the OpenCode adapter
- **THEN** the OpenCode prompt includes a file part with the PDF filename, MIME type, and local file URL

#### Scenario: Deliver a PDF to an ACP provider

- **WHEN** a PDF-bearing turn is dispatched through an ACP adapter that accepts resource links
- **THEN** the ACP prompt includes a resource link with the PDF filename, MIME type, byte size, and local file URI

#### Scenario: Selected provider cannot receive PDFs

- **WHEN** a PDF-bearing turn targets a provider adapter without a supported PDF representation
- **THEN** the adapter rejects the turn with a message that names PDF attachments as unsupported for that provider
