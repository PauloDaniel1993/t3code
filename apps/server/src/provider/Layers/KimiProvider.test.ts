import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import {
  KimiSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";

import { makeKimiModelState } from "../KimiModelState.ts";
import { makeProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import {
  buildInitialKimiProviderSnapshot,
  checkKimiProviderStatus,
  enrichKimiSnapshot,
  isKimiAcpCompatible,
} from "./KimiProvider.ts";

const decodeKimiSettings = Schema.decodeSync(KimiSettings);
const compatibleProbe = {
  initializeResult: {
    protocolVersion: 1,
    agentCapabilities: { sessionCapabilities: { resume: {} } },
    authMethods: [],
  },
  agentCapabilities: { sessionCapabilities: { resume: {} } },
} as const;

describe("buildInitialKimiProviderSnapshot", () => {
  it.effect("is disabled by default and seeds kimi-default", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialKimiProviderSnapshot(decodeKimiSettings({}));
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.models.map((model) => model.slug)).toEqual(["kimi-default"]);
    }),
  );
});

describe("enrichKimiSnapshot", () => {
  it.effect("merges version enrichment into the latest model snapshot", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const driver = ProviderDriverKind.make("kimi");
        const modelState = yield* makeKimiModelState([]);
        const advisoryPublished = yield* Deferred.make<void>();
        const initial: ServerProvider = {
          instanceId: ProviderInstanceId.make("kimi"),
          driver,
          enabled: true,
          installed: true,
          version: "1.0.0",
          status: "ready",
          auth: { status: "authenticated" },
          checkedAt: "2026-08-07T00:00:00.000Z",
          models: (yield* modelState.getSnapshot).models,
          slashCommands: [],
          skills: [],
        };
        yield* modelState.publishConfigOptions([
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: "composer-2",
            options: [{ value: "composer-2", name: "Composer 2" }],
          },
        ] satisfies ReadonlyArray<EffectAcpSchema.SessionConfigOption>);
        const snapshotRef = yield* Ref.make<ServerProvider>({
          ...initial,
          models: (yield* modelState.getSnapshot).models,
        });
        const publishSnapshot = (snapshot: ServerProvider) =>
          Effect.gen(function* () {
            yield* Ref.set(snapshotRef, snapshot);
            if (snapshot.versionAdvisory !== undefined) {
              yield* Deferred.succeed(advisoryPublished, undefined);
            }
          });

        yield* enrichKimiSnapshot({
          snapshot: initial,
          modelState,
          maintenanceCapabilities: makeProviderMaintenanceCapabilities({
            provider: driver,
            packageName: "@t3tools/kimi-enrichment-race-test",
            updateExecutable: null,
            updateArgs: [],
            updateLockKey: null,
          }),
          enableProviderUpdateChecks: false,
          getSnapshot: Ref.get(snapshotRef),
          publishSnapshot,
          httpClient: HttpClient.make(() =>
            Effect.die("disabled Kimi update checks must not make an HTTP request"),
          ),
        }).pipe(Effect.forkScoped);

        yield* Deferred.await(advisoryPublished);

        const current = yield* Ref.get(snapshotRef);
        expect(current.models.map((model) => model.slug)).toContain("composer-2");
        expect(current.versionAdvisory?.currentVersion).toBe("1.0.0");
      }),
    ),
  );
});

it.layer(NodeServices.layer)("checkKimiProviderStatus", (it) => {
  const readySettings = decodeKimiSettings({ enabled: true, binaryPath: "kimi" });
  const version = () => Effect.succeed({ stdout: "kimi-code 1.2.3\n", stderr: "", code: 0 });

  it.effect("reports ready after version, initialize, and existing-login authentication", () =>
    Effect.gen(function* () {
      let probeCalls = 0;
      const snapshot = yield* checkKimiProviderStatus(readySettings, {}, undefined, {
        runVersion: version,
        probeAcp: () =>
          Effect.sync(() => {
            probeCalls += 1;
            return compatibleProbe;
          }),
      });
      expect(snapshot.status).toBe("ready");
      expect(snapshot.version).toBe("1.2.3");
      expect(snapshot.auth.status).toBe("authenticated");
      expect(probeCalls).toBe(1);
    }),
  );

  it.effect("maps ACP auth-required without initiating login", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkKimiProviderStatus(readySettings, {}, undefined, {
        runVersion: version,
        probeAcp: () => Effect.fail(EffectAcpErrors.AcpRequestError.authRequired()),
      });
      expect(snapshot.status).toBe("error");
      expect(snapshot.auth.status).toBe("unauthenticated");
      expect(snapshot.message).toContain("kimi login");
    }),
  );

  it.effect("distinguishes an incompatible ACP runtime", () =>
    Effect.gen(function* () {
      const incompatible = {
        ...compatibleProbe,
        initializeResult: {
          ...compatibleProbe.initializeResult,
          agentCapabilities: {},
        },
        agentCapabilities: {},
      };
      expect(isKimiAcpCompatible(incompatible)).toBe(false);
      const snapshot = yield* checkKimiProviderStatus(readySettings, {}, undefined, {
        runVersion: version,
        probeAcp: () => Effect.succeed(incompatible),
      });
      expect(snapshot.status).toBe("error");
      expect(snapshot.auth.status).toBe("authenticated");
      expect(snapshot.message).toContain("session resume");
    }),
  );

  it.effect("redacts non-zero version probe output from the snapshot", () =>
    Effect.gen(function* () {
      const secret = "oauth-secret-value";
      const snapshot = yield* checkKimiProviderStatus(readySettings, {}, undefined, {
        runVersion: () => Effect.succeed({ stdout: "", stderr: secret, code: 2 }),
        probeAcp: () => Effect.die("must not probe ACP"),
      });
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).not.toContain(secret);
    }),
  );
});
