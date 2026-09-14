import { EnvironmentId, ThreadId, type AssetResource } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { AttachmentFilePreview } from "./AttachmentFilePreview";

const { refresh, useAssetUrlRefresh } = vi.hoisted(() => {
  const refresh = vi.fn<() => Promise<string | null>>();
  const useAssetUrlRefresh = vi.fn<
    (environmentId: EnvironmentId | null, resource: AssetResource | null) => typeof refresh
  >(() => refresh);
  return { refresh, useAssetUrlRefresh };
});

vi.mock("~/assets/assetUrls", () => ({ useAssetUrlRefresh }));
vi.mock("~/hooks/useCopyToClipboard", () => ({
  useCopyToClipboard: () => ({ copyToClipboard: vi.fn(), isCopied: false }),
}));
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("~/components/ChatMarkdown", () => ({ default: () => null }));
vi.mock("~/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./ReadOnlySourcePreview", () => ({
  default: ({ text }: { text: string }) => <pre>{text}</pre>,
}));
vi.mock("./fileSurfaceChrome", () => ({
  FILE_SURFACE_SUBHEADER_CLASS: "",
  FileSurfaceAction: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button aria-label={label} onClick={onPress} />
  ),
  FileSurfaceFailure: ({ message }: { message: string }) => <div role="alert">{message}</div>,
  FileSurfaceLoading: () => <div role="status">Loading</div>,
  FileSurfaceNotice: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

describe("attachment HTML preview recovery", () => {
  const originalUrl = "https://environment.test/original.html";
  const renewedUrl = "https://environment.test/renewed.html";
  let now = 0;
  let renderer: ReactTestRenderer;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    refresh.mockReset().mockResolvedValueOnce(originalUrl).mockResolvedValue(renewedUrl);
    useAssetUrlRefresh.mockClear();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<p>Captured HTML</p>")),
    );
  });

  afterEach(async () => {
    if (renderer) await act(() => renderer.unmount());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const openRemote = async () => {
    await act(async () => {
      renderer = create(
        <AttachmentFilePreview
          name="document.html"
          mimeType="text/html"
          sizeBytes={100}
          asset={{
            environmentId: EnvironmentId.make("test-environment"),
            attachmentId: "html",
            threadId: ThreadId.make("thread-1"),
          }}
        />,
      );
    });
  };

  const toggleMode = async (label: string) => {
    await act(async () => {
      renderer.root.findByProps({ "aria-label": label }).props.onClick();
    });
  };

  it("keeps a renewed URL for subsequent rendered and source views", async () => {
    await openRemote();
    now = 61 * 60_000;
    await toggleMode("Show HTML source");
    expect(fetch).toHaveBeenCalledExactlyOnceWith(renewedUrl, expect.any(Object));

    await toggleMode("Show rendered page");
    expect(renderer.root.findByType("iframe").props.src).toBe(renewedUrl);
    await toggleMode("Show HTML source");
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual([renewedUrl, renewedUrl]);
  });

  it("does not fetch or mark an expired URL fresh when reauthorization is unavailable", async () => {
    await openRemote();
    now = 61 * 60_000;
    refresh.mockResolvedValue(null);
    await toggleMode("Show HTML source");
    expect(fetch).not.toHaveBeenCalled();
    expect(renderer.root.findByProps({ role: "alert" }).children).toEqual([
      "Reconnect to the environment and try again.",
    ]);

    await toggleMode("Show rendered page");
    await toggleMode("Show HTML source");
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("can return to rendered HTML after local source decoding fails", async () => {
    const bytes = new Uint8Array([0x3c, 0x70, 0x3e, 0xe9]);
    const file = new Blob([bytes], { type: "text/html" });
    vi.spyOn(file, "stream").mockImplementation(
      () =>
        new ReadableStream({
          start: (controller) => {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
    );
    await act(async () => {
      renderer = create(
        <AttachmentFilePreview
          name="document.html"
          mimeType="text/html"
          sizeBytes={file.size}
          file={file}
        />,
      );
    });
    await toggleMode("Show HTML source");
    expect(renderer.root.findByProps({ role: "alert" }).children.join("")).toContain("not UTF-8");

    await toggleMode("Show rendered page");
    expect(renderer.root.findAllByProps({ role: "alert" })).toHaveLength(0);
    expect(renderer.root.findByType("iframe").props.title).toBe("document.html");
  });
});

describe("attachment ownership scope", () => {
  let renderer: ReactTestRenderer;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    refresh.mockReset().mockResolvedValue("https://environment.test/document.pdf");
    useAssetUrlRefresh.mockClear();
  });

  afterEach(async () => {
    if (renderer) await act(() => renderer.unmount());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("leaves a hydrated pending draft file unscoped", async () => {
    const environmentId = EnvironmentId.make("test-environment");
    const threadId = ThreadId.make("thread-1");
    await act(async () => {
      renderer = create(
        <AttachmentFilePreview
          name="report.pdf"
          mimeType="application/pdf"
          sizeBytes={100}
          asset={{
            environmentId,
            attachmentId: "pending-00000000-0000-0000-0000-000000000001-pdf",
            threadId,
          }}
        />,
      );
    });

    expect(useAssetUrlRefresh).toHaveBeenNthCalledWith(1, environmentId, {
      _tag: "attachment",
      attachmentId: "pending-00000000-0000-0000-0000-000000000001-pdf",
      fileName: "report.pdf",
      mimeType: "application/pdf",
      disposition: "inline",
    });
    expect(useAssetUrlRefresh.mock.calls[0]?.[1]).not.toHaveProperty("threadId");
  });

  it("keeps a claimed attachment scoped to its owning thread", async () => {
    const environmentId = EnvironmentId.make("test-environment");
    const threadId = ThreadId.make("thread-1");
    await act(async () => {
      renderer = create(
        <AttachmentFilePreview
          name="report.pdf"
          mimeType="application/pdf"
          sizeBytes={100}
          asset={{
            environmentId,
            attachmentId: "thread-1-00000000-0000-0000-0000-000000000001-pdf",
            threadId,
          }}
        />,
      );
    });

    expect(useAssetUrlRefresh).toHaveBeenNthCalledWith(1, environmentId, {
      _tag: "attachment",
      attachmentId: "thread-1-00000000-0000-0000-0000-000000000001-pdf",
      threadId,
      fileName: "report.pdf",
      mimeType: "application/pdf",
      disposition: "inline",
    });
  });
});
