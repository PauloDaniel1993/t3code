import { msg, T, useGT } from "gt-react";
import { m } from "../../i18n/messages";
import { listProjectsUsingFolder } from "@t3tools/client-runtime/operations/projects";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";
import { workspaceFileErrorMessage } from "../../hooks/useImportWorkspaceFile";
import { ensureBrowseDirectoryPath } from "@t3tools/client-runtime/state/projects";
import { withAsyncCleanup } from "../../lib/withAsyncCleanup";
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
  const gt = useGT();
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
    await withAsyncCleanup(
      async () => {
        const result = await update({
          environmentId: project.environmentId,
          input: { projectId: project.id, workspaceFilePath },
        });
        if (result._tag === "Failure") {
          if (isAtomCommandInterrupted(result))
            throw new Error(m(msg("The workspace file update was interrupted. Try again.")));
          throw squashAtomCommandFailure(result);
        }
      },
      () => {
        setBusy(false);
      },
    );
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
          m(
            msg(
              "Unlink workspace file?\nFuture threads use only the primary folder. Existing threads keep their folders, and conversation history is kept.",
            ),
          ),
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
        title={
          project.environmentLabel
            ? gt("Workspace · {environment}", { environment: project.environmentLabel })
            : gt("Workspace")
        }
      >
        <SettingsRow
          title={linked ? gt("Workspace file") : gt("Workspace folder")}
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
                    <T>Refresh</T>
                  </Button>
                  {enabled ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || !connected}
                      onClick={() => setPickerOpen(true)}
                    >
                      <T>Relink…</T>
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || !connected}
                    onClick={() => void unlink()}
                  >
                    <T>Unlink workspace file</T>
                  </Button>
                </>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || !connected}
                  onClick={() => setPickerOpen(true)}
                >
                  <T>Link workspace file…</T>
                </Button>
              )}
            </div>
          }
        />
        {linked ? (
          <div className="space-y-3 px-4 pb-4 text-sm">
            <p role="status">
              {!enabled
                ? gt("Workspace-file support is disabled on this environment.")
                : status
                  ? status.state === "ok"
                    ? gt("Up to date")
                    : gt("Workspace file {state}", { state: status.state })
                  : gt("Checking workspace file…")}
              {status?.liveDetection === false
                ? gt(" · Live detection unavailable. Refresh to check for changes.")
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
                <T>
                  New threads are blocked until the file recovers. Refresh, relink, or unlink to
                  recover.
                </T>
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
                      {index === 0 ? gt(" · Primary") : ""}
                    </span>
                    <p className="break-all text-xs text-muted-foreground">
                      {folder.path ?? folder.uri}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {!enabled
                        ? gt("Availability checks are disabled")
                        : folder.uri
                          ? gt("Remote ({description}), not available here", {
                              description: folder.remoteDescription ?? gt("remote folder"),
                            })
                          : folder.availability === "unavailable"
                            ? index === 0
                              ? gt("Primary folder unavailable")
                              : folder.unavailableReason === "missing"
                                ? gt("Missing on disk")
                                : folder.unavailableReason === "not-directory"
                                  ? gt("Not a folder on disk")
                                  : gt("Unavailable")
                            : folder.availability === "available"
                              ? gt("Available")
                              : gt("Checking availability…")}
                    </p>
                    {others.length ? (
                      <p className="text-xs text-muted-foreground">
                        {gt("This folder is also used by {projects}", {
                          projects: others.map((other) => other.title).join(", "),
                        })}
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
          title={linked ? gt("Relink workspace file") : gt("Link workspace file")}
          onOpenChange={setPickerOpen}
          onSelect={changeLink}
        />
      ) : null}
    </>
  );
}
