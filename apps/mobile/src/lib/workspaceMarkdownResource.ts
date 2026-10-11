import {
  normalizeMarkdownLinkDestination,
  parseMarkdownFileLink,
  safeDecodeURIComponent,
  splitMarkdownLinkSearchAndHash,
} from "@t3tools/client-runtime/markdown-links";
import type { WorkspaceScope, WorkspaceScopeFolder } from "@t3tools/contracts";
import { parseCanonicalPath, toCanonicalPath } from "@t3tools/shared/workspaceFolders";

import { isWindowsAbsolutePath } from "@t3tools/shared/path";
import { pinWorkspaceFileScope, scopedWorkspaceFileResource } from "./workspaceFiles";

export function workspaceRelativeMarkdownPath(href: string) {
  const normalized = normalizeMarkdownLinkDestination(href);
  if (!normalized || /^[#?]/.test(normalized) || normalized.startsWith("//")) return null;
  const path =
    parseMarkdownFileLink(normalized)?.path ??
    safeDecodeURIComponent(splitMarkdownLinkSearchAndHash(normalized).path);
  if (
    path.startsWith("/") ||
    isWindowsAbsolutePath(path) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(path) ||
    path.startsWith("~/")
  )
    return null;
  return path;
}

/** Relative media stays at its document (or primary); a labeled reference addresses that folder. */
export function workspaceMarkdownResource(
  scope: WorkspaceScope | null,
  folders: ReadonlyArray<WorkspaceScopeFolder>,
  href: string,
  documentPath?: string,
) {
  if (scope === null || folders.length === 0) return null;
  const path = workspaceRelativeMarkdownPath(href);
  if (path === null) return null;
  const explicit = folders.length > 1 ? parseCanonicalPath(path, folders) : null;
  const document = documentPath === undefined ? null : parseCanonicalPath(documentPath, folders);
  if (documentPath !== undefined && document === null) return null;
  const folder = explicit?.folder ?? document?.folder ?? folders[0]!;
  const base = explicit
    ? ""
    : (document?.relativePath.slice(0, Math.max(0, document.relativePath.lastIndexOf("/"))) ?? "");
  const segments: string[] = [];
  for (const segment of `${base}/${explicit?.relativePath ?? path}`.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  const canonicalPath = toCanonicalPath(folder, segments.join("/"), folders.length);
  return scopedWorkspaceFileResource(
    pinWorkspaceFileScope(scope, canonicalPath, folders),
    canonicalPath,
  );
}
