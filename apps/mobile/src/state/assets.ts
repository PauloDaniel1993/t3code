import { useAtomValue } from "@effect/atom-react";
import {
  type EnvironmentConnectionPhase,
  presentConnectionState,
} from "@t3tools/client-runtime/connection";
import {
  assetUrlStateFromResult,
  createAssetEnvironmentAtoms,
  createProjectFaviconUrlAtomFamily,
  EMPTY_ASSET_URL_ATOM,
} from "@t3tools/client-runtime/state/assets";
import { WS_METHODS, type AssetResource, type EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback } from "react";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { projectFaviconDatabaseCache } from "../lib/projectFaviconDatabaseCache";
import { type AssetUrlState, deriveAssetUrlState } from "./asset-url-state";
import { environmentProjectCloneListAtom } from "./projectClones";
import { environmentSession, usePreparedConnection } from "./session";
import { useAtomQueryRunner } from "./use-atom-query-runner";
import { createWorkspaceFileQuery } from "./workspace-file-bindings";

export type { AssetUrlFailureReason, AssetUrlState } from "./asset-url-state";

const legacyAssets = createAssetEnvironmentAtoms(connectionAtomRuntime);
const scopedUrl = createWorkspaceFileQuery({
  tag: WS_METHODS.assetsCreateUrl,
  label: "mobile:scoped-file-url",
  staleTimeMs: 5 * 60_000,
  idleTtlMs: 60 * 60_000,
  refreshIntervalMs: 30 * 60_000,
});
export const assetEnvironment = {
  ...legacyAssets,
  createUrl: (target: Parameters<typeof legacyAssets.createUrl>[0]) =>
    target.input.resource._tag === "workspace-scope-file"
      ? scopedUrl(target, target.input.resource.scope)
      : legacyAssets.createUrl(target),
};

export const projectFaviconUrlAtom = createProjectFaviconUrlAtomFamily({
  imageCache: projectFaviconDatabaseCache,
  createUrl: assetEnvironment.createUrl,
  preparedConnection: environmentSession.preparedConnectionValueAtom,
  projectClones: environmentProjectCloneListAtom,
});

const EMPTY_CONNECTION_STATE_ATOM = Atom.make(AsyncResult.initial<never, never>(false)).pipe(
  Atom.withLabel("mobile-asset-connection-state:empty"),
);

function useConnectionPhase(environmentId: EnvironmentId | null): EnvironmentConnectionPhase {
  const state = useAtomValue(
    environmentId === null
      ? EMPTY_CONNECTION_STATE_ATOM
      : environmentCatalog.stateAtom(environmentId),
  );
  const value = Option.getOrNull(AsyncResult.value(state));
  return value === null ? "available" : presentConnectionState(value).phase;
}

export function useAssetUrlState(
  environmentId: EnvironmentId | null,
  resource: AssetResource | null,
): AssetUrlState {
  const preparedConnection = usePreparedConnection(environmentId);
  const connectionPhase = useConnectionPhase(environmentId);
  const result = useAtomValue(
    environmentId === null || resource === null
      ? EMPTY_ASSET_URL_ATOM
      : assetEnvironment.createUrl({ environmentId, input: { resource } }),
  );
  const shared = assetUrlStateFromResult(
    result,
    preparedConnection._tag === "Some" ? preparedConnection.value.httpBaseUrl : null,
  );
  return deriveAssetUrlState({
    connectionPhase,
    // A failure left over from an outage is re-queried as soon as the
    // connection returns. While that re-query is in flight it is not a verdict
    // on the file, so it reads as loading rather than a false "unavailable".
    shared: shared._tag === "Failure" && result.waiting ? { _tag: "Loading" } : shared,
  });
}

export function useAssetUrl(
  environmentId: EnvironmentId | null,
  resource: AssetResource | null,
): string | null {
  const state = useAssetUrlState(environmentId, resource);
  return state._tag === "Success" ? state.url : null;
}

/** Explicit playback and sharing must reauthorize files that may have been replaced on disk. */
export function useRefreshAssetUrl(
  environmentId: EnvironmentId | null,
  resource: AssetResource | null,
): () => Promise<string | null> {
  const connection = usePreparedConnection(environmentId);
  const httpBaseUrl = connection._tag === "Some" ? connection.value.httpBaseUrl : null;
  const createUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    refresh: true,
    reportFailure: false,
  });
  return useCallback(async () => {
    if (environmentId === null || resource === null || httpBaseUrl === null) return null;
    const state = assetUrlStateFromResult(
      await createUrl({ environmentId, input: { resource } }),
      httpBaseUrl,
    );
    return state._tag === "Success" ? state.url : null;
  }, [createUrl, environmentId, httpBaseUrl, resource]);
}
