// @effect-diagnostics nodeBuiltinImport:off - Snapshot fixtures never open installed databases.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeChildProcess from "node:child_process";
import * as NodeSqlite from "node:sqlite";
import { assert, it } from "@effect/vitest";
import { snapshotV2Database } from "./snapshot-v2-database.ts";

it("snapshots committed WAL rows read-only, checks integrity and refuses overwrites and protected aliases", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-snapshot-"));
  const home = NodePath.join(root, "user");
  const source = NodePath.join(root, "source.sqlite");
  const db = new NodeSqlite.DatabaseSync(source);
  try {
    db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE evidence (value TEXT); INSERT INTO evidence VALUES ('committed fixture');",
    );
    await NodeFSP.mkdir(home);
    const original = await NodeFSP.readFile(source);
    const wal = await NodeFSP.readFile(`${source}-wal`);
    const destination = NodePath.join(root, "new state", "state.sqlite");
    snapshotV2Database(source, destination, home);
    const copy = new NodeSqlite.DatabaseSync(destination, { readOnly: true });
    try {
      assert.deepEqual(
        copy
          .prepare("SELECT value FROM evidence")
          .all()
          .map((row) => row.value),
        ["committed fixture"],
      );
    } finally {
      copy.close();
    }
    const snapshotBytes = await NodeFSP.readFile(destination);
    assert.throws(() => snapshotV2Database(source, destination, home), /EEXIST/);
    assert.deepEqual(await NodeFSP.readFile(destination), snapshotBytes);
    for (const name of [".t3", ".t3.local"]) {
      const protectedHome = NodePath.join(home, name);
      await NodeFSP.mkdir(protectedHome);
      assert.throws(
        () =>
          snapshotV2Database(
            source,
            NodePath.join(protectedHome, "userdata", "state.sqlite"),
            home,
          ),
        /Refusing/,
      );
      const alias = NodePath.join(root, `${name}-alias`);
      await NodeFSP.symlink(protectedHome, alias, "junction");
      assert.throws(
        () => snapshotV2Database(source, NodePath.join(alias, "userdata", "state.sqlite"), home),
        /Refusing/,
      );
      // oxlint-disable-next-line t3code/no-global-process-runtime -- Windows-only path spelling fixture.
      if (NodeOS.platform() === "win32")
        assert.throws(
          () => snapshotV2Database(source, `${protectedHome}.\\state.sqlite`, home),
          /trailing/,
        );
      assert.isFalse(NodeFS.existsSync(NodePath.join(protectedHome, "userdata")));
      await NodeFSP.rmdir(alias);
    }
    assert.deepEqual(await NodeFSP.readFile(source), original);
    assert.deepEqual(await NodeFSP.readFile(`${source}-wal`), wal);
  } finally {
    db.close();
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("runs the file command in Windows PowerShell 5.1 and PowerShell 7 without inline JavaScript", async () => {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Native PowerShell compatibility fixture.
  if (NodeOS.platform() !== "win32") return;
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-snapshot-shell-"));
  try {
    const home = NodePath.join(root, "fixture home");
    await NodeFSP.mkdir(home);
    const source = NodePath.join(root, "source data.sqlite");
    const db = new NodeSqlite.DatabaseSync(source);
    db.exec("CREATE TABLE evidence (value TEXT); INSERT INTO evidence VALUES ('shell fixture');");
    db.close();
    const before = await NodeFSP.readFile(source);
    // Keep the CLI's OS-profile lookup and every path check inside our sandbox.
    const preload = NodePath.join(root, "profile.cjs");
    await NodeFSP.writeFile(
      preload,
      `const os = require('node:os'); const userInfo = os.userInfo; os.userInfo = (...args) => ({ ...userInfo(...args), homedir: ${JSON.stringify(home)} }); require('node:module').syncBuiltinESMExports();`,
    );
    const script = NodeURL.fileURLToPath(new URL("./snapshot-v2-database.ts", import.meta.url));
    for (const shell of ["powershell.exe", "pwsh.exe"]) {
      const destination = NodePath.join(root, `${shell} snapshot.sqlite`);
      const command = NodePath.join(root, `${shell}.ps1`);
      await NodeFSP.writeFile(
        command,
        "$ErrorActionPreference = 'Stop'\nnode $env:T3_SNAPSHOT_SCRIPT $env:T3_SNAPSHOT_SOURCE $env:T3_SNAPSHOT_DESTINATION\nexit $LASTEXITCODE\n",
      );
      const output = NodeChildProcess.execFileSync(shell, ["-NoProfile", "-File", command], {
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_OPTIONS: `--require "${preload.replaceAll("\\", "/")}"`,
          T3_SNAPSHOT_SCRIPT: script,
          T3_SNAPSHOT_SOURCE: source,
          T3_SNAPSHOT_DESTINATION: destination,
        },
      });
      assert.include(output, "Snapshot quick_check: ok");
      const copy = new NodeSqlite.DatabaseSync(destination, { readOnly: true });
      try {
        assert.equal(copy.prepare("SELECT value FROM evidence").get()?.value, "shell fixture");
      } finally {
        copy.close();
      }
    }
    assert.deepEqual(await NodeFSP.readFile(source), before);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
