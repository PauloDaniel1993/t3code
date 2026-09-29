// @effect-diagnostics nodeBuiltinImport:off - Filesystem alias fixtures never use installed homes.
import * as NodeFSP from "node:fs/promises";
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

it("resolves local admin shares by file identity, including extended UNC and missing children", async () => {
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
      assert.equal(resolveRealLocalPath(`\\\\?\\UNC\\${unc.slice(2)}`), root);
    }
    assert.equal(resolveRealLocalPath(`\\\\?\\${root}`), root);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
