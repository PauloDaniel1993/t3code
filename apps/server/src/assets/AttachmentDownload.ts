function normalizeAttachmentDownloadName(value: string): string | null {
  const normalized = value.trim();
  if (normalized.length === 0) return null;
  return normalized
    .replaceAll(String.fromCharCode(0), "_")
    .replace(/[\\/\r\n]/g, "_")
    .slice(0, 255);
}

export function decodeAttachmentDownloadName(value: string): string | null {
  try {
    return normalizeAttachmentDownloadName(decodeURIComponent(value));
  } catch {
    return null;
  }
}

function encodeRfc5987Value(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function attachmentContentDisposition(fileName: string): string {
  const normalized = normalizeAttachmentDownloadName(fileName) ?? "attachment.pdf";
  const asciiFallback = normalized.replace(/[^\x20-\x7e]/g, "_").replace(/["\\;]/g, "_");
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeRfc5987Value(normalized)}`;
}
