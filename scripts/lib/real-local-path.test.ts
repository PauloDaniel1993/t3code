// @effect-diagnostics nodeBuiltinImport:off - Filesystem alias fixtures never use installed homes.
import * as NodeFSP from "node:fs/promises";
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import { resolveRealLocalPath } from "./real-local-path.ts";

it("resolves junctions and missing children to their local directory", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-real-path-"));
  try {
    const actual = NodePath.join(root, "actual");
    const alias = NodePath.join(root, "alias");
    await NodeFSP.mkdir(actual);
    await NodeFSP.symlink(actual, alias, "junction");
    assert.equal(
      resolveRealLocalPath(NodePath.join(alias, "missing")),
      NodePath.join(actual, "missing"),
    );
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("resolves local admin shares by file identity and missing children", async () => {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone filesystem test requiring Windows SMB shares.
  if (NodeOS.platform() !== "win32") return;
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-unc-path-"));
  try {
    const drive = NodePath.parse(root).root;
    const suffix = root.slice(drive.length);
    for (const host of ["localhost", "127.0.0.1", NodeOS.hostname()]) {
      const unc = `\\\\${host}\\${drive[0]}$\\${suffix}`;
      assert.equal(resolveRealLocalPath(unc), root);
      assert.equal(
        resolveRealLocalPath(`${unc}\\missing\\child`),
        NodePath.join(root, "missing", "child"),
      );
      assert.throws(() => resolveRealLocalPath(`\\\\?\\UNC\\${unc.slice(2)}`), /Refusing/);
    }
    assert.throws(() => resolveRealLocalPath(`\\\\?\\${root}`), /Refusing/);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("refuses Windows folded spellings before resolving existing or missing directories", async () => {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Real Windows path fixtures.
  if (NodeOS.platform() !== "win32") return;
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-folded-path-"));
  try {
    const live = NodePath.join(root, ".t3.local");
    await NodeFSP.mkdir(live);
    for (const candidate of [
      `${live}.`,
      `${live} `,
      `${live}.\\userdata`,
      NodePath.join(root, ".t3."),
      NodePath.join(root, "missing. ", "child"),
      NodePath.join(root, "T3LOCA~1"),
      `\\\\?\\${live}`,
      `\\\\.\\${live}`,
      `\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1${live.slice(2)}`,
      `\\\\?\\Volume{fixture}\\home`,
      `${live}:stream`,
      `${live}::$DATA`,
      live.replaceAll("\\", "/"),
    ])
      assert.throws(() => resolveRealLocalPath(candidate), /Refusing|trailing/);
    const long = NodePath.join(root, "Long Directory Name");
    await NodeFSP.mkdir(long);
    const short = NodeChildProcess.execFileSync(
      "cmd.exe",
      ["/d", "/c", `for %I in ("${long}") do @echo %~sI`],
      { encoding: "utf8" },
    ).trim();
    // Volumes with 8.3 generation disabled return the long spelling; synthetic short names are still refused above.
    if (short.toLowerCase() !== long.toLowerCase())
      assert.throws(() => resolveRealLocalPath(short), /Refusing/);
    assert.throws(() => resolveRealLocalPath("\\\\localhost\\t3-nonexistent-share\\home"));
    assert.equal(
      resolveRealLocalPath(NodePath.join(root, "new", "child")),
      NodePath.join(root, "new", "child"),
    );
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("refuses relative Windows paths and says a full path is required", async () => {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Real Windows path fixtures.
  if (NodeOS.platform() !== "win32") return;
  for (const candidate of [".\\v2home", "..\\x\\v2home", "v2home", "I:v2home", "\\v2home"])
    assert.throws(() => resolveRealLocalPath(candidate), /full path is required/);
});
