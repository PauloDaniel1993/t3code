import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { KimiSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as AcpErrors from "effect-acp/errors";
import { buildInitialKimiProviderSnapshot, checkKimiProviderStatus } from "./KimiProvider.ts";

const config = Schema.decodeSync(KimiSettings)({ enabled: true });
const disabledConfig = Schema.decodeSync(KimiSettings)({});
const version = () => Effect.succeed({ stdout: "Kimi Code CLI 0.29.0", stderr: "", code: 0 });

it.layer(NodeServices.layer)("Kimi status", (it) => {
  it.effect("keeps the disabled default and early-access model presentation", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialKimiProviderSnapshot(disabledConfig);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.models[0]?.slug).toBe("kimi-default");
      expect(snapshot.badgeLabel).toBe("Early Access");
    }),
  );
  it.effect("requires ACP protocol 1 and native resume or load support", () =>
    Effect.gen(function* () {
      for (const probe of [
        { protocolVersion: 1, agentCapabilities: { loadSession: true } },
        { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} } } },
      ]) {
        expect(
          (yield* checkKimiProviderStatus(config, {}, undefined, {
            runVersion: version,
            probeAcp: () => Effect.succeed(probe),
          })).status,
        ).toBe("ready");
      }
      expect(
        (yield* checkKimiProviderStatus(config, {}, undefined, {
          runVersion: version,
          probeAcp: () => Effect.succeed({ protocolVersion: 1, agentCapabilities: {} }),
        })).status,
      ).toBe("error");
    }),
  );
  it.effect("reports missing login with the same Kimi home guidance", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkKimiProviderStatus(config, {}, undefined, {
        runVersion: version,
        probeAcp: () => Effect.fail(AcpErrors.AcpRequestError.authRequired()),
      });
      expect(snapshot.auth.status).toBe("unauthenticated");
      expect(snapshot.message).toContain("same `KIMI_CODE_HOME`");
    }),
  );
});
