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

it("leaves no destination file and removes only its own temporary file when the snapshot fails midway", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-snapshot-failure-"));
  try {
    const home = NodePath.join(root, "user");
    await NodeFSP.mkdir(home);
    const corrupt = NodePath.join(root, "corrupt.sqlite");
    await NodeFSP.writeFile(corrupt, "this is not a database ".repeat(200));
    const directory = NodePath.join(root, "new state");
    const destination = NodePath.join(directory, "state.sqlite");
    // A file the developer already keeps beside the destination must survive the cleanup.
    await NodeFSP.mkdir(directory);
    const bystander = NodePath.join(directory, "state.sqlite.other.partial");
    await NodeFSP.writeFile(bystander, "keep");
    assert.throws(
      () => snapshotV2Database(corrupt, destination, home),
      /No snapshot was written to[\s\S]*Removed its own temporary file/,
    );
    assert.deepEqual(await NodeFSP.readdir(directory), ["state.sqlite.other.partial"]);
    assert.equal(await NodeFSP.readFile(bystander, "utf8"), "keep");

    // A retry into the same destination then succeeds.
    const source = NodePath.join(root, "source.sqlite");
    const db = new NodeSqlite.DatabaseSync(source);
    db.exec("CREATE TABLE evidence (value TEXT); INSERT INTO evidence VALUES ('retry');");
    db.close();
    snapshotV2Database(source, destination, home);
    assert.deepEqual((await NodeFSP.readdir(directory)).toSorted(), [
      "state.sqlite",
      "state.sqlite.other.partial",
    ]);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("says no temporary file was created when another file already holds the temporary name", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-snapshot-held-"));
  try {
    const home = NodePath.join(root, "user");
    await NodeFSP.mkdir(home);
    const source = NodePath.join(root, "source.sqlite");
    const db = new NodeSqlite.DatabaseSync(source);
    db.exec("CREATE TABLE evidence (value TEXT);");
    db.close();
    const destination = NodePath.join(root, "state.sqlite");
    const held = `${destination}.${process.pid}.partial`;
    await NodeFSP.writeFile(held, "keep");
    assert.throws(
      () => snapshotV2Database(source, destination, home),
      /EEXIST[\s\S]*No snapshot was written to[\s\S]*No temporary file was created by this run/,
    );
    assert.equal(await NodeFSP.readFile(held, "utf8"), "keep");
    assert.isFalse(NodeFS.existsSync(destination));
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

// Run the file command with removal of `.partial` files refused, as when Windows denies deleting a
// file another process holds. The child also keeps the profile lookup inside the sandbox.
async function runWithRefusedPartialRemoval(source: string, destination: string, home: string) {
  const preload = NodePath.join(NodePath.dirname(home), "refuse-remove.cjs");
  await NodeFSP.writeFile(
    preload,
    `const os = require('node:os'); const userInfo = os.userInfo; os.userInfo = (...args) => ({ ...userInfo(...args), homedir: ${JSON.stringify(home)} });
const fs = require('node:fs'); const rmSync = fs.rmSync;
fs.rmSync = (path, ...rest) => { if (String(path).endsWith('.partial')) throw Object.assign(new Error('EPERM: operation not permitted, unlink'), { code: 'EPERM' }); return rmSync(path, ...rest); };
require('node:module').syncBuiltinESMExports();`,
  );
  const script = NodeURL.fileURLToPath(new URL("./snapshot-v2-database.ts", import.meta.url));
  return NodeChildProcess.spawnSync(
    process.execPath,
    ["--require", preload, script, source, destination],
    { encoding: "utf8" },
  );
}

it("reports success and the surviving temporary file when it cannot be removed after publishing", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-snapshot-leftover-"));
  try {
    const home = NodePath.join(root, "user");
    await NodeFSP.mkdir(home);
    const source = NodePath.join(root, "source.sqlite");
    const db = new NodeSqlite.DatabaseSync(source);
    db.exec("CREATE TABLE evidence (value TEXT); INSERT INTO evidence VALUES ('kept');");
    db.close();
    const destination = NodePath.join(root, "out", "state.sqlite");
    const result = await runWithRefusedPartialRemoval(source, destination, home);
    assert.equal(result.status, 0, result.stderr);
    assert.include(result.stdout, "Snapshot quick_check: ok");
    assert.include(result.stdout, `Snapshot written to ${destination}`);
    const partials = (await NodeFSP.readdir(NodePath.dirname(destination))).filter((name) =>
      name.endsWith(".partial"),
    );
    assert.lengthOf(partials, 1);
    const leftover = NodePath.join(NodePath.dirname(destination), partials[0]!);
    assert.include(result.stderr, `the temporary file ${leftover} could not be removed`);
    assert.include(result.stderr, "deleted by hand");
    const copy = new NodeSqlite.DatabaseSync(destination, { readOnly: true });
    try {
      assert.equal(copy.prepare("SELECT value FROM evidence").get()?.value, "kept");
    } finally {
      copy.close();
    }
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("names the surviving temporary file and the untouched destination when a failed snapshot cannot clean up", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-snapshot-stuck-"));
  try {
    const home = NodePath.join(root, "user");
    await NodeFSP.mkdir(home);
    const corrupt = NodePath.join(root, "corrupt.sqlite");
    await NodeFSP.writeFile(corrupt, "this is not a database ".repeat(200));
    const destination = NodePath.join(root, "out", "state.sqlite");
    const result = await runWithRefusedPartialRemoval(corrupt, destination, home);
    assert.notEqual(result.status, 0);
    assert.isFalse(NodeFS.existsSync(destination));
    assert.include(result.stderr, `No snapshot was written to ${destination}.`);
    assert.match(result.stderr, /Could not remove its own temporary file, .*\.partial \(EPERM/);
    assert.notInclude(result.stderr, "Removed its own");
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("resolves a relative destination against the working directory, then refuses live homes", async () => {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Windows-only path fixture.
  if (NodeOS.platform() !== "win32") return;
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-snapshot-relative-"));
  try {
    const cwd = NodePath.join(root, "work");
    const home = NodePath.join(root, "pretend-home");
    await NodeFSP.mkdir(cwd);
    await NodeFSP.mkdir(NodePath.join(home, ".t3.local"), { recursive: true });
    await NodeFSP.mkdir(NodePath.join(home, ".t3"));
    await NodeFSP.symlink(home, NodePath.join(cwd, "link-to-pretend-home"), "junction");
    const source = NodePath.join(root, "source.sqlite");
    const db = new NodeSqlite.DatabaseSync(source);
    db.exec("CREATE TABLE evidence (value TEXT); INSERT INTO evidence VALUES ('relative');");
    db.close();
    // Keep the command's profile lookup inside the sandbox.
    const preload = NodePath.join(root, "profile.cjs");
    await NodeFSP.writeFile(
      preload,
      `const os = require('node:os'); const userInfo = os.userInfo; os.userInfo = (...args) => ({ ...userInfo(...args), homedir: ${JSON.stringify(home)} }); require('node:module').syncBuiltinESMExports();`,
    );
    const script = NodeURL.fileURLToPath(new URL("./snapshot-v2-database.ts", import.meta.url));
    const run = (destination: string) =>
      NodeChildProcess.spawnSync(
        process.execPath,
        ["--require", preload, script, source, destination],
        {
          cwd,
          encoding: "utf8",
        },
      );

    for (const relative of [
      `..\\pretend-home\\.t3.local\\state.sqlite`,
      `.\\link-to-pretend-home\\.t3\\state.sqlite`,
    ]) {
      const refused = run(relative);
      assert.notEqual(refused.status, 0);
      assert.include(refused.stderr, "Refusing snapshot destination");
      assert.include(refused.stderr, home);
    }
    assert.deepEqual(await NodeFSP.readdir(NodePath.join(home, ".t3.local")), []);
    assert.deepEqual(await NodeFSP.readdir(NodePath.join(home, ".t3")), []);

    const accepted = run(`.\\new-v2-home\\state.sqlite`);
    assert.equal(accepted.status, 0, accepted.stderr);
    const full = NodePath.join(cwd, "new-v2-home", "state.sqlite");
    assert.include(accepted.stdout, `Snapshot written to ${full}`);
    const copy = new NodeSqlite.DatabaseSync(full, { readOnly: true });
    try {
      assert.equal(copy.prepare("SELECT value FROM evidence").get()?.value, "relative");
    } finally {
      copy.close();
    }
  } finally {
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
