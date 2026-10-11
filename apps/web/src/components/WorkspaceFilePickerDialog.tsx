import {
  filterFilesystemBrowseEntries,
  getFilesystemBrowsePath,
} from "@t3tools/client-runtime/state/filesystem";
import { resolveAddProjectPath } from "@t3tools/client-runtime/operations/projects";
import type { EnvironmentId } from "@t3tools/contracts";
import { FileIcon, FolderIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useWorkspaceFileNativePicker } from "../hooks/useWorkspaceFileNativePicker";
import { workspaceFileErrorMessage } from "../hooks/useImportWorkspaceFile";
import {
  appendBrowsePathSegment,
  getBrowseParentPath,
  hasTrailingPathSeparator,
} from "../lib/projectPaths";
import { useEnvironments } from "../state/environments";
import { filesystemEnvironment } from "../state/filesystem";
import { useEnvironmentQuery } from "../state/query";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "./ui/dialog";
import { Input } from "./ui/input";

export function WorkspaceFilePickerDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly initialPath?: string;
  readonly cwd?: string;
  readonly title: string;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSelect: (path: string) => Promise<void>;
  readonly children?: ReactNode;
}) {
  const { environments } = useEnvironments();
  const environment = environments.find(
    (candidate) => candidate.environmentId === props.environmentId,
  );
  const enabled =
    environment?.serverConfig?.workspaceFileProjects === true &&
    environment.connection.phase === "connected";
  const platform = environment?.serverConfig?.environment.platform.os ?? "";
  const [query, setQuery] = useState(props.initialPath ?? "~/");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pickNative = useWorkspaceFileNativePicker(props.environmentId);
  const browsePath = getFilesystemBrowsePath(query, platform, enabled);
  const browse = useEnvironmentQuery(
    browsePath.isBrowsing
      ? filesystemEnvironment.browse({
          environmentId: props.environmentId,
          input: {
            partialPath: browsePath.directoryPath,
            includeWorkspaceFiles: true,
            ...(props.cwd ? { cwd: props.cwd } : {}),
          },
        })
      : null,
  );
  const { visibleEntries, exactEntry } = filterFilesystemBrowseEntries(
    browse.data?.entries ?? [],
    browsePath.filterQuery,
  );
  const submit = async (rawPath: string) => {
    if (pending || !enabled) return;
    const resolved = resolveAddProjectPath({
      rawPath,
      platform,
      currentProjectCwd: props.cwd ?? null,
    });
    if (!resolved.ok) {
      setError(resolved.error);
      return;
    }
    setPending(true);
    setError(null);
    try {
      await props.onSelect(resolved.path);
      props.onOpenChange(false);
    } catch (cause) {
      setError(workspaceFileErrorMessage(cause));
    } finally {
      setPending(false);
    }
  };
  const chooseNative = async () => {
    if (!pickNative || pending) return;
    setPending(true);
    setError(null);
    let selected: string | null = null;
    try {
      selected = await pickNative(
        (browse.data?.parentPath ?? browsePath.directoryPath) || props.cwd || "~/",
      );
    } catch (cause) {
      setError(workspaceFileErrorMessage(cause));
    } finally {
      setPending(false);
    }
    if (selected) await submit(selected);
  };
  const selectedPath = !hasTrailingPathSeparator(query) ? (exactEntry?.fullPath ?? query) : query;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!pending) props.onOpenChange(open);
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{props.title}</DialogTitle>
          <DialogDescription>
            Choose a .code-workspace file on {environment?.label ?? "this environment"}. T3 reads
            its folders without changing the file.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 px-6 pb-4">
          <Input
            aria-label="Workspace file path"
            value={query}
            disabled={pending}
            onChange={(event) => {
              setQuery(event.target.value);
              setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void submit(selectedPath);
              }
            }}
          />
          <div className="max-h-64 space-y-1 overflow-y-auto">
            {browsePath.canBrowseUp ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={pending}
                onClick={() => setQuery(getBrowseParentPath(browsePath.directoryPath) ?? "~/")}
              >
                ..
              </Button>
            ) : null}
            {visibleEntries.map((entry) => (
              <div key={entry.fullPath}>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={pending}
                  onClick={() =>
                    entry.kind === "workspace-file"
                      ? void submit(entry.fullPath)
                      : setQuery(appendBrowsePathSegment(query, entry.name))
                  }
                >
                  {entry.kind === "workspace-file" ? <FileIcon /> : <FolderIcon />}
                  {entry.name}
                </Button>
              </div>
            ))}
            {browse.isPending ? (
              <p className="text-sm text-muted-foreground">Loading folders and workspace files…</p>
            ) : null}
          </div>
          {props.children ? <fieldset disabled={pending}>{props.children}</fieldset> : null}
          {error || browse.error ? (
            <p role="alert" className="text-sm text-destructive">
              {error ?? browse.error}
            </p>
          ) : null}
          {!enabled ? (
            <p role="alert" className="text-sm text-muted-foreground">
              Connect an environment with workspace-file projects enabled.
            </p>
          ) : null}
        </div>
        <DialogFooter>
          {pickNative && enabled ? (
            <Button variant="outline" disabled={pending} onClick={() => void chooseNative()}>
              Choose workspace file…
            </Button>
          ) : null}
          <Button variant="ghost" disabled={pending} onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={pending || !enabled || !query.trim()}
            onClick={() => void submit(selectedPath)}
          >
            {pending ? "Reading…" : "Use workspace file"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
