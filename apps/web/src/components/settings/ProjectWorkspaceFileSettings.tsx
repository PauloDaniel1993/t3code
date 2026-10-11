import { listProjectsUsingFolder } from "@t3tools/client-runtime/operations/projects";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";
import { workspaceFileErrorMessage } from "../../hooks/useImportWorkspaceFile";
import { ensureBrowseDirectoryPath } from "../../lib/projectPaths";
import { readLocalApi } from "../../localApi";
import type { SidebarProjectGroupMember } from "../../sidebarProjectGrouping";
import { useEnvironments } from "../../state/environments";
import { useProjects } from "../../state/entities";
import { projectEnvironment } from "../../state/projects";
import { useAtomCommand } from "../../state/use-atom-command";
import { WorkspaceFilePickerDialog } from "../WorkspaceFilePickerDialog";
import { Button } from "../ui/button";
import { SettingsSection, SettingsRow } from "./settingsLayout";

export function ProjectWorkspaceFileSettings({
  project,
}: {
  readonly project: SidebarProjectGroupMember;
}) {
  const { environments } = useEnvironments();
  const environment = environments.find(
    (candidate) => candidate.environmentId === project.environmentId,
  );
  const connected = environment?.connection.phase === "connected";
  const enabled = environment?.serverConfig?.workspaceFileProjects === true;
  const projects = useProjects();
  const update = useAtomCommand(projectEnvironment.update, { reportFailure: false });
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const linked = project.workspaceFile != null;
  if (!linked && !enabled) return null;

  const changeLink = async (workspaceFilePath: string | null) => {
    setBusy(true);
    setError(null);
    try {
      const result = await update({
        environmentId: project.environmentId,
        input: { projectId: project.id, workspaceFilePath },
      });
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result))
          throw new Error("The workspace file update was interrupted. Try again.");
        throw squashAtomCommandFailure(result);
      }
    } finally {
      setBusy(false);
    }
  };
  const runChange = async (workspaceFilePath: string | null) => {
    try {
      await changeLink(workspaceFilePath);
    } catch (cause) {
      setError(workspaceFileErrorMessage(cause));
    }
  };
  const unlink = async () => {
    try {
      const api = readLocalApi();
      if (
        !api ||
        !(await api.dialogs.confirm(
          "Unlink workspace file?\nFuture threads use only the primary folder. Existing threads keep their folders, and conversation history is kept.",
        ))
      )
        return;
      await runChange(null);
    } catch (cause) {
      setError(workspaceFileErrorMessage(cause));
    }
  };
  const status = project.workspaceFileStatus;
  return (
    <>
      <SettingsSection
        title={`Workspace${project.environmentLabel ? ` · ${project.environmentLabel}` : ""}`}
      >
        <SettingsRow
          title={linked ? "Workspace file" : "Workspace folder"}
          description={project.workspaceFile ?? project.workspaceRoot}
          control={
            <div className="flex flex-wrap gap-2">
              {linked ? (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || !connected || !enabled}
                    onClick={() => void runChange(project.workspaceFile!)}
                  >
                    Refresh
                  </Button>
                  {enabled ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || !connected}
                      onClick={() => setPickerOpen(true)}
                    >
                      Relink…
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || !connected}
                    onClick={() => void unlink()}
                  >
                    Unlink workspace file
                  </Button>
                </>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || !connected}
                  onClick={() => setPickerOpen(true)}
                >
                  Link workspace file…
                </Button>
              )}
            </div>
          }
        />
        {linked ? (
          <div className="space-y-3 px-4 pb-4 text-sm">
            <p role="status">
              {status
                ? status.state === "ok"
                  ? "Up to date"
                  : `Workspace file ${status.state}`
                : "Checking workspace file…"}
              {status?.liveDetection === false
                ? " · Live detection unavailable. Refresh to check for changes."
                : ""}
            </p>
            {status?.diagnostics.map((diagnostic) => (
              <p
                key={`${diagnostic.code}:${diagnostic.entryIndex ?? ""}:${diagnostic.path ?? ""}:${diagnostic.message}`}
                role="alert"
                className="text-destructive"
              >
                {diagnostic.message}
              </p>
            ))}
            {status && status.state !== "ok" ? (
              <p className="text-muted-foreground">
                New threads are blocked until the file recovers. Refresh, relink, or unlink to
                recover.
              </p>
            ) : null}
            <ul className="space-y-2">
              {project.folders?.map((folder, index) => {
                const others = folder.path
                  ? listProjectsUsingFolder(
                      projects.filter(
                        (candidate) =>
                          candidate.environmentId === project.environmentId &&
                          candidate.id !== project.id,
                      ),
                      folder.path,
                    )
                  : [];
                return (
                  <li key={folder.path ?? folder.uri}>
                    <span className="font-medium">
                      {folder.name}
                      {index === 0 ? " · Primary" : ""}
                    </span>
                    <p className="break-all text-xs text-muted-foreground">
                      {folder.path ?? folder.uri}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {folder.uri
                        ? `Remote (${folder.remoteDescription ?? "remote folder"}), not available here`
                        : folder.availability === "unavailable"
                          ? index === 0
                            ? "Primary folder unavailable"
                            : `Unavailable (${folder.unavailableReason ?? "unknown"})`
                          : folder.availability === "available"
                            ? "Available"
                            : "Checking availability…"}
                    </p>
                    {others.length ? (
                      <p className="text-xs text-muted-foreground">
                        This folder is also used by {others.map((other) => other.title).join(", ")}
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="px-4 pb-4 text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </SettingsSection>
      {pickerOpen ? (
        <WorkspaceFilePickerDialog
          environmentId={project.environmentId}
          initialPath={project.workspaceFile ?? ensureBrowseDirectoryPath(project.workspaceRoot)}
          cwd={project.workspaceRoot}
          title={linked ? "Relink workspace file" : "Link workspace file"}
          onOpenChange={setPickerOpen}
          onSelect={changeLink}
        />
      ) : null}
    </>
  );
}
