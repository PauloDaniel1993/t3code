import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act, createElement, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const { attachmentFilePreviewSpy } = vi.hoisted(() => ({
  attachmentFilePreviewSpy: vi.fn<(props: unknown) => void>(),
}));

vi.mock("./AttachmentFilePreview", () => ({
  AttachmentFilePreview: (props: unknown) => {
    attachmentFilePreviewSpy(props);
    return null;
  },
}));
vi.mock("../DiffWorkerPoolProvider", () => ({
  DiffWorkerPoolProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("~/hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("~/hooks/useSettings", () => ({
  useClientSettings: (select: (settings: { wordWrap: boolean }) => unknown) =>
    select({ wordWrap: false }),
  useUpdateClientSettings: () => vi.fn(),
}));
vi.mock("~/hooks/useLocalStorage", () => ({
  getLocalStorageItem: () => true,
  setLocalStorageItem: vi.fn(),
  useLocalStorage: (_key: string, initial: boolean) => [initial, vi.fn()],
}));
vi.mock("~/hooks/useWorkspaceMutationRefresh", () => ({
  useWorkspaceMutationRefresh: () => undefined,
}));
vi.mock("~/remoteOpen", () => ({
  useRemoteOpenState: () => ({ mode: "local-exec" }),
}));
vi.mock("~/state/environments", () => ({
  useEnvironmentHttpBaseUrl: () => null,
  usePrimaryEnvironmentId: () => null,
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("~/state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));
vi.mock("./projectFilesQueryState", () => ({
  getOptimisticProjectFileQueryData: () => null,
  setProjectFileQueryData: vi.fn(),
  useProjectFileQuery: () => ({ data: null, error: null, isPending: false, refresh: vi.fn() }),
}));

import FilePreviewPanel from "./FilePreviewPanel";
import {
  formatFileCommentRange,
  normalizeFileCommentRange,
  remapFileCommentAnnotations,
} from "./fileCommentAnnotations";
import {
  isMarkdownPreviewFile,
  setMarkdownTaskChecked,
  shouldShowFileExplorer,
} from "./filePreviewMode";

describe("attachment file preview", () => {
  let renderer: ReactTestRenderer | undefined;

  afterEach(async () => {
    attachmentFilePreviewSpy.mockClear();
    if (renderer) await act(() => renderer?.unmount());
    renderer = undefined;
  });

  it.each([
    ["notes.md", "text/markdown"],
    ["records.csv", "text/csv"],
    ["example.ts", "text/plain"],
  ])("routes %s through the scoped attachment file renderer", async (name, mimeType) => {
    const environmentId = EnvironmentId.make("attachment-environment");
    const threadId = ThreadId.make("thread-with-attachment");
    const threadRef = scopeThreadRef(environmentId, threadId);

    await act(async () => {
      renderer = create(
        createElement(FilePreviewPanel, {
          environmentId,
          cwd: "C:/workspace",
          projectName: "Workspace",
          relativePath: name,
          attachment: {
            type: "file",
            id: `attachment-${name}`,
            name,
            mimeType,
            sizeBytes: 123,
          },
          threadRef,
          composerDraftTarget: threadRef,
          keybindings: {} as never,
          availableEditors: [],
          revealLine: null,
          revealRequestId: 0,
          onOpenFile: vi.fn(),
          onPendingChange: vi.fn(),
          selectedFilePending: false,
          workspaceMutationId: null,
        }),
      );
    });

    expect(attachmentFilePreviewSpy).toHaveBeenCalledExactlyOnceWith({
      name,
      mimeType,
      sizeBytes: 123,
      asset: {
        environmentId,
        attachmentId: `attachment-${name}`,
        threadId,
      },
    });
  });
});

describe("file comment annotations", () => {
  it("normalizes and formats selected line ranges", () => {
    expect(normalizeFileCommentRange({ start: 16, end: 7 })).toEqual({
      startLine: 7,
      endLine: 16,
    });
    expect(formatFileCommentRange(7, 7)).toBe("L7");
    expect(formatFileCommentRange(7, 16)).toBe("L7 to L16");
  });

  it("keeps an annotation range attached when Pierre remaps its anchor line", () => {
    expect(
      remapFileCommentAnnotations([
        {
          lineNumber: 20,
          metadata: {
            entries: [
              {
                id: "comment-1",
                kind: "comment",
                startLine: 7,
                endLine: 16,
                text: "Keep this guarded.",
              },
            ],
          },
        },
      ]),
    ).toEqual([
      {
        lineNumber: 20,
        metadata: {
          entries: [
            {
              id: "comment-1",
              kind: "comment",
              startLine: 11,
              endLine: 20,
              text: "Keep this guarded.",
            },
          ],
        },
      },
    ]);
  });
});

describe("isMarkdownPreviewFile", () => {
  it("recognizes markdown and MDX files case-insensitively", () => {
    expect(isMarkdownPreviewFile("README.md")).toBe(true);
    expect(isMarkdownPreviewFile("docs/guide.MDX")).toBe(true);
  });

  it("does not treat other text files as markdown", () => {
    expect(isMarkdownPreviewFile("docs/guide.txt")).toBe(false);
    expect(isMarkdownPreviewFile("docs/markdown.ts")).toBe(false);
  });
});

describe("shouldShowFileExplorer", () => {
  it("hides the workspace tree for host files and attachments", () => {
    expect(
      shouldShowFileExplorer({
        relativePath: "/tmp/report.pdf",
        explorerOpen: true,
        attachmentOpen: false,
      }),
    ).toBe(false);
    expect(
      shouldShowFileExplorer({
        relativePath: "report.pdf",
        explorerOpen: true,
        attachmentOpen: true,
      }),
    ).toBe(false);
  });

  it("keeps the saved explorer preference for workspace files", () => {
    expect(
      shouldShowFileExplorer({
        relativePath: "docs/report.pdf",
        explorerOpen: true,
        attachmentOpen: false,
      }),
    ).toBe(true);
    expect(
      shouldShowFileExplorer({
        relativePath: "docs/report.pdf",
        explorerOpen: false,
        attachmentOpen: false,
      }),
    ).toBe(false);
  });
});

describe("setMarkdownTaskChecked", () => {
  const markdown = "- [ ] First\n- [x] Second\n";

  it("checks and unchecks the task marker at the supplied offset", () => {
    expect(setMarkdownTaskChecked(markdown, 2, true)).toBe("- [x] First\n- [x] Second\n");
    expect(setMarkdownTaskChecked(markdown, 14, false)).toBe("- [ ] First\n- [ ] Second\n");
    expect(setMarkdownTaskChecked("1. [X] Ordered\n", 3, false)).toBe("1. [ ] Ordered\n");
  });

  it("leaves the document unchanged for a stale or invalid marker offset", () => {
    expect(setMarkdownTaskChecked(markdown, 0, true)).toBe(markdown);
    expect(setMarkdownTaskChecked(markdown, 200, true)).toBe(markdown);
  });
});
