import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@t3tools/contracts";
import { PROJECT_FAVICON_FALLBACK_MARKER } from "@t3tools/shared/projectFavicon";
import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import { base64UrlDecodeUtf8, base64UrlEncode } from "../auth/utils.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { ASSET_ROUTE_PREFIX, issueAssetUrl, resolveAsset } from "./AssetAccess.ts";

const configLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-asset-access-test-",
});
const testLayer = Layer.mergeAll(
  configLayer,
  WorkspacePaths.layer,
  ProjectFaviconResolver.layer.pipe(
    Layer.provide(WorkspacePaths.layer),
    Layer.provide(T3ProjectFileLoader.layer),
  ),
  ServerSecretStore.layer.pipe(Layer.provide(configLayer)),
).pipe(Layer.provideMerge(NodeServices.layer));
const decodeUnknownJson = Schema.decodeUnknownSync(Schema.UnknownFromJsonString);
const encodeUnknownJson = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);

describe("AssetAccess", () => {
  it.effect("issues workspace URLs that resolve the entry file and sibling assets", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-workspace-",
      });
      const htmlPath = path.join(root, "report.html");
      const cssPath = path.join(root, "report.css");
      yield* fileSystem.writeFileString(htmlPath, '<link rel="stylesheet" href="report.css">');
      yield* fileSystem.writeFileString(cssPath, "body { color: red; }");
      yield* fileSystem.writeFileString(path.join(root, ".env"), "SECRET=value");
      const canonicalHtmlPath = yield* fileSystem.realPath(htmlPath);
      const canonicalCssPath = yield* fileSystem.realPath(cssPath);

      const result = yield* issueAssetUrl({
        resource: {
          _tag: "workspace-file",
          threadId: ThreadId.make("thread-1"),
          path: htmlPath,
        },
        workspaceRoot: root,
      });
      const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const separatorIndex = suffix.indexOf("/");
      const token = suffix.slice(0, separatorIndex);

      expect(yield* resolveAsset(token, "report.html")).toEqual({
        kind: "file",
        path: canonicalHtmlPath,
      });
      expect(yield* resolveAsset(token, "report.css")).toEqual({
        kind: "file",
        path: canonicalCssPath,
      });
      expect(yield* resolveAsset(token, "../secret.txt")).toBeNull();
      expect(yield* resolveAsset(token, ".env")).toBeNull();
      expect(yield* resolveAsset(`${token}tampered`, "report.html")).toBeNull();
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects workspace files outside the authorized root", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-root-",
      });
      const outside = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-outside-",
      });
      const htmlPath = path.join(outside, "report.html");
      yield* fileSystem.writeFileString(htmlPath, "<p>outside</p>");

      const error = yield* issueAssetUrl({
        resource: {
          _tag: "workspace-file",
          threadId: ThreadId.make("thread-1"),
          path: htmlPath,
        },
        workspaceRoot: root,
      }).pipe(Effect.flip);
      expect(error.message).toBe("Workspace file path must be relative to the project root.");
      expect(error).toMatchObject({
        _tag: "AssetWorkspacePathValidationError",
        resource: {
          _tag: "workspace-file",
          threadId: "thread-1",
          path: htmlPath,
        },
      });
      expect(error.cause).toBeInstanceOf(WorkspacePaths.WorkspacePathOutsideRootError);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("preserves non-missing canonical path failures when issuing asset URLs", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-permission-root-",
      });
      const htmlPath = path.join(root, "report.html");
      yield* fileSystem.writeFileString(htmlPath, "<p>report</p>");
      const cause = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "realPath",
        pathOrDescriptor: htmlPath,
      });
      const failingFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        realPath: () => Effect.fail(cause),
      });

      const error = yield* issueAssetUrl({
        resource: {
          _tag: "workspace-file",
          threadId: ThreadId.make("thread-1"),
          path: htmlPath,
        },
        workspaceRoot: root,
      }).pipe(Effect.provideService(FileSystem.FileSystem, failingFileSystem), Effect.flip);

      expect(error.message).toBe("Failed to inspect the workspace asset.");
      expect(error).toMatchObject({
        _tag: "AssetWorkspaceAssetInspectionError",
        resource: {
          _tag: "workspace-file",
          threadId: "thread-1",
          path: htmlPath,
        },
      });
      expect(error.cause).toBe(cause);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("issues exact workspace URLs for image previews", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-image-workspace-",
      });
      const assetsDirectory = path.join(root, "assets");
      const imagePath = path.join(assetsDirectory, "icon.png");
      const siblingPath = path.join(assetsDirectory, "other.png");
      yield* fileSystem.makeDirectory(assetsDirectory, { recursive: true });
      yield* fileSystem.writeFile(imagePath, new Uint8Array([137, 80, 78, 71]));
      yield* fileSystem.writeFile(siblingPath, new Uint8Array([137, 80, 78, 71]));
      const canonicalImagePath = yield* fileSystem.realPath(imagePath);

      const result = yield* issueAssetUrl({
        resource: {
          _tag: "workspace-file",
          threadId: ThreadId.make("thread-1"),
          path: imagePath,
        },
        workspaceRoot: root,
      });
      const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const separatorIndex = suffix.indexOf("/");
      const token = suffix.slice(0, separatorIndex);

      expect(yield* resolveAsset(token, "icon.png")).toEqual({
        kind: "file",
        path: canonicalImagePath,
      });
      expect(yield* resolveAsset(token, "other.png")).toBeNull();
      expect(yield* resolveAsset(token, "../icon.png")).toBeNull();
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("keeps pre-existing image-only attachment claims compatible", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const attachmentId = "thread-1-00000000-0000-4000-8000-000000000001";
      const attachmentPath = path.join(config.attachmentsDir, `${attachmentId}.png`);
      yield* fileSystem.makeDirectory(config.attachmentsDir, { recursive: true });
      yield* fileSystem.writeFile(attachmentPath, new Uint8Array([1, 2, 3]));

      const result = yield* issueAssetUrl({
        resource: { _tag: "attachment", attachmentId },
      });
      const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const separatorIndex = suffix.indexOf("/");
      const token = suffix.slice(0, separatorIndex);

      expect(yield* resolveAsset(token, "ignored.png")).toEqual({
        kind: "file",
        path: attachmentPath,
      });
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("issues typed PDF claims that resolve exact metadata-derived paths", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const attachmentId = "thread-1-00000000-0000-4000-8000-000000000011";
      const attachmentPath = path.join(config.attachmentsDir, `${attachmentId}.pdf`);
      yield* fileSystem.makeDirectory(config.attachmentsDir, { recursive: true });
      yield* fileSystem.writeFileString(attachmentPath, "%PDF-1.7");

      const result = yield* issueAssetUrl({
        resource: {
          _tag: "attachment",
          attachmentId,
          threadId: ThreadId.make("thread.1"),
          disposition: "inline-pdf",
        },
        attachmentContext: {
          threadId: "thread.1",
          dispositionMode: "inline-pdf",
          attachment: {
            type: "document",
            id: attachmentId,
            name: "Quarterly Résumé.pdf",
            mimeType: "application/pdf",
            sizeBytes: 8,
          },
        },
      });
      const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const separatorIndex = suffix.indexOf("/");
      const token = suffix.slice(0, separatorIndex);

      expect(yield* resolveAsset(token, suffix.slice(separatorIndex + 1))).toEqual({
        kind: "attachment",
        path: attachmentPath,
        attachmentKind: "document",
        dispositionMode: "inline-pdf",
        displayName: "Quarterly Résumé.pdf",
        contentType: "application/pdf",
      });

      yield* fileSystem.remove(attachmentPath);
      expect(yield* resolveAsset(token, "Quarterly%20R%C3%A9sum%C3%A9.pdf")).toBeNull();
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("issues and resolves attachment URLs with isolated surrogate filenames", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const attachmentId = "thread-1-00000000-0000-4000-8000-000000000015";
      const attachmentPath = path.join(config.attachmentsDir, `${attachmentId}.pdf`);
      const displayName = "report-\uD800.pdf";
      yield* fileSystem.makeDirectory(config.attachmentsDir, { recursive: true });
      yield* fileSystem.writeFileString(attachmentPath, "%PDF-1.7");

      const result = yield* issueAssetUrl({
        resource: { _tag: "attachment", attachmentId },
        attachmentContext: {
          threadId: "thread.1",
          dispositionMode: "download",
          attachment: {
            type: "document",
            id: attachmentId,
            name: displayName,
            mimeType: "application/pdf",
            sizeBytes: 8,
          },
        },
      });
      const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const separatorIndex = suffix.indexOf("/");

      expect(suffix.endsWith("/report-%EF%BF%BD.pdf")).toBe(true);
      expect(
        yield* resolveAsset(suffix.slice(0, separatorIndex), suffix.slice(separatorIndex + 1)),
      ).toEqual({
        kind: "attachment",
        path: attachmentPath,
        attachmentKind: "document",
        dispositionMode: "download",
        displayName,
        contentType: "application/pdf",
      });
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects expired typed attachment claims", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const attachmentId = "thread-1-00000000-0000-4000-8000-000000000012";
      const attachmentPath = path.join(config.attachmentsDir, `${attachmentId}.pdf`);
      yield* fileSystem.makeDirectory(config.attachmentsDir, { recursive: true });
      yield* fileSystem.writeFileString(attachmentPath, "%PDF-1.7");

      const result = yield* issueAssetUrl({
        resource: { _tag: "attachment", attachmentId },
        attachmentContext: {
          threadId: "thread.1",
          dispositionMode: "download",
          attachment: {
            type: "document",
            id: attachmentId,
            name: "report.pdf",
            mimeType: "application/pdf",
            sizeBytes: 8,
          },
        },
      });
      const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const token = suffix.slice(0, suffix.indexOf("/"));
      yield* TestClock.adjust(Duration.hours(2));

      expect(yield* resolveAsset(token, "report.pdf")).toBeNull();
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("invalidates tampering of every new typed attachment claim field", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const attachmentId = "thread-1-00000000-0000-4000-8000-000000000013";
      const attachmentPath = path.join(config.attachmentsDir, `${attachmentId}.pdf`);
      yield* fileSystem.makeDirectory(config.attachmentsDir, { recursive: true });
      yield* fileSystem.writeFileString(attachmentPath, "%PDF-1.7");

      const result = yield* issueAssetUrl({
        resource: { _tag: "attachment", attachmentId },
        attachmentContext: {
          threadId: "thread.1",
          dispositionMode: "inline-pdf",
          attachment: {
            type: "document",
            id: attachmentId,
            name: "report.pdf",
            mimeType: "application/pdf",
            sizeBytes: 8,
          },
        },
      });
      const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const token = suffix.slice(0, suffix.indexOf("/"));
      const [encodedPayload, signature] = token.split(".");
      expect(encodedPayload).toBeTruthy();
      expect(signature).toBeTruthy();
      const decodedClaims = decodeUnknownJson(base64UrlDecodeUtf8(encodedPayload!));
      if (
        typeof decodedClaims !== "object" ||
        decodedClaims === null ||
        Array.isArray(decodedClaims)
      ) {
        return yield* Effect.die("Expected an object-shaped attachment claim.");
      }
      const claims = decodedClaims as Record<string, unknown>;
      const mutations: ReadonlyArray<readonly [string, unknown]> = [
        ["attachmentKind", "file"],
        ["dispositionMode", "download"],
        ["displayName", "renamed.pdf"],
        ["mimeType", "text/html"],
      ];

      for (const [field, value] of mutations) {
        const tamperedPayload = base64UrlEncode(encodeUnknownJson({ ...claims, [field]: value }));
        expect(yield* resolveAsset(`${tamperedPayload}.${signature}`, "report.pdf")).toBeNull();
      }
      expect(yield* resolveAsset("missing", "report.pdf")).toBeNull();
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects typed attachment issuance across thread ownership", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const attachmentId = "thread-2-00000000-0000-4000-8000-000000000014";
      yield* fileSystem.makeDirectory(config.attachmentsDir, { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(config.attachmentsDir, `${attachmentId}.pdf`),
        "%PDF-1.7",
      );

      const error = yield* issueAssetUrl({
        resource: { _tag: "attachment", attachmentId },
        attachmentContext: {
          threadId: "thread.1",
          dispositionMode: "download",
          attachment: {
            type: "document",
            id: attachmentId,
            name: "other.pdf",
            mimeType: "application/pdf",
            sizeBytes: 8,
          },
        },
      }).pipe(Effect.flip);

      expect(error._tag).toBe("AssetAttachmentNotFoundError");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("issues project favicon capabilities with a signed fallback", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-favicon-",
      });
      const faviconPath = path.join(root, "favicon.svg");
      yield* fileSystem.writeFileString(faviconPath, "<svg />");
      const canonicalFaviconPath = yield* fileSystem.realPath(faviconPath);

      const faviconResult = yield* issueAssetUrl({
        resource: { _tag: "project-favicon", cwd: root },
      });
      const faviconSuffix = faviconResult.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const faviconSeparatorIndex = faviconSuffix.indexOf("/");
      expect(
        yield* resolveAsset(
          faviconSuffix.slice(0, faviconSeparatorIndex),
          faviconSuffix.slice(faviconSeparatorIndex + 1),
        ),
      ).toEqual({ kind: "file", path: canonicalFaviconPath });

      yield* fileSystem.remove(faviconPath);
      const fallbackResult = yield* issueAssetUrl({
        resource: { _tag: "project-favicon", cwd: root },
      });
      expect(fallbackResult.relativeUrl.endsWith(`/${PROJECT_FAVICON_FALLBACK_MARKER}`)).toBe(true);
      const fallbackSuffix = fallbackResult.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const fallbackSeparatorIndex = fallbackSuffix.indexOf("/");
      expect(
        yield* resolveAsset(
          fallbackSuffix.slice(0, fallbackSeparatorIndex),
          fallbackSuffix.slice(fallbackSeparatorIndex + 1),
        ),
      ).toBeNull();
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("preserves structured project favicon resolution causes", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-favicon-error-",
      });
      const platformCause = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "stat",
      });
      const resolutionCause = new ProjectFaviconResolver.ProjectFaviconResolutionError({
        operation: "stat-candidate",
        workspaceRoot: root,
        relativePath: "favicon.svg",
        cause: platformCause,
      });
      const resolver = ProjectFaviconResolver.ProjectFaviconResolver.of({
        resolvePath: () => Effect.fail(resolutionCause),
      });

      const error = yield* issueAssetUrl({
        resource: { _tag: "project-favicon", cwd: root },
      }).pipe(
        Effect.provideService(ProjectFaviconResolver.ProjectFaviconResolver, resolver),
        Effect.flip,
      );

      expect(error.message).toBe("Failed to resolve project favicon.");
      expect(error._tag).toBe("AssetProjectFaviconResolutionError");
      expect(error.cause).toBe(resolutionCause);
    }).pipe(Effect.provide(testLayer)),
  );
});
