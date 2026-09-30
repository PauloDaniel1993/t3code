// @effect-diagnostics nodeBuiltinImport:off - CLI verification uses only disposable V2 fixtures.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import * as NodeSqlite from "node:sqlite";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/unstable/cli";
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";

import { maintenanceCommand } from "./maintenance.ts";
import { createMaintenanceFixture } from "../orchestration-v2/legacy/DatabaseMaintenanceFixture.test-support.ts";
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
  [
    "V1",
    `PRAGMA journal_mode=WAL;
    CREATE TABLE effect_sql_migrations(migration_id INTEGER PRIMARY KEY, name TEXT);
    INSERT INTO effect_sql_migrations VALUES(54,'ProjectionThreadsAutoSettleDisabledAt');
    CREATE TABLE projection_threads(thread_id TEXT PRIMARY KEY);
    CREATE TABLE maintenance_space(id INTEGER PRIMARY KEY,payload BLOB);`,
  ],
  ["non-T3", "DROP TABLE effect_sql_migrations"],
  [
    "another schema version",
    "INSERT INTO effect_sql_migrations (migration_id,name,created_at) VALUES (57, 'FutureSchema', 'now')",
  ],
])("refused %s files", (kind, mutation) => {
  it.effect("leaves the file, pending WAL and SHM byte-identical for every command", () =>
    Effect.gen(function* () {
      if (kind === "V1") {
        databasePath = NodePath.join(directory, "state.sqlite");
      }
      // V1 has its entire schema in WAL. For the other two cases, immutable=1
      // would incorrectly see a supported V2 schema in the main file.
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
        require('node:fs').writeSync(1, 'fixture-ready');
        process.kill(process.pid, 'SIGKILL');
      `,
          databasePath,
          mutation,
        ],
        { windowsHide: true },
      );
      expect(child.error).toBeUndefined();
      expect(child.stdout.toString()).toBe("fixture-ready");
      expect(child.status).not.toBe(0);
      expect(NodeFS.statSync(`${databasePath}-wal`).size).toBeGreaterThan(32);
      expect(NodeFS.statSync(`${databasePath}-shm`).size).toBeGreaterThan(0);
      const hashes = () =>
        ["", "-wal", "-shm"].map((suffix) =>
          NodeFS.existsSync(`${databasePath}${suffix}`)
            ? NodeCrypto.createHash("sha256")
                .update(NodeFS.readFileSync(`${databasePath}${suffix}`))
                .digest("hex")
            : null,
        );
      const before = hashes();
      const files = NodeFS.readdirSync(directory);
      for (const command of ["estimate", "compact", "status", "recover"]) {
        yield* run([command, "--database", databasePath]).pipe(Effect.flip);
        expect(hashes(), command).toEqual(before);
        expect(NodeFS.readdirSync(directory), command).toEqual(files);
      }
      // Also forbid creating a missing SHM, then forbid creating either sibling
      // when the same refused schema has been checkpointed by the fixture itself.
      NodeFS.unlinkSync(`${databasePath}-shm`);
      for (const checkpointed of [false, true]) {
        if (checkpointed) {
          const fixtureWriter = new NodeSqlite.DatabaseSync(databasePath);
          fixtureWriter.prepare("SELECT name FROM sqlite_schema").all();
          fixtureWriter.close();
        }
        const expectedHashes = hashes();
        const expectedFiles = NodeFS.readdirSync(directory);
        for (const command of ["estimate", "compact", "status", "recover"]) {
          yield* run([command, "--database", databasePath]).pipe(Effect.flip);
          expect(hashes(), command).toEqual(expectedHashes);
          expect(NodeFS.readdirSync(directory), command).toEqual(expectedFiles);
        }
      }
    }),
  );
});

it("streams phase progress to stderr while keeping the command's stdout as JSON", () => {
  const entry = NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url));
  const result = NodeChildProcess.spawnSync(
    process.execPath,
    [entry, "maintenance", "compact", "--database", databasePath],
    {
      encoding: "utf8",
      windowsHide: true,
    },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout).phase).toBe("completed");
  expect(result.stderr).toContain("Read-only preflight: started");
  expect(result.stderr).toContain("Copying snapshot: started");
  expect(result.stderr).toContain("Validating rewritten database: completed (elapsed");
  expect(result.stderr).toContain("rough estimate");
  expect(result.stderr).toContain("Remaining phases:");
});

it.effect("requires the recovery confirmation flag for a failed final check", () =>
  Effect.gen(function* () {
    expect(() =>
      compactDatabase(
        { databasePath },
        {
          onPhase: (journal) => {
            if (journal.phase === "checking-result")
              throw new Error("injected final-check failure");
          },
        },
      ),
    ).toThrow("injected final-check failure");
    yield* run(["recover", "--database", databasePath]).pipe(Effect.flip);
    expect(readMaintenanceJournal(databasePath)?.phase).toBe("failed");
    yield* run(["compact", "--database", databasePath]).pipe(Effect.flip);
    yield* run(["recover", "--database", databasePath, "--acknowledge-validation-failure"]);
    expect(readMaintenanceJournal(databasePath)?.validationFailureAcknowledgedAt).toBeDefined();
    yield* run(["compact", "--database", databasePath]);
    expect(readMaintenanceJournal(databasePath)?.phase).toBe("completed");
  }),
);
