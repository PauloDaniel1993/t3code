import { resolveMediaSource } from "@t3tools/client-runtime/media-source";
import type {
  EnvironmentId,
  ThreadId,
  WorkspaceScope,
  WorkspaceScopeFolder,
} from "@t3tools/contracts";
import { normalizeNativeMarkdownUrl } from "@t3tools/mobile-markdown-text/links";

import type { FilePreviewSource } from "../components/FilePreviewModal";
import type { MediaVideoPreviewSource } from "./videoPreviewSource";
import type { MediaActionsSource } from "./mediaActions";
import {
  workspaceMarkdownResource,
  workspaceRelativeMarkdownPath,
} from "./workspaceMarkdownResource";

/** Resolves only explicit media references. Ordinary links keep their existing navigation. */
export function resolveMarkdownMediaPreview(
  href: string,
  input: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly workspaceRoot: string | null | undefined;
    readonly scope?: WorkspaceScope | null;
    readonly folders?: ReadonlyArray<WorkspaceScopeFolder>;
    /** Image syntax can target an endpoint without a recognizable extension. */
    readonly imageEmbed?: boolean;
  },
):
  | { readonly kind: "image"; readonly source: FilePreviewSource }
  | { readonly kind: "video"; readonly source: MediaVideoPreviewSource }
  | null {
  const media = resolveMediaSource(href, input);
  if (media === null || media.access === "unavailable") return null;
  const { kind, name, mimeType, srcFragment } = media;
  const scopedResource = workspaceMarkdownResource(input.scope ?? null, input.folders ?? [], href);
  if (input.scope && workspaceRelativeMarkdownPath(href) !== null && scopedResource === null)
    return null;
  const reference = media.reference;
  const resource = scopedResource ?? (media.access === "environment" ? media.resource : null);

  const target =
    media.access === "direct"
      ? { uri: normalizeNativeMarkdownUrl(media.uri) }
      : {
          environmentId: input.environmentId,
          resource: resource!,
          ...(srcFragment ? { srcFragment } : {}),
        };
  const actionsSource: MediaActionsSource =
    media.access === "direct"
      ? { reference, uri: media.uri, name, mimeType }
      : {
          reference,
          environmentId: input.environmentId,
          threadId: input.threadId,
          resource: resource!,
          name,
          mimeType,
        };
  return kind === "video"
    ? { kind, source: { type: "media", name, mimeType, ...target, actionsSource } }
    : { kind, source: { kind, name, ...target, actionsSource } };
}
