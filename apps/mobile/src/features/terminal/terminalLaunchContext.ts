import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { WorkspaceThread } from "@t3tools/shared/workspaceFolders";
import { projectScriptCwd } from "@t3tools/shared/projectScripts";
import { useState } from "react";

interface TerminalLocationLike {
  readonly cwd: string;
  readonly worktreePath: string | null;
}

interface PendingTerminalLaunchTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly terminalId: string;
}

export interface PendingTerminalLaunch {
  readonly cwd: string;
  readonly worktreePath: string | null;
  readonly env?: Record<string, string>;
  readonly initialInput?: string;
}

const pendingTerminalLaunches = new Map<string, PendingTerminalLaunch>();

function pendingTerminalLaunchKey(input: PendingTerminalLaunchTarget): string {
  return `${input.environmentId}:${input.threadId}:${input.terminalId}`;
}

export function stagePendingTerminalLaunch(input: {
  readonly target: PendingTerminalLaunchTarget;
  readonly launch: PendingTerminalLaunch;
}) {
  pendingTerminalLaunches.set(pendingTerminalLaunchKey(input.target), {
    cwd: input.launch.cwd,
    worktreePath: input.launch.worktreePath,
    env: input.launch.env ? { ...input.launch.env } : undefined,
    initialInput: input.launch.initialInput,
  });
}

export function takePendingTerminalLaunch(
  target: PendingTerminalLaunchTarget,
): PendingTerminalLaunch | null {
  const key = pendingTerminalLaunchKey(target);
  const launch = pendingTerminalLaunches.get(key) ?? null;
  if (launch) {
    pendingTerminalLaunches.delete(key);
  }

  return launch;
}

export function resolvePreferredThreadWorktreePath(input: {
  readonly threadShellWorktreePath: string | null;
  readonly threadDetailWorktreePath: string | null;
}): string | null {
  return input.threadDetailWorktreePath ?? input.threadShellWorktreePath ?? null;
}

export function resolveTerminalOpenLocation(input: {
  readonly terminalLocation: TerminalLocationLike | null;
  readonly activeSessionLocation: TerminalLocationLike | null;
  readonly workspaceRoot: string;
  readonly thread?: WorkspaceThread | undefined;
  readonly folderPath?: string | undefined;
  readonly threadShellWorktreePath: string | null;
  readonly threadDetailWorktreePath: string | null;
}): {
  readonly cwd: string;
  readonly worktreePath: string | null;
} {
  const preferredThreadWorktreePath = input.thread
    ? input.thread.worktreePath
    : resolvePreferredThreadWorktreePath({
        threadShellWorktreePath: input.threadShellWorktreePath,
        threadDetailWorktreePath: input.threadDetailWorktreePath,
      });

  const existing = input.terminalLocation ?? input.activeSessionLocation;
  if (existing) return { cwd: existing.cwd, worktreePath: existing.worktreePath };
  const cwd = projectScriptCwd({
    project: { cwd: input.workspaceRoot },
    thread: input.thread,
    worktreePath: preferredThreadWorktreePath,
    folderPath: input.folderPath,
  });
  return {
    cwd,
    worktreePath:
      input.folderPath !== undefined && preferredThreadWorktreePath !== null
        ? cwd
        : preferredThreadWorktreePath,
  };
}

/** The first location resolved for a terminal target stays fixed for that target. */
export function useInitialTerminalLaunchLocation(input: {
  readonly targetKey: string;
  readonly pendingLaunch: PendingTerminalLaunch | null;
  readonly isAuthenticated: boolean;
  readonly canRead: boolean;
  readonly canOperate: boolean;
  readonly hasLoadedSessions: boolean;
  readonly location: Parameters<typeof resolveTerminalOpenLocation>[0] | null;
}) {
  let candidate: TerminalLocationLike | null = null;
  if (input.location !== null && input.isAuthenticated && (input.canRead || input.canOperate)) {
    if (input.pendingLaunch !== null) {
      candidate = {
        cwd: input.pendingLaunch.cwd,
        worktreePath: input.pendingLaunch.worktreePath,
      };
    } else if (!input.canRead || input.hasLoadedSessions) {
      // Metadata must establish whether this target has a location before we retain a fallback.
      candidate = resolveTerminalOpenLocation(input.location);
    }
  }
  const [entry, setEntry] = useState(() => ({ key: input.targetKey, location: candidate }));
  if (entry.key !== input.targetKey || (entry.location === null && candidate !== null)) {
    setEntry({ key: input.targetKey, location: candidate });
    return candidate;
  }
  return entry.location;
}
