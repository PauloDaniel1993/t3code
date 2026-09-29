// @effect-diagnostics nodeBuiltinImport:off - CLI verification uses only disposable V2 fixtures.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/unstable/cli";
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";

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

it.effect("refuses status without a database and exposes recovery after a failed operation", () =>
  Effect.gen(function* () {
    yield* run(["status", "--database", NodePath.join(directory, "absent.sqlite")]).pipe(
      Effect.flip,
    );
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

describe.each([
  ["V1", "DELETE FROM effect_sql_migrations WHERE migration_id >= 55"],
  ["non-T3", "DROP TABLE effect_sql_migrations"],
  [
    "another schema version",
    "INSERT INTO effect_sql_migrations VALUES (57, 'FutureSchema', 'now')",
  ],
])("refused %s files", (_kind, mutation) => {
  it.effect("leaves the file, pending WAL and SHM byte-identical for every command", () =>
    Effect.gen(function* () {
      // The schema refusal itself is only in the WAL. An immutable=1 reader
      // would incorrectly see the supported schema in the main file.
      const child = NodeChildProcess.spawnSync(
        process.execPath,
        [
          "-e",
          `
        const { DatabaseSync } = require('node:sqlite');
        const db = new DatabaseSync(process.argv[1]);
        db.exec("PRAGMA wal_autocheckpoint=0");
        db.exec(process.argv[2]);
        db.exec("INSERT INTO maintenance_space VALUES(99, zeroblob(100000))");
        process.kill(process.pid, 'SIGKILL');
      `,
          databasePath,
          mutation,
        ],
        { windowsHide: true },
      );
      expect(child.error).toBeUndefined();
      expect(child.status).not.toBe(0);
      expect(NodeFS.statSync(`${databasePath}-wal`).size).toBeGreaterThan(32);
      expect(NodeFS.statSync(`${databasePath}-shm`).size).toBeGreaterThan(0);
      const hashes = () =>
        ["", "-wal", "-shm"].map((suffix) =>
          NodeCrypto.createHash("sha256")
            .update(NodeFS.readFileSync(`${databasePath}${suffix}`))
            .digest("hex"),
        );
      const before = hashes();
      const files = NodeFS.readdirSync(directory);
      for (const command of ["estimate", "compact", "status", "recover"]) {
        yield* run([command, "--database", databasePath]).pipe(Effect.flip);
        expect(hashes(), command).toEqual(before);
        expect(NodeFS.readdirSync(directory), command).toEqual(files);
      }
    }),
  );
});
