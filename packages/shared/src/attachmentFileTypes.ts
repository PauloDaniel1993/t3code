export type AttachmentFileContentKind = "text" | "binary";

export interface AttachmentFileType {
  readonly mimeType: string;
  readonly contentKind: AttachmentFileContentKind;
}

function attachmentFileType(
  mimeType: string,
  contentKind: AttachmentFileContentKind,
): AttachmentFileType {
  return Object.freeze({ mimeType, contentKind });
}

// Structured and web formats use their established media types. Source-language
// extensions consistently use text/plain because browser-provided source MIME types
// are unreliable and classification is always based on the extension.
export const ATTACHMENT_FILE_TYPES = Object.freeze({
  txt: attachmentFileType("text/plain", "text"),
  md: attachmentFileType("text/markdown", "text"),
  markdown: attachmentFileType("text/markdown", "text"),
  log: attachmentFileType("text/plain", "text"),
  json: attachmentFileType("application/json", "text"),
  jsonl: attachmentFileType("application/x-ndjson", "text"),
  csv: attachmentFileType("text/csv", "text"),
  tsv: attachmentFileType("text/tab-separated-values", "text"),
  xml: attachmentFileType("application/xml", "text"),
  yaml: attachmentFileType("application/yaml", "text"),
  yml: attachmentFileType("application/yaml", "text"),
  toml: attachmentFileType("application/toml", "text"),
  ini: attachmentFileType("text/plain", "text"),
  cfg: attachmentFileType("text/plain", "text"),
  conf: attachmentFileType("text/plain", "text"),
  html: attachmentFileType("text/html", "text"),
  htm: attachmentFileType("text/html", "text"),
  css: attachmentFileType("text/css", "text"),
  scss: attachmentFileType("text/plain", "text"),
  less: attachmentFileType("text/plain", "text"),
  graphql: attachmentFileType("text/plain", "text"),
  gql: attachmentFileType("text/plain", "text"),
  proto: attachmentFileType("text/plain", "text"),
  js: attachmentFileType("text/plain", "text"),
  mjs: attachmentFileType("text/plain", "text"),
  cjs: attachmentFileType("text/plain", "text"),
  jsx: attachmentFileType("text/plain", "text"),
  ts: attachmentFileType("text/plain", "text"),
  mts: attachmentFileType("text/plain", "text"),
  cts: attachmentFileType("text/plain", "text"),
  tsx: attachmentFileType("text/plain", "text"),
  cs: attachmentFileType("text/plain", "text"),
  py: attachmentFileType("text/plain", "text"),
  java: attachmentFileType("text/plain", "text"),
  kt: attachmentFileType("text/plain", "text"),
  kts: attachmentFileType("text/plain", "text"),
  go: attachmentFileType("text/plain", "text"),
  rs: attachmentFileType("text/plain", "text"),
  rb: attachmentFileType("text/plain", "text"),
  php: attachmentFileType("text/plain", "text"),
  c: attachmentFileType("text/plain", "text"),
  cc: attachmentFileType("text/plain", "text"),
  cpp: attachmentFileType("text/plain", "text"),
  cxx: attachmentFileType("text/plain", "text"),
  h: attachmentFileType("text/plain", "text"),
  hh: attachmentFileType("text/plain", "text"),
  hpp: attachmentFileType("text/plain", "text"),
  hxx: attachmentFileType("text/plain", "text"),
  sql: attachmentFileType("text/plain", "text"),
  sh: attachmentFileType("text/plain", "text"),
  bash: attachmentFileType("text/plain", "text"),
  zsh: attachmentFileType("text/plain", "text"),
  fish: attachmentFileType("text/plain", "text"),
  ps1: attachmentFileType("text/plain", "text"),
  swift: attachmentFileType("text/plain", "text"),
  dart: attachmentFileType("text/plain", "text"),
  lua: attachmentFileType("text/plain", "text"),
  r: attachmentFileType("text/plain", "text"),
  vue: attachmentFileType("text/plain", "text"),
  svelte: attachmentFileType("text/plain", "text"),
  xlsx: attachmentFileType(
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "binary",
  ),
});

export type AttachmentFileExtension = keyof typeof ATTACHMENT_FILE_TYPES;

export const ACCEPTED_ATTACHMENT_FILE_EXTENSIONS = Object.freeze(
  Object.keys(ATTACHMENT_FILE_TYPES),
) as readonly AttachmentFileExtension[];

export function getAttachmentFileExtension(fileName: string): string | undefined {
  const finalDotIndex = fileName.lastIndexOf(".");
  if (finalDotIndex <= 0 || finalDotIndex === fileName.length - 1) return undefined;

  return fileName.slice(finalDotIndex + 1).toLowerCase();
}

export function lookupAttachmentFileType(fileName: string): AttachmentFileType | undefined {
  const extension = getAttachmentFileExtension(fileName);
  if (!extension) return undefined;
  if (!Object.hasOwn(ATTACHMENT_FILE_TYPES, extension)) return undefined;

  return ATTACHMENT_FILE_TYPES[extension as AttachmentFileExtension];
}

export function getAttachmentFileInputAccept(): string {
  return ACCEPTED_ATTACHMENT_FILE_EXTENSIONS.map((extension) => `.${extension}`).join(",");
}
