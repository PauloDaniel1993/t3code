import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectId, ScopedProjectRef } from "@t3tools/contracts";
import { useState } from "react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useProjects } from "../state/entities";
import { projectEnvironment } from "../state/projects";
import { useAtomCommand } from "../state/use-atom-command";
import { useImportWorkspaceFile } from "../hooks/useImportWorkspaceFile";
import { WorkspaceFilePickerDialog } from "./WorkspaceFilePickerDialog";
import { Button } from "./ui/button";
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "./ui/select";

export function WorkspaceFileImportDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly initialPath?: string;
  readonly onOpenChange: (open: boolean) => void;
  readonly onImported: (ref: ScopedProjectRef) => void | Promise<void>;
}) {
  const importFile = useImportWorkspaceFile();
  const updateProject = useAtomCommand(projectEnvironment.update, { reportFailure: false });
  const plainProjects = useProjects().filter(
    (project) => project.environmentId === props.environmentId && project.workspaceFile == null,
  );
  const [linkExisting, setLinkExisting] = useState(false);
  const [linkProjectId, setLinkProjectId] = useState<ProjectId | null>(null);
  return (
    <WorkspaceFilePickerDialog
      {...props}
      title="Import workspace file"
      onSelect={async (path) => {
        let projectId: ProjectId;
        if (linkExisting) {
          const existing = plainProjects.find((project) => project.id === linkProjectId);
          if (!existing) throw new Error("Choose an existing project to link.");
          const result = await updateProject({
            environmentId: props.environmentId,
            input: { projectId: existing.id, workspaceFilePath: path },
          });
          if (result._tag === "Failure") throw squashAtomCommandFailure(result);
          projectId = existing.id;
        } else {
          projectId = await importFile(props.environmentId, path);
        }
        const ref = scopeProjectRef(props.environmentId, projectId);
        await props.onImported(ref);
      }}
    >
      {plainProjects.length ? (
        <div className="space-y-2">
          <Button size="sm" variant="link" onClick={() => setLinkExisting(!linkExisting)}>
            {linkExisting ? "Import as a new project instead" : "Link existing project instead"}
          </Button>
          {linkExisting ? (
            <>
              <p className="text-xs text-muted-foreground">
                The file must list this project's folder first. Its title, settings, and history are
                kept.
              </p>
              <Select
                value={linkProjectId}
                onValueChange={(value) =>
                  setLinkProjectId(
                    plainProjects.find((project) => project.id === value)?.id ?? null,
                  )
                }
              >
                <SelectTrigger size="sm" aria-label="Existing project to link">
                  <SelectValue>
                    {() =>
                      plainProjects.find((project) => project.id === linkProjectId)?.title ??
                      "Choose a project"
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {plainProjects.map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      {project.title} · {project.workspaceRoot}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </>
          ) : null}
        </div>
      ) : null}
    </WorkspaceFilePickerDialog>
  );
}
