import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpClient, HttpRouter } from "effect/unstable/http";
import { describe } from "vite-plus/test";

import * as ServerConfig from "./config.ts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import { issueAssetUrl } from "./assets/AssetAccess.ts";
import * as ProjectFaviconResolver from "./project/ProjectFaviconResolver.ts";
import * as T3ProjectFileLoader from "./project/T3ProjectFileLoader.ts";
import {
  assetResponseHeaders,
  assetRouteLayer,
  attachmentContentDisposition,
  createAssetFileResponse,
  isLoopbackHostname,
  resolveDevRedirectUrl,
} from "./http.ts";
import * as WorkspacePaths from "./workspace/WorkspacePaths.ts";

const assetResponseLayer = Layer.mergeAll(NodeServices.layer, NodeHttpPlatform.layer);
const assetRouteConfigLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-http-route-",
});
const assetRouteServerLayer = HttpRouter.serve(assetRouteLayer, {
  disableListenLog: true,
  disableLogger: true,
}).pipe(
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(
    ProjectFaviconResolver.layer.pipe(
      Layer.provide(WorkspacePaths.layer),
      Layer.provide(T3ProjectFileLoader.layer),
    ),
  ),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(assetRouteConfigLayer),
);
const assetRouteTestLayer = assetRouteServerLayer.pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(NodeServices.layer),
);

describe("http dev routing", () => {
  it("treats localhost and loopback addresses as local", () => {
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("::1")).toBe(true);
    expect(isLoopbackHostname("[::1]")).toBe(true);
  });

  it("does not treat LAN addresses as local", () => {
    expect(isLoopbackHostname("192.168.86.35")).toBe(false);
    expect(isLoopbackHostname("10.0.0.24")).toBe(false);
    expect(isLoopbackHostname("example.local")).toBe(false);
  });

  it("preserves path and query when redirecting to the dev server", () => {
    const devUrl = new URL("http://127.0.0.1:5173/");
    const requestUrl = new URL("http://127.0.0.1:3774/pair?token=test-token");

    expect(resolveDevRedirectUrl(devUrl, requestUrl)).toBe(
      "http://127.0.0.1:5173/pair?token=test-token",
    );
  });
});

describe("attachment asset responses", () => {
  it("replaces isolated surrogates in Content-Disposition filenames", () => {
    expect(
      attachmentContentDisposition({
        kind: "attachment",
        path: "/tmp/attachment.pdf",
        attachmentKind: "document",
        dispositionMode: "download",
        displayName: "report-\uD800.pdf",
        contentType: "application/pdf",
      }),
    ).toBe("attachment; filename=\"report-_.pdf\"; filename*=UTF-8''report-%EF%BF%BD.pdf");
  });

  it.effect("forces active generic content to download with canonical MIME and nosniff", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-http-asset-" });
      const filePath = path.join(root, "attachment.html");
      yield* fileSystem.writeFileString(filePath, "<script>alert(1)</script>");

      const response = yield* createAssetFileResponse({
        kind: "attachment",
        path: filePath,
        attachmentKind: "file",
        dispositionMode: "inline-pdf",
        displayName: "résumé.html",
        contentType: "text/html",
      });

      expect(response.headers["content-type"]).toBe("text/html");
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["content-disposition"]).toContain("attachment;");
      expect(response.headers["content-disposition"]).toContain('filename="re_sume_.html"');
      expect(response.headers["content-disposition"]).toContain(
        "filename*=UTF-8''r%C3%A9sum%C3%A9.html",
      );
    }).pipe(Effect.provide(assetResponseLayer)),
  );

  it.effect("serves PDFs inline or as downloads according to the signed mode", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-http-pdf-" });
      const filePath = path.join(root, "attachment.pdf");
      yield* fileSystem.writeFileString(filePath, "%PDF-1.7");

      const inlineResponse = yield* createAssetFileResponse({
        kind: "attachment",
        path: filePath,
        attachmentKind: "document",
        dispositionMode: "inline-pdf",
        displayName: "report.pdf",
        contentType: "application/pdf",
      });
      const downloadResponse = yield* createAssetFileResponse({
        kind: "attachment",
        path: filePath,
        attachmentKind: "document",
        dispositionMode: "download",
        displayName: "report.pdf",
        contentType: "application/pdf",
      });

      expect(inlineResponse.headers["content-type"]).toBe("application/pdf");
      expect(inlineResponse.headers["content-disposition"]).toMatch(/^inline;/);
      expect(downloadResponse.headers["content-disposition"]).toMatch(/^attachment;/);
      expect(downloadResponse.headers["x-content-type-options"]).toBe("nosniff");
    }).pipe(Effect.provide(assetResponseLayer)),
  );

  it.effect("strips CRLF and path separators from attachment filenames", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-http-name-" });
      const filePath = path.join(root, "attachment.txt");
      yield* fileSystem.writeFileString(filePath, "safe");

      const response = yield* createAssetFileResponse({
        kind: "attachment",
        path: filePath,
        attachmentKind: "file",
        dispositionMode: "download",
        displayName: "../report\r\nX-Evil: injected.txt",
        contentType: "text/plain",
      });
      const disposition = response.headers["content-disposition"] ?? "";

      expect(disposition).not.toContain("\r");
      expect(disposition).not.toContain("\n");
      expect(disposition).not.toContain("../");
      expect(disposition).toContain(".._reportX-Evil: injected.txt");
    }).pipe(Effect.provide(assetResponseLayer)),
  );
});

