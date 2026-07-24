import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import {
  KIMI_CODE_HOME_ENV,
  KIMI_CODE_NO_AUTO_UPDATE_ENV,
  makeKimiEnvironment,
  resolveKimiHomePath,
} from "./KimiHome.ts";

it.layer(NodeServices.layer)("KimiHome", (it) => {
  describe("Kimi process environment", () => {
    it.effect("preserves an instance environment and disables automatic updates", () =>
      Effect.gen(function* () {
        const baseEnv = {
          PATH: "/custom/bin",
          KIMI_CODE_HOME: "/environment/home",
          KIMI_CODE_NO_AUTO_UPDATE: "0",
          INSTANCE_SECRET: "preserved",
        };

        const environment = yield* makeKimiEnvironment({ homePath: "" }, baseEnv);

        expect(environment).toEqual({
          ...baseEnv,
          KIMI_CODE_NO_AUTO_UPDATE: "1",
        });
        expect(environment[KIMI_CODE_HOME_ENV]).toBe("/environment/home");
        expect(environment[KIMI_CODE_NO_AUTO_UPDATE_ENV]).toBe("1");
      }),
    );

    it.effect("resolves and prioritizes an explicit Kimi Code home", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resolved = path.resolve(NodeOS.homedir(), ".kimi-work");
        const environment = yield* makeKimiEnvironment(
          { homePath: "~/.kimi-work" },
          { KIMI_CODE_HOME: "/environment/home" },
        );

        expect(yield* resolveKimiHomePath({ homePath: "~/.kimi-work" })).toBe(resolved);
        expect(environment[KIMI_CODE_HOME_ENV]).toBe(resolved);
        expect(environment[KIMI_CODE_NO_AUTO_UPDATE_ENV]).toBe("1");
      }),
    );

    it.effect("does not synthesize a home when the setting is blank", () =>
      Effect.gen(function* () {
        expect(yield* resolveKimiHomePath({ homePath: "   " })).toBeUndefined();
        const environment = yield* makeKimiEnvironment({ homePath: "" }, {});
        expect(KIMI_CODE_HOME_ENV in environment).toBe(false);
      }),
    );
  });
});
