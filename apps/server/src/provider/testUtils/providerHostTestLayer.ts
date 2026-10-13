import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as ServerConfig from "../../config.ts";
import { resolveAttachmentPath } from "../../attachmentStore.ts";

export const layer = Layer.effect(
  ProviderHost.ProviderHost,
  Effect.gen(function* () {
    const host = yield* ProviderHost.ProviderHost;
    const config = yield* ServerConfig.ServerConfig;
    return ProviderHost.ProviderHost.of({
      ...host,
      paths: {
        cwd: config.cwd,
        baseDir: config.baseDir,
        stateDir: config.stateDir,
        providerStatusCacheDir: config.providerStatusCacheDir,
        attachmentsDir: config.attachmentsDir,
      },
      resolveAttachmentPath: (attachment) =>
        resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment }),
    });
  }),
).pipe(Layer.provide(TestProviderHost.layer({ runBackgroundWork: false })));
