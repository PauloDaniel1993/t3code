import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export const makeCheckoutLeaseKeys = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  // Resolve missing checkouts through their nearest existing ancestor, just as git will.
  const realLocation = (location: string): Effect.Effect<string> =>
    fileSystem.realPath(location).pipe(
      Effect.catch(() => {
        const parent = path.dirname(location);
        return parent === location
          ? Effect.succeed(location)
          : Effect.map(realLocation(parent), (real) => path.join(real, path.basename(location)));
      }),
    );
  const canonicalPath = Effect.fn("checkoutLease.canonicalPath")(function* (target: string) {
    const resolved = yield* realLocation(path.resolve(target));
    return path.sep === "\\" ? resolved.toLowerCase() : resolved;
  });
  // All multi-checkout operations acquire the same canonical keys in the same order.
  const keys = Effect.fn("checkoutLease.keys")(function* (locations: ReadonlyArray<string>) {
    return [...new Set(yield* Effect.forEach(locations, canonicalPath))].sort();
  });
  return { canonicalPath, keys };
});