describe("assetResponseHeaders", () => {
  it("sandboxes SVG assets", () => {
    expect(assetResponseHeaders("/attachments/user-image.svg")).toMatchObject({
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      "X-Content-Type-Options": "nosniff",
    });
    expect(assetResponseHeaders("/attachments/user-image.SVG")).toHaveProperty(
      "Content-Security-Policy",
    );
  });

  it("does not apply document policy to raster images", () => {
    expect(assetResponseHeaders("/attachments/user-image.png")).toEqual({
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    });
  });

  it("declares utf-8 for HTML assets so non-ASCII content renders correctly", () => {
    expect(assetResponseHeaders("/workspace/page.html")).toHaveProperty(
      "Content-Type",
      "text/html; charset=utf-8",
    );
    expect(assetResponseHeaders("/workspace/PAGE.HTM")).toHaveProperty(
      "Content-Type",
      "text/html; charset=utf-8",
    );
  });
});

describe("signed asset route", () => {
  it.effect("serves signed workspace SVG and HTML assets with upstream headers", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-http-route-assets-" });
        const svgPath = path.join(root, "diagram.svg");
        const htmlPath = path.join(root, "page.html");
        yield* fileSystem.writeFileString(svgPath, '<svg xmlns="http://www.w3.org/2000/svg" />');
        yield* fileSystem.writeFileString(htmlPath, "<p>héllo</p>");

        const svgUrl = yield* issueAssetUrl({
          resource: {
            _tag: "workspace-file",
            threadId: ThreadId.make("http-route-test"),
            path: svgPath,
          },
          workspaceRoot: root,
        });
        const htmlUrl = yield* issueAssetUrl({
          resource: {
            _tag: "workspace-file",
            threadId: ThreadId.make("http-route-test"),
            path: htmlPath,
          },
          workspaceRoot: root,
        });

        const svgResponse = yield* HttpClient.get(svgUrl.relativeUrl);
        const htmlResponse = yield* HttpClient.get(htmlUrl.relativeUrl);

        expect(svgResponse.status).toBe(200);
        expect(svgResponse.headers["content-security-policy"]).toBe(
          "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        );
        expect(yield* svgResponse.text).toContain("<svg");

        expect(htmlResponse.status).toBe(200);
        expect(htmlResponse.headers["content-type"]).toBe("text/html; charset=utf-8");
        expect(yield* htmlResponse.text).toBe("<p>héllo</p>");
      }),
    ).pipe(Effect.provide(assetRouteTestLayer)),
  );

  it.effect("keeps signed ordinary assets streaming with range requests", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-http-route-range-" });
        const imagePath = path.join(root, "image.png");
        yield* fileSystem.writeFile(imagePath, new Uint8Array([0, 1, 2, 3, 4]));

        const imageUrl = yield* issueAssetUrl({
          resource: {
            _tag: "workspace-file",
            threadId: ThreadId.make("http-route-test"),
            path: imagePath,
          },
          workspaceRoot: root,
        });
        const fullResponse = yield* HttpClient.get(imageUrl.relativeUrl);
        const rangeResponse = yield* HttpClient.get(imageUrl.relativeUrl, {
          headers: { range: "bytes=1-3" },
        });

        expect(fullResponse.status).toBe(200);
        expect(yield* fullResponse.arrayBuffer).toEqual(new Uint8Array([0, 1, 2, 3, 4]).buffer);
        expect(rangeResponse.status).toBe(200);
        expect(yield* rangeResponse.arrayBuffer).toEqual(new Uint8Array([0, 1, 2, 3, 4]).buffer);
      }),
    ).pipe(Effect.provide(assetRouteTestLayer)),
  );
});
