import { projectScriptCwd, projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";
import {
  isSamePath,
  resolveThreadWorkspace,
  type WorkspaceProject,
  type WorkspaceThread,
} from "@t3tools/shared/workspaceFolders";

export interface TerminalLaunchLocation {
  readonly cwd: string;
  readonly worktreePath: string | null;
  readonly runtimeEnv: Record<string, string>;
}

/** Keep a terminal's location and environment independent of other folder launches. */
export function resolveTerminalLaunchLocation(input: {
  readonly project: WorkspaceProject;
  readonly thread: WorkspaceThread;
  readonly terminalId: string;
  readonly summary?: Pick<TerminalLaunchLocation, "cwd" | "worktreePath"> | null;
  readonly pending?: (TerminalLaunchLocation & { readonly terminalId: string }) | null;
}): TerminalLaunchLocation {
  const { project, thread, summary } = input;
  const pending = input.pending?.terminalId === input.terminalId ? input.pending : null;
  if (!summary && pending) return pending;
  const location = {
    project: { cwd: project.workspaceRoot, folders: project.folders },
    thread,
    worktreePath: summary ? summary.worktreePath : thread.worktreePath,
  };
  if (!summary) {
    return {
      cwd: projectScriptCwd(location),
      worktreePath: thread.worktreePath,
      runtimeEnv: projectScriptRuntimeEnv(location),
    };
  }
  if (
    pending &&
    isSamePath(summary.cwd, pending.cwd) &&
    summary.worktreePath === pending.worktreePath
  ) {
    return { ...summary, runtimeEnv: pending.runtimeEnv };
  }
  const folder = resolveThreadWorkspace({ project, thread })
    .folders.slice(1)
    .find(
      (candidate) =>
        candidate.effectivePath !== null && isSamePath(candidate.effectivePath, summary.cwd),
    );
  return {
    ...summary,
    runtimeEnv: projectScriptRuntimeEnv({ ...location, folderPath: folder?.folder.path }),
  };
}
