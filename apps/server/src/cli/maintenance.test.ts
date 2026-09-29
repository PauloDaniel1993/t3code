// @effect-diagnostics nodeBuiltinImport:off - CLI verification uses only disposable V2 fixtures.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/unstable/cli";
import { afterEach, beforeEach, expect, it } from "@effect/vitest";

import { maintenanceCommand } from "./maintenance.ts";
import { createMaintenanceFixture } from "../persistence/DatabaseMaintenanceFixture.test-support.ts";
import { compactDatabase } from "../persistence/DatabasePhysicalMaintenance.ts";
import { readMaintenanceJournal } from "../persistence/DatabaseMaintenanceJournal.ts";

let databasePath: string;
let directory: string;
beforeEach(async () => {
  ({ databasePath, directory } = await createMaintenanceFixture());
});
afterEach(() => NodeFS.rmSync(directory, { recursive: true, force: true }));

const run = (args: string[]) =>
  Command.runWith(maintenanceCommand, { version: "test" })(args).pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, TestConsole.layer)),
  );

it.effect("requires an explicit database and never falls back to the current user's home", () =>
  Effect.gen(function* () {
    const files = NodeFS.readdirSync(directory);
    yield* run(["compact"]).pipe(Effect.flip);
    expect(NodeFS.readdirSync(directory)).toEqual(files);
  }),
);

it.effect(
  "estimates, compacts, and reports status without starting a server or applying migrations",
  () =>
    Effect.gen(function* () {
      yield* run(["estimate", "--database", databasePath]);
      yield* run(["compact", "--database", databasePath]);
      yield* run(["status", "--database", databasePath]);
      expect(readMaintenanceJournal(databasePath)?.phase).toBe("completed");
      expect(NodeFS.existsSync(NodePath.join(directory, "server-runtime.json"))).toBe(false);
    }),
);

it.effect("reports status without a database and exposes recovery after a failed operation", () =>
  Effect.gen(function* () {
    yield* run(["status", "--database", NodePath.join(directory, "absent.sqlite")]);
    expect(() =>
      compactDatabase(
        { databasePath },
        {
          onPhase: (journal) => {
            if (journal.phase === "validated") throw new Error("failure");
          },
        },
      ),
    ).toThrow("failure");
    yield* run(["compact", "--database", databasePath]).pipe(Effect.flip);
    yield* run(["recover", "--database", databasePath]);
    expect(readMaintenanceJournal(databasePath)?.phase).toBe("recovered");
  }),
);
