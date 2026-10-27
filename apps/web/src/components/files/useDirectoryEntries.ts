import type { EnvironmentId, ProjectEntry, WorkspaceScopeFolder } from "@t3tools/contracts";
import { useAtomMount, useAtomSubscribe } from "@effect/atom-react";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import { useEffect, useRef, useState } from "react";

import { environmentCatalog } from "~/connection/catalog";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { projectEnvironment } from "~/state/projects";
import { useStableCallback } from "~/hooks/useStableCallback";

import {
  workspaceFileContextKey,
  workspaceFileReference,
  type WorkspaceFileContext,
} from "./workspaceFiles";

export function useDirectoryEntries(
  environmentId: EnvironmentId,
  cwd: string,
  workspace?: WorkspaceFileContext,
) {
  const workspaceKey = workspaceFileContextKey(cwd, workspace);
  const [folders, setFolders] = useState<readonly WorkspaceScopeFolder[]>([]);
  const [directories, setDirectories] = useState(new Map<string, readonly ProjectEntry[]>());
  const [errors, setErrors] = useState(new Map<string, string>());
  const [pending, setPending] = useState(1);
  const [loadingDirectories, setLoadingDirectories] = useState<ReadonlySet<string>>(
    () => new Set([""]),
  );
  const requests = useRef(new Map<string, Promise<void>>());
  const loaded = useRef(new Set<string>());
  const requested = useRef(new Set<string>());
  const active = useRef(true);
  const generation = useRef(0);
  const running = useRef(0);
  const waiting = useRef<Array<() => void>>([]);

  // Callers count the request as pending first; the mount load is counted by the initial state.
  const startRequest = useStableCallback(
    (directoryPath: string, refresh: boolean): Promise<void> => {
      const requestGeneration = generation.current;
      loaded.current.add(directoryPath);
      requested.current.add(directoryPath);
      const reference = directoryPath ? workspaceFileReference(workspace, directoryPath) : null;
      const scope = reference?.scope ?? workspace?.scope;
      const atom = projectEnvironment.listEntries({
        environmentId,
        input: scope ? { scope, directoryPath } : { cwd, directoryPath },
      });
      const request = (async () => {
        if (running.current >= 4)
          await new Promise<void>((resolve) => waiting.current.push(resolve));
        else running.current++;
        // executeAtomQuery settles instead of throwing, so the slot is always released.
        const result =
          active.current && generation.current === requestGeneration
            ? await executeAtomQuery(appAtomRegistry, atom, {
                refresh: true,
                reportFailure: false,
                reportDefect: false,
              })
            : undefined;
        const next = waiting.current.shift();
        if (next) next();
        else running.current--;
        return result;
      })()
        .then((result) => {
          if (!active.current || generation.current !== requestGeneration || !result) return;
          if (result._tag === "Success") {
            setFolders(result.value.folders ?? []);
            const roots =
              directoryPath === "" && (result.value.folders?.length ?? 0) > 1
                ? result.value.folders!.map((folder) => ({
                    path: folder.label,
                    kind: "directory" as const,
                  }))
                : result.value.entries.filter(
                    (entry) =>
                      entry.path.slice(0, Math.max(0, entry.path.lastIndexOf("/"))) ===
                      directoryPath,
                  );
            setDirectories((previous) => new Map(previous).set(directoryPath, roots));
            setErrors((previous) => {
              const next = new Map(previous);
              next.delete(directoryPath);
              return next;
            });
          } else {
            loaded.current.delete(directoryPath);
            const cause = Cause.squash(result.cause);
            setErrors((previous) =>
              new Map(previous).set(
                directoryPath,
                cause instanceof Error ? cause.message : "Unable to load folder.",
              ),
            );
          }
        })
        .finally(() => {
          if (generation.current !== requestGeneration) return;
          requests.current.delete(directoryPath);
          if (!active.current) return;
          setPending((count) => count - 1);
          if (!refresh)
            setLoadingDirectories((previous) => {
              const next = new Set(previous);
              next.delete(directoryPath);
              return next;
            });
        });
      requests.current.set(directoryPath, request);
      return request;
    },
  );

  const load = function loadDirectory(directoryPath: string, refresh = false): Promise<void> {
    const requestGeneration = generation.current;
    const existing = requests.current.get(directoryPath);
    if (existing)
      return refresh
        ? existing.then(() => {
            if (active.current && generation.current === requestGeneration)
              return loadDirectory(directoryPath, true);
          })
        : existing;
    if (!refresh && loaded.current.has(directoryPath)) return Promise.resolve();
    setPending((count) => count + 1);
    if (!refresh) setLoadingDirectories((previous) => new Set(previous).add(directoryPath));
    return startRequest(directoryPath, refresh);
  };

  const contextKey = `${environmentId}:${workspaceKey}`;
  const [loadedContextKey, setLoadedContextKey] = useState(contextKey);
  if (loadedContextKey !== contextKey) {
    setLoadedContextKey(contextKey);
    setFolders([]);
    setDirectories(new Map());
    setErrors(new Map());
    setPending(1);
    setLoadingDirectories(new Set([""]));
  }

  useEffect(() => {
    generation.current++;
    active.current = true;
    requests.current.clear();
    loaded.current.clear();
    requested.current.clear();
    void startRequest("", false);
    return () => {
      active.current = false;
      generation.current++;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- The stable request handler reads the new context; its generation must reset when that context changes.
  }, [contextKey, startRequest]);

  // A folder read fails at once while its environment is unreachable; read it again once a new
  // session is up rather than leaving the error until someone retries by hand.
  const sessionGeneration = environmentCatalog.sessionGenerationAtom(environmentId);
  // A listener alone does not compute the atom, so nothing would follow the connection.
  useAtomMount(sessionGeneration);
  useAtomSubscribe(sessionGeneration, () => {
    for (const path of errors.keys()) void load(path);
  });

  const entries: ProjectEntry[] = [];
  const visit = (path: string) => {
    for (const entry of directories.get(path) ?? []) {
      entries.push(entry);
      if (entry.kind === "directory") visit(entry.path);
    }
  };
  visit("");

  const reachableDirectories = new Set([
    "",
    ...entries.filter((entry) => entry.kind === "directory").map((entry) => entry.path),
  ]);

  const refresh = () => {
    const refreshGeneration = generation.current;
    const paths = [...requested.current].filter((path) => reachableDirectories.has(path));
    const workerCount = Math.min(4, paths.length);
    const worker = async () => {
      while (active.current && generation.current === refreshGeneration) {
        const path = paths.shift();
        if (path === undefined) return;
        await load(path, true);
      }
    };
    for (let index = 0; index < workerCount; index++) void worker();
  };

  return {
    entries,
    folders,
    load,
    refresh,
    isPending: pending > 0,
    loadingDirectories,
    ready: directories.has(""),
    error: [...errors].find(([path]) => reachableDirectories.has(path))?.[1] ?? null,
  };
}
