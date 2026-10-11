import type { ProjectId, ProjectScript, ServerSettings } from "@t3tools/contracts";
import {
  isSamePath,
  projectFolders,
  resolveThreadWorkspace,
  type WorkspaceProject,
  type WorkspaceThread,
} from "./workspaceFolders.ts";

type ProjectScriptSettings = Pick<
  ServerSettings,
  | "defaultProjectScripts"
  | "projectScriptOverrides"
  | "projectSettingsOverrides"
  | "projectSettingsFolded"
>;

/**
 * The project's override wins, then environment defaults. Until the legacy
 * fields have been folded into `projectSettingsOverrides`, the old map (null
 * there meant "reset to machine defaults") and the aggregate's own scripts
 * still count, so a server that has not run the fold yet behaves as before.
 */
export function resolveProjectScripts(
  settings: ProjectScriptSettings,
  project: { id: ProjectId; scripts: readonly ProjectScript[] },
): readonly ProjectScript[] {
  const override = settings.projectSettingsOverrides[project.id]?.defaultProjectScripts;
  if (override !== undefined) return override;
  if (settings.projectSettingsFolded) return settings.defaultProjectScripts;
  const legacy = settings.projectScriptOverrides[project.id];
  if (legacy === null) return settings.defaultProjectScripts;
  return legacy ?? (project.scripts.length > 0 ? project.scripts : settings.defaultProjectScripts);
}

export function projectScriptsInheritDefaults(
  settings: ProjectScriptSettings,
  project: { id: ProjectId; scripts: readonly ProjectScript[] },
): boolean {
  if (settings.projectSettingsOverrides[project.id]?.defaultProjectScripts !== undefined) {
    return false;
  }
  if (settings.projectSettingsFolded) return true;
  const legacy = settings.projectScriptOverrides[project.id];
  return legacy === null || (legacy === undefined && project.scripts.length === 0);
}

interface ProjectScriptLocationInput {
  project: {
    cwd: string;
    folders?: WorkspaceProject["folders"];
  };
  thread?: WorkspaceThread | undefined;
  worktreePath?: string | null;
  folderPath?: string | null | undefined;
  unavailableFolderPaths?: ReadonlyArray<string> | undefined;
}

interface ProjectScriptRuntimeEnvInput extends ProjectScriptLocationInput {
  extraEnv?: Record<string, string>;
}

function projectScriptFolder(input: ProjectScriptLocationInput) {
  const project = { workspaceRoot: input.project.cwd, folders: input.project.folders };
  const thread = input.thread ?? {
    worktreePath: input.worktreePath ?? null,
    workspaceFolders: projectFolders(project),
  };
  const workspace = resolveThreadWorkspace({
    project,
    thread:
      input.worktreePath === undefined ? thread : { ...thread, worktreePath: input.worktreePath },
    unavailableFolderPaths: input.unavailableFolderPaths,
  });
  const folder =
    input.folderPath == null
      ? workspace.folders[0]
      : workspace.folders.find(
          (candidate) =>
            candidate.folder.path !== undefined &&
            isSamePath(candidate.folder.path, input.folderPath!),
        );
  if (!folder) throw new Error(`Workspace folder is not part of this thread: ${input.folderPath}`);
  if (folder.effectivePath === null) {
    throw new Error(`Workspace folder is unavailable: ${folder.folder.path ?? folder.folder.uri}`);
  }
  return { ...folder, effectivePath: folder.effectivePath };
}

/** Map an Action's original folder identity through the thread's frozen workspace. */
export function projectScriptCwd(input: ProjectScriptLocationInput): string {
  return projectScriptFolder(input).effectivePath;
}

export function projectScriptRuntimeEnv(
  input: ProjectScriptRuntimeEnvInput,
): Record<string, string> {
  const folder = projectScriptFolder(input);
  const env: Record<string, string> = {
    T3CODE_PROJECT_ROOT:
      input.folderPath == null
        ? (input.thread?.workspaceFolders?.[0]?.path ??
          input.thread?.workspacePrimaryPath ??
          input.project.cwd)
        : (folder.folder.path ?? input.project.cwd),
  };
  const worktreePath =
    input.worktreePath === undefined ? input.thread?.worktreePath : input.worktreePath;
  if (input.folderPath != null || worktreePath) {
    env.T3CODE_WORKTREE_PATH = folder.effectivePath;
  }
  if (input.extraEnv) {
    return { ...env, ...input.extraEnv };
  }
  return env;
}

export function setupProjectScript(scripts: readonly ProjectScript[]): ProjectScript | null {
  return scripts.find((script) => script.runOnWorktreeCreate) ?? null;
}
