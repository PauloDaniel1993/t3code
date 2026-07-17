// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

type AttachmentPathPlatform = Pick<
  typeof NodePath.posix,
  "isAbsolute" | "join" | "normalize" | "resolve" | "sep"
>;

function hasUnsafeRelativeSegment(rawRelativePath: string): boolean {
  return rawRelativePath.split(/[\\/]/).some((segment) => segment === "..");
}

export function normalizeAttachmentRelativePathForPlatform(
  pathApi: AttachmentPathPlatform,
  rawRelativePath: string,
): string | null {
  if (
    rawRelativePath.length === 0 ||
    rawRelativePath.includes("\0") ||
    rawRelativePath.startsWith("/") ||
    rawRelativePath.startsWith("\\") ||
    /^[a-z]:[\\/]/i.test(rawRelativePath) ||
    pathApi.isAbsolute(rawRelativePath) ||
    hasUnsafeRelativeSegment(rawRelativePath)
  ) {
    return null;
  }

  const normalized = pathApi.normalize(rawRelativePath);
  if (normalized.length === 0 || normalized === "." || normalized.startsWith("..")) {
    return null;
  }
  return normalized.replace(/\\/g, "/");
}

export function normalizeAttachmentRelativePath(rawRelativePath: string): string | null {
  return normalizeAttachmentRelativePathForPlatform(NodePath, rawRelativePath);
}

export function resolveAttachmentRelativePathForPlatform(
  pathApi: AttachmentPathPlatform,
  input: {
    readonly attachmentsDir: string;
    readonly relativePath: string;
  },
): string | null {
  const normalizedRelativePath = normalizeAttachmentRelativePathForPlatform(
    pathApi,
    input.relativePath,
  );
  if (!normalizedRelativePath) {
    return null;
  }

  const attachmentsRoot = pathApi.resolve(input.attachmentsDir);
  const filePath = pathApi.resolve(pathApi.join(attachmentsRoot, normalizedRelativePath));
  const rootPrefix = attachmentsRoot.endsWith(pathApi.sep)
    ? attachmentsRoot
    : `${attachmentsRoot}${pathApi.sep}`;
  const caseInsensitive = pathApi.sep === "\\";
  const comparableRootPrefix = caseInsensitive ? rootPrefix.toLowerCase() : rootPrefix;
  const comparableFilePath = caseInsensitive ? filePath.toLowerCase() : filePath;
  if (!comparableFilePath.startsWith(comparableRootPrefix)) {
    return null;
  }
  return filePath;
}

export function resolveAttachmentRelativePath(input: {
  readonly attachmentsDir: string;
  readonly relativePath: string;
}): string | null {
  return resolveAttachmentRelativePathForPlatform(NodePath, input);
}
