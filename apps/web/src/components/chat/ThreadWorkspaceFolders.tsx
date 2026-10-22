import type { EditorId, EnvironmentId, ResolvedKeybindingsConfig } from "@t3tools/contracts";
import type { WorkspaceThread } from "@t3tools/shared/workspaceFolders";
import { useState } from "react";
import { withAsyncCleanup } from "../../lib/withAsyncCleanup";
import { useAtomCommand } from "../../state/use-atom-command";
import { projectEnvironment } from "../../state/projects";
import { WorkspaceFolderGroups } from "../WorkspaceFolderGroups";
import {
  workspaceAvailabilityPending,
  workspaceSnapshotChanged,
  type WorkspaceFolderRow,
  type WorkspaceFoldersProject,
} from "../workspaceFolders.logic";
import { Button, InlineButton } from "../ui/button";
import { Input } from "../ui/input";

export function ThreadWorkspaceFolders(props: {
  environmentId: EnvironmentId;
  project: WorkspaceFoldersProject;
  thread: WorkspaceThread | null;
  rows: ReadonlyArray<WorkspaceFolderRow>;
  unavailableFolderPaths?: ReadonlyArray<string> | undefined;
  availableEditors: ReadonlyArray<EditorId>;
  keybindings: ResolvedKeybindingsConfig;
  onShowChanges?: ((folder: WorkspaceFolderRow) => void) | undefined;
  onOpenTerminalHere?: ((folderPath: string) => void) | undefined;
}) {
  const rows = props.rows;
  return (
    <>
      <WorkspaceFolderGroups {...props} rows={rows} />
      {rows[0]?.unavailable ? (
        <p className="mx-2 my-2 rounded-lg border border-warning/30 p-2 text-2xs text-warning">
          The primary folder is unavailable. This thread cannot start a turn until it is available
          again.
        </p>
      ) : null}
      {props.thread && workspaceSnapshotChanged(props.project, props.thread) ? (
        <p className="px-2 py-1 text-2xs text-muted-foreground">
          This thread keeps the folders it started with. Start a new thread to use the updated
          workspace.
        </p>
      ) : null}
      {workspaceAvailabilityPending(rows, props.unavailableFolderPaths) ? (
        <p className="px-2 py-1 text-2xs text-warning">
          Folder availability changed; applies on the next turn
        </p>
      ) : null}
      {props.project.workspaceFile &&
      props.project.workspaceFileStatus &&
      props.project.workspaceFileStatus.state !== "ok" ? (
        <WorkspaceFileRecovery
          key={props.project.workspaceFile}
          environmentId={props.environmentId}
          project={props.project}
        />
      ) : null}
    </>
  );
}

function WorkspaceFileRecovery({
  environmentId,
  project,
}: {
  environmentId: EnvironmentId;
  project: WorkspaceFoldersProject;
}) {
  const update = useAtomCommand(projectEnvironment.update, "update workspace file");
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"relink" | "unlink" | null>(null);
  const [path, setPath] = useState(project.workspaceFile ?? "");
  const mutate = async (workspaceFilePath: string | null) => {
    if (busy) return;
    setBusy(true);
    await withAsyncCleanup(
      async () => {
        const result = await update({
          environmentId,
          input: { projectId: project.id, workspaceFilePath },
        });
        if (result._tag === "Success") setMode(null);
      },
      () => {
        setBusy(false);
      },
    );
  };
  return (
    <div className="mx-2 my-2 rounded-lg border border-warning/30 p-2 text-2xs">
      <p className="font-medium text-warning">
        Workspace file {project.workspaceFileStatus?.state}
      </p>
      <p className="mt-1 text-muted-foreground">
        {project.workspaceFileStatus?.diagnostics[0]?.message}
      </p>
      <div className="mt-2 flex gap-3">
        <InlineButton
          disabled={busy}
          onClick={() => {
            if (project.workspaceFile) void mutate(project.workspaceFile);
          }}
        >
          Refresh
        </InlineButton>
        <InlineButton disabled={busy} onClick={() => setMode("relink")}>
          Relink…
        </InlineButton>
        <InlineButton disabled={busy} onClick={() => setMode("unlink")}>
          Unlink
        </InlineButton>
      </div>
      {mode === "relink" ? (
        <form
          className="mt-2 flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (path.trim()) void mutate(path.trim());
          }}
        >
          <Input
            aria-label="Workspace file path on this environment"
            value={path}
            disabled={busy}
            onChange={(event) => setPath(event.target.value)}
          />
          <p className="text-muted-foreground">
            Enter the workspace file path on this environment.
          </p>
          <div className="flex gap-2">
            <Button size="xs" type="submit" disabled={busy || !path.trim()}>
              Relink workspace file
            </Button>
            <Button size="xs" variant="ghost" disabled={busy} onClick={() => setMode(null)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
      {mode === "unlink" ? (
        <div className="mt-2 flex flex-col gap-2">
          <p>
            Future threads use only the primary folder. Existing threads keep their folders, and
            history is kept.
          </p>
          <div className="flex gap-2">
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={busy}
              onClick={() => void mutate(null)}
            >
              Unlink workspace file
            </Button>
            <Button size="xs" variant="ghost" disabled={busy} onClick={() => setMode(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
