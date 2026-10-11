import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, WorkspaceScope } from "@t3tools/contracts";
import {
  isWorkspaceBrowserPreviewPath,
  isWorkspaceImagePreviewPath,
} from "@t3tools/shared/filePreview";

import { appAtomRegistry } from "../../state/atom-registry";
import { projectEnvironment } from "../../state/projects";
import { isVideoPreviewFile } from "./filePath";
import { prepareSourceFileDocument } from "./source-file-document";
import { sourceHighlightAtom } from "./sourceHighlightingState";
import type { ReviewDiffTheme } from "../review/shikiReviewHighlighter";
import { workspaceFileCacheKey, workspaceFileReadInput } from "../../lib/workspaceFiles";
import { workspaceFileBindingAtom } from "../../state/workspace-file-bindings";

const inFlightPreloads = new Map<string, Promise<void>>();
const MAX_HIGHLIGHT_PRELOAD_CHARACTERS = 256 * 1024;

export function preloadWorkspaceFileContents(input: {
  readonly cwd: string;
  readonly environmentId: EnvironmentId;
  readonly scope?: WorkspaceScope | null;
  readonly relativePath: string;
  readonly theme: ReviewDiffTheme;
}): void {
  if (
    isWorkspaceBrowserPreviewPath(input.relativePath) ||
    isWorkspaceImagePreviewPath(input.relativePath) ||
    isVideoPreviewFile(input.relativePath)
  ) {
    return;
  }

  const bindingKey = appAtomRegistry.get(
    workspaceFileBindingAtom(input.environmentId, input.scope ?? null),
  );
  const key = `${workspaceFileCacheKey(input)}:${bindingKey}`;
  if (inFlightPreloads.has(key)) {
    return;
  }

  const preload = executeAtomQuery(
    appAtomRegistry,
    projectEnvironment.readFile({
      environmentId: input.environmentId,
      input: workspaceFileReadInput(input.cwd, input.relativePath, input.scope ?? null),
    }),
    {
      label: "workspace file preload",
      reportDefect: false,
      reportFailure: false,
    },
  )
    .then(async (result) => {
      if (result._tag === "Success") {
        const document = prepareSourceFileDocument(result.value.contents);
        if (document.contents.length <= MAX_HIGHLIGHT_PRELOAD_CHARACTERS) {
          await executeAtomQuery(
            appAtomRegistry,
            sourceHighlightAtom({
              path: input.relativePath,
              contents: document.contents,
              theme: input.theme,
            }),
            {
              label: "workspace source highlight preload",
              reportDefect: false,
              reportFailure: false,
            },
          );
        }
      }
    })
    .finally(() => {
      inFlightPreloads.delete(key);
    });

  inFlightPreloads.set(key, preload);
}
