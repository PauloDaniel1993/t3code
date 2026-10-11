import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ProjectEntry,
  WorkspaceScope,
  WorkspaceScopeFolder,
} from "@t3tools/contracts";
import { toCanonicalPath } from "@t3tools/shared/workspaceFolders";
import * as Cause from "effect/Cause";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";

import { appAtomRegistry } from "../../state/atom-registry";
import { projectEnvironment } from "../../state/projects";
import { useDebouncedValue } from "../../state/queries";
import { useEnvironmentQuery } from "../../state/query";
import {
  pinWorkspaceFileScope,
  workspaceFileCacheKey,
  workspaceFolderErrors,
} from "../../lib/workspaceFiles";
import { collectFileTreeEntries } from "./fileTree";
import { useWorkspaceFileBindingKey } from "../../state/workspace-file-bindings";

const EMPTY_FOLDERS: ReadonlyArray<WorkspaceScopeFolder> = [];

export function useFileTreeEntries(input: {
  readonly cwd: string | null;
  readonly environmentId: EnvironmentId | null;
  readonly scope?: WorkspaceScope | null;
  readonly searchQuery: string;
}) {
  const { cwd, environmentId } = input;
  const scope = input.scope ?? null;
  const bindingKey = useWorkspaceFileBindingKey(environmentId, scope);
  const workspaceKey = `${workspaceFileCacheKey({ cwd, environmentId, scope })}:${bindingKey}`;
  const [selection, setSelection] = useState<{ key: string; folderPath: string } | null>(null);
  const selectedFolderPath = selection?.key === workspaceKey ? selection.folderPath : null;
  const searching = input.searchQuery.trim().length > 0;
  const query = input.searchQuery.trim().slice(0, 256);
  const debouncedQuery = useDebouncedValue(query, 200);
  const inventory = useEnvironmentQuery(
    cwd !== null && environmentId !== null
      ? projectEnvironment.listEntries({
          environmentId,
          input: scope ? { scope, directoryPath: "" } : { cwd, directoryPath: "" },
        })
      : null,
  );
  const folders = inventory.data?.folders ?? EMPTY_FOLDERS;
  const selectedFolder = folders.find((folder) => folder.folderPath === selectedFolderPath);
  const rootDirectoryPath = selectedFolder
    ? toCanonicalPath(selectedFolder, "", folders.length)
    : "";
  const selectedScope = useMemo(
    () => (scope && selectedFolderPath ? { ...scope, folderPath: selectedFolderPath } : scope),
    [scope, selectedFolderPath],
  );
  const selectedRoot = useEnvironmentQuery(
    cwd !== null && environmentId !== null && selectedScope?.folderPath !== undefined
      ? projectEnvironment.listEntries({
          environmentId,
          input: { scope: selectedScope, directoryPath: rootDirectoryPath },
        })
      : null,
  );
  const root = selectedScope?.folderPath === undefined ? inventory : selectedRoot;
  const search = useEnvironmentQuery(
    searching && debouncedQuery.length > 0 && cwd !== null && environmentId !== null
      ? projectEnvironment.searchEntries({
          environmentId,
          input: selectedScope
            ? { scope: selectedScope, query: debouncedQuery, limit: 200 }
            : { cwd, query: debouncedQuery, limit: 200 },
        })
      : null,
  );
  const [revision, render] = useReducer((value: number) => value + 1, 0);
  const resultFolders = search.data?.folders ?? folders;
  const scopeForPath = useCallback(
    (path: string) => (scope ? pinWorkspaceFileScope(scope, path, resultFolders) : null),
    [scope, resultFolders],
  );
  const refreshVersion = useRef(0);
  const directories = useMemo(
    () => ({
      workspaceKey,
      entries: new Map<string, ReadonlyArray<ProjectEntry>>(),
      requested: new Set<string>(),
      pending: new Map<string, AbortController>(),
      errors: new Map<string, string>(),
    }),
    [workspaceKey, selectedFolderPath],
  );
  useEffect(
    () => () => {
      refreshVersion.current++;
      for (const controller of directories.pending.values()) controller.abort();
      directories.pending.clear();
    },
    [directories],
  );
  const loadDirectory = useCallback(
    (directoryPath: string, refresh = false) => {
      if (
        cwd === null ||
        environmentId === null ||
        (!refresh && directories.entries.has(directoryPath)) ||
        directories.pending.has(directoryPath)
      ) {
        return;
      }
      const pinnedScope = scopeForPath(directoryPath);
      if (scope && pinnedScope === null) return;
      const controller = new AbortController();
      directories.requested.add(directoryPath);
      directories.pending.set(directoryPath, controller);
      directories.errors.delete(directoryPath);
      render();
      const atom = projectEnvironment.listEntries({
        environmentId,
        input: pinnedScope ? { scope: pinnedScope, directoryPath } : { cwd, directoryPath },
      });
      appAtomRegistry.refresh(atom);
      return executeAtomQuery(appAtomRegistry, atom, {
        signal: controller.signal,
        reportFailure: false,
        reportDefect: false,
      }).then((result) => {
        if (controller.signal.aborted) return;
        directories.pending.delete(directoryPath);
        if (result._tag === "Success") {
          directories.entries.set(
            directoryPath,
            scope
              ? result.value.entries
              : result.value.entries.filter(
                  (entry) =>
                    entry.path.slice(0, Math.max(0, entry.path.lastIndexOf("/"))) === directoryPath,
                ),
          );
        } else {
          const error = Cause.squash(result.cause);
          directories.errors.set(
            directoryPath,
            error instanceof Error ? error.message : "Files unavailable",
          );
        }
        render();
      });
    },
    [cwd, directories, environmentId, scopeForPath, scope],
  );
  const { refresh: refreshRoot, data: rootData } = root;
  const { refresh: refreshSearch, data: searchData } = search;
  const snapshot = useMemo(() => {
    return {
      revision,
      ...collectFileTreeEntries(
        (rootData?.entries ?? []).filter((entry) => scope !== null || !entry.path.includes("/")),
        directories.entries,
        searching ? searchData?.entries : [],
      ),
    };
  }, [directories, revision, rootData, searchData, searching, scope]);

  const refresh = useCallback(() => {
    inventory.refresh();
    if (selectedScope?.folderPath !== undefined) refreshRoot();
    if (searching) refreshSearch();
    const paths = new Set(
      [...directories.requested].filter((path) => snapshot.reachableDirectories.has(path)),
    );
    for (const controller of directories.pending.values()) controller.abort();
    directories.pending.clear();
    directories.errors.clear();
    const version = ++refreshVersion.current;
    const remaining = paths.values();
    const worker = async () => {
      while (version === refreshVersion.current) {
        const next = remaining.next();
        if (next.done) return;
        await loadDirectory(next.value, true);
      }
    };
    for (let index = 0; index < Math.min(4, paths.size); index++) void worker();
    render();
  }, [
    directories,
    inventory.refresh,
    loadDirectory,
    refreshRoot,
    refreshSearch,
    searching,
    selectedScope,
    snapshot.reachableDirectories,
  ]);

  return {
    folders,
    selectedFolderPath,
    rootDirectoryPath,
    selectFolder: (folderPath: string | null) =>
      setSelection(folderPath === null ? null : { key: workspaceKey, folderPath }),
    scopeForPath,
    entries: snapshot.entries,
    error:
      root.error ??
      (searching ? search.error : null) ??
      workspaceFolderErrors(searching ? (search.data?.folders ?? folders) : folders) ??
      [...directories.errors].find(([path]) => snapshot.reachableDirectories.has(path))?.[1] ??
      null,
    isPending:
      root.isPending ||
      directories.pending.size > 0 ||
      (searching && (query !== debouncedQuery || search.isPending)),
    searchTruncated: searching && (search.data?.truncated ?? false),
    loadedDirectories: new Set(directories.entries.keys()),
    loadDirectory,
    refresh,
  };
}
