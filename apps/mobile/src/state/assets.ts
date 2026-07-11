import { useAtomValue } from "@effect/atom-react";
import {
  createAssetEnvironmentAtoms,
  resolveUnexpiredAssetUrl,
} from "@t3tools/client-runtime/state/assets";
import type { AssetResource, EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useEffect, useState } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { usePreparedConnection } from "./session";

export const assetEnvironment = createAssetEnvironmentAtoms(connectionAtomRuntime);

const EMPTY_ASSET_URL_ATOM = Atom.make(AsyncResult.initial<never, never>(false)).pipe(
  Atom.withLabel("mobile-asset-url:empty"),
);

export function useAssetUrl(
  environmentId: EnvironmentId | null,
  resource: AssetResource | null,
): string | null {
  const preparedConnection = usePreparedConnection(environmentId);
  const result = useAtomValue(
    environmentId === null || resource === null
      ? EMPTY_ASSET_URL_ATOM
      : assetEnvironment.createUrl({ environmentId, input: { resource } }),
  );
  const expiresAt = result._tag === "Success" ? result.value.expiresAt : null;
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (expiresAt === null) return;
    const delay = expiresAt - Date.now() + 1;
    if (delay <= 0) {
      setNowMs(Date.now());
      return;
    }
    const timeout = globalThis.setTimeout(
      () => setNowMs(Date.now()),
      Math.min(delay, 2_147_483_647),
    );
    return () => globalThis.clearTimeout(timeout);
  }, [expiresAt]);
  if (preparedConnection._tag === "None" || result._tag !== "Success") {
    return null;
  }
  return resolveUnexpiredAssetUrl(preparedConnection.value.httpBaseUrl, result.value, nowMs);
}
