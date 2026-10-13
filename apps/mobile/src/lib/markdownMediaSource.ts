import { classifyMarkdownImageSource } from "@t3tools/client-runtime/markdown-images";
import {
  resolveMediaSource,
  type ResolveMediaSourceInput,
} from "@t3tools/client-runtime/media-source";
import type { WorkspaceScope, WorkspaceScopeFolder } from "@t3tools/contracts";
import {
  workspaceMarkdownResource,
  workspaceRelativeMarkdownPath,
} from "./workspaceMarkdownResource";

export type MobileMarkdownMediaInput = ResolveMediaSourceInput & {
  readonly scope?: WorkspaceScope | null;
  readonly folders?: ReadonlyArray<WorkspaceScopeFolder>;
  readonly documentPath?: string;
};

/** Resolves authored relative media within its document's folder before authorizing it. */
export function resolveMobileMarkdownMediaSource(href: string, input: MobileMarkdownMediaInput) {
  const media = resolveMediaSource(href, input);
  if (media === null || media.access === "direct") return media;
  if (input.scope && workspaceRelativeMarkdownPath(href) !== null) {
    const resource = workspaceMarkdownResource(
      input.scope,
      input.folders ?? [],
      href,
      input.documentPath,
    );
    return resource === null ? null : { ...media, access: "environment" as const, resource };
  }
  // A project draft names its workspace explicitly because it has no thread.
  if (media.access !== "unavailable" || !input.workspaceRoot) return media;
  const source = classifyMarkdownImageSource(href, input.workspaceRoot);
  if (source._tag !== "WorkspaceFile") return media;
  return {
    ...media,
    access: "environment" as const,
    resource: {
      _tag: "draft-workspace-file" as const,
      cwd: input.workspaceRoot,
      path: source.path,
    },
  };
}
