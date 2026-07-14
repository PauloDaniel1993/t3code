import { useAtomValue } from "@effect/atom-react";
import { resolveUnexpiredAssetUrl } from "@t3tools/client-runtime/state/assets";
import type { AssetResource, EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useMemo, useState } from "react";

import { assetEnvironment } from "~/state/assets";
import { usePreparedConnection } from "~/state/session";

export { resolveAssetUrl, resolveUnexpiredAssetUrl } from "@t3tools/client-runtime/state/assets";

function useAssetExpiryClock(expiresAtValues: ReadonlyArray<number>): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const currentTime = Date.now();
    const nextExpiry = expiresAtValues.reduce<number | null>(
      (nearest, expiresAt) =>
        expiresAt > currentTime && (nearest === null || expiresAt < nearest) ? expiresAt : nearest,
      null,
    );
    if (nextExpiry === null) return;
    const timeout = globalThis.setTimeout(
      () => setNowMs(Date.now()),
      Math.min(Math.max(0, nextExpiry - currentTime + 1), 2_147_483_647),
    );
    return () => globalThis.clearTimeout(timeout);
  }, [expiresAtValues, nowMs]);
  return nowMs;
}

export function useAssetUrl(environmentId: EnvironmentId, resource: AssetResource): string | null {
  const preparedConnection = usePreparedConnection(environmentId);
  const result = useAtomValue(
    assetEnvironment.createUrl({
      environmentId,
      input: { resource },
    }),
  );
  const expiresAtValues = useMemo(
    () => (result._tag === "Success" ? [result.value.expiresAt] : []),
    [result],
  );
  const nowMs = useAssetExpiryClock(expiresAtValues);
  if (preparedConnection._tag === "None" || result._tag !== "Success") {
    return null;
  }
  return resolveUnexpiredAssetUrl(preparedConnection.value.httpBaseUrl, result.value, nowMs);
}

export function useAssetUrls(
  environmentId: EnvironmentId,
  resources: ReadonlyArray<AssetResource>,
): ReadonlyArray<string | null> {
  const preparedConnection = usePreparedConnection(environmentId);
  const results = useAtomValue(
    assetEnvironment.createUrls({
      environmentId,
      resources,
    }),
  );
  const expiresAtValues = useMemo(
    () =>
      results.flatMap((result) => (AsyncResult.isSuccess(result) ? [result.value.expiresAt] : [])),
    [results],
  );
  const nowMs = useAssetExpiryClock(expiresAtValues);
  return useMemo(
    () =>
      preparedConnection._tag === "None"
        ? resources.map(() => null)
        : results.map((result) =>
            AsyncResult.isSuccess(result)
              ? resolveUnexpiredAssetUrl(preparedConnection.value.httpBaseUrl, result.value, nowMs)
              : null,
          ),
    [nowMs, preparedConnection, resources, results],
  );
}
