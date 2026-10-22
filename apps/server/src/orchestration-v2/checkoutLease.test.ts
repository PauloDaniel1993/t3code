import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { makeCheckoutLeaseKeys } from "./checkoutLease.ts";

it.effect("keeps canonical lease keys after aliased checkouts and their parents are removed", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-checkout-lease-" });
    const managed = path.join(root, "worktrees");
    const alias = path.join(root, "alias");
    const member = path.join(managed, "repo", "session", "app");
    const aliasedMember = path.join(alias, "repo", "session", "app");
    yield* fs.makeDirectory(member, { recursive: true });
    yield* fs.symlink(managed, alias);
    const { keys } = yield* makeCheckoutLeaseKeys;
    const before = yield* keys([
      member,
      aliasedMember,
      path.join(alias, "z"),
      path.join(managed, "a"),
    ]);
    assert.lengthOf(before, 3);
    assert.deepEqual(before, before.toSorted());
    yield* fs.remove(path.join(managed, "repo"), { recursive: true });
    assert.deepEqual(
      yield* keys([path.join(managed, "a"), path.join(managed, "z"), aliasedMember, member]),
      before,
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
