/**
 * Registry of generic (non-image, non-PDF) chat attachment file types.
 *
 * The extension is the source of truth: browsers report unreliable MIME types
 * for code files (`.ts` -> `video/mp2t`, `.cs` -> empty string), so acceptance
 * and classification key off the canonical extension and the declared MIME is
 * replaced by the canonical one before persistence or delivery.
 */

export type ChatFileAttachmentKind = "text" | "binary";

export interface ChatFileTypeInfo {
  readonly extension: string;
  readonly mimeType: string;
  readonly kind: ChatFileAttachmentKind;
}

const text = (extension: string, mimeType: string): ChatFileTypeInfo => ({
  extension,
  mimeType,
  kind: "text",
});

export const CHAT_FILE_TYPES: ReadonlyArray<ChatFileTypeInfo> = [
  // Plain text and docs
  text(".txt", "text/plain"),
  text(".md", "text/markdown"),
  text(".markdown", "text/markdown"),
  text(".log", "text/plain"),
  text(".ini", "text/plain"),
  // Structured data
  text(".json", "application/json"),
  text(".jsonl", "application/jsonl"),
  text(".csv", "text/csv"),
  text(".tsv", "text/tab-separated-values"),
  text(".xml", "application/xml"),
  text(".yaml", "application/yaml"),
  text(".yml", "application/yaml"),
  text(".toml", "application/toml"),
  // Web
  text(".html", "text/html"),
  text(".htm", "text/html"),
  text(".css", "text/css"),
  text(".js", "text/javascript"),
  text(".mjs", "text/javascript"),
  text(".cjs", "text/javascript"),
  text(".jsx", "text/jsx"),
  text(".ts", "text/x-typescript"),
  text(".tsx", "text/x-typescript"),
  text(".vue", "text/x-vue"),
  text(".svelte", "text/x-svelte"),
  // General-purpose languages
  text(".cs", "text/x-csharp"),
  text(".py", "text/x-python"),
  text(".java", "text/x-java"),
  text(".go", "text/x-go"),
  text(".rs", "text/x-rust"),
  text(".rb", "text/x-ruby"),
  text(".php", "text/x-php"),
  text(".swift", "text/x-swift"),
  text(".kt", "text/x-kotlin"),
  text(".c", "text/x-c"),
  text(".h", "text/x-c"),
  text(".cpp", "text/x-c++"),
  text(".hpp", "text/x-c++"),
  // Query, schema, and scripting
  text(".sql", "application/sql"),
  text(".graphql", "application/graphql"),
  text(".proto", "text/x-protobuf"),
  text(".sh", "application/x-sh"),
  text(".ps1", "text/x-powershell"),
  text(".bat", "text/x-batch"),
  text(".cmd", "text/x-batch"),
  // Structured binary spreadsheets
  {
    extension: ".xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    kind: "binary",
  },
];

const CHAT_FILE_TYPES_BY_EXTENSION = new Map(
  CHAT_FILE_TYPES.map((fileType) => [fileType.extension, fileType]),
);

export const CHAT_FILE_ATTACHMENT_EXTENSIONS: ReadonlyArray<string> = CHAT_FILE_TYPES.map(
  (fileType) => fileType.extension,
);

export const CHAT_FILE_ATTACHMENT_MIME_TYPES: ReadonlySet<string> = new Set(
  CHAT_FILE_TYPES.map((fileType) => fileType.mimeType),
);

/** File-input accept fragment covering every registered extension. */
export const CHAT_FILE_ATTACHMENT_ACCEPT = CHAT_FILE_ATTACHMENT_EXTENSIONS.join(",");

export function chatFileTypeForExtension(extension: string): ChatFileTypeInfo | null {
  const normalized = extension.trim().toLowerCase();
  if (normalized.length === 0) {
    return null;
  }
  const withDot = normalized.startsWith(".") ? normalized : `.${normalized}`;
  return CHAT_FILE_TYPES_BY_EXTENSION.get(withDot) ?? null;
}

export function chatFileTypeForFileName(fileName: string): ChatFileTypeInfo | null {
  const normalized = fileName.trim().toLowerCase();
  const extensionIndex = normalized.lastIndexOf(".");
  if (extensionIndex <= 0 || extensionIndex === normalized.length - 1) {
    return null;
  }
  return chatFileTypeForExtension(normalized.slice(extensionIndex));
}

export function isChatFileMimeType(mimeType: string): boolean {
  return CHAT_FILE_ATTACHMENT_MIME_TYPES.has(mimeType.trim().toLowerCase());
}

/**
 * Lookup for stored attachments, which carry the canonical MIME type. Several
 * extensions can share a MIME; the first registry entry wins, and every
 * registered MIME maps to a single kind.
 */
export function chatFileTypeForMimeType(mimeType: string): ChatFileTypeInfo | null {
  const normalized = mimeType.trim().toLowerCase();
  return CHAT_FILE_TYPES.find((fileType) => fileType.mimeType === normalized) ?? null;
}

export function chatFileKindForMimeType(mimeType: string): ChatFileAttachmentKind | null {
  return chatFileTypeForMimeType(mimeType)?.kind ?? null;
}
