import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as EffectAcpErrors from "effect-acp/errors";
import { KimiSettings } from "@t3tools/contracts";

import {
  buildInitialKimiProviderSnapshot,
  checkKimiProviderStatus,
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
