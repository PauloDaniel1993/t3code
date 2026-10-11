import type { EnvironmentId, WorkspaceScope } from "@t3tools/contracts";
import { createRef, useEffect, useMemo } from "react";

import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";

import { FileSaveCoordinator } from "./fileSaveCoordinator";
import { confirmProjectFileQueryData } from "./projectFilesQueryState";
import { useWorkspaceFileScope } from "./workspaceFiles";

const FILE_SAVE_DEBOUNCE_MS = 500;

interface FileSaveOptions {
  environmentId: EnvironmentId;
  cwd: string;
  scope?: WorkspaceScope | undefined;
  relativePath: string;
  onPendingChange: (relativePath: string, pending: boolean) => void;
}

export function useFileSaveCoordinator({
  environmentId,
  cwd,
  scope: inputScope,
  relativePath,
  onPendingChange,
}: FileSaveOptions): Pick<FileSaveCoordinator, "change"> {
  const writeFile = useAtomCommand(projectEnvironment.writeFile);
  const scope = useWorkspaceFileScope(inputScope);
  const session = useMemo(() => {
    const coordinatorRef = createRef<FileSaveCoordinator>();
    return {
      change: (contents: string) => coordinatorRef.current?.change(contents),
      setup: () => {
        const coordinator = new FileSaveCoordinator({
          debounceMs: FILE_SAVE_DEBOUNCE_MS,
          onPendingChange: (pending) => onPendingChange(relativePath, pending),
          persist: (nextContents) =>
            writeFile({
              environmentId,
              input: scope
                ? { scope, path: relativePath, contents: nextContents }
                : { cwd, relativePath, contents: nextContents },
            }),
          onConfirmed: (confirmedContents) => {
            if (scope)
              confirmProjectFileQueryData(
                environmentId,
                cwd,
                relativePath,
                confirmedContents,
                scope,
              );
            else confirmProjectFileQueryData(environmentId, cwd, relativePath, confirmedContents);
          },
        });
        coordinatorRef.current = coordinator;
        return () => {
          coordinatorRef.current = null;
          coordinator.dispose();
        };
      },
    };
  }, [cwd, scope, environmentId, onPendingChange, relativePath, writeFile]);

  // StrictMode replays effect setup. Retired file sessions stay inert, while the
  // replay gets a fresh coordinator instead of reusing a disposed one.
  useEffect(session.setup, [session]);
  return session;
}
