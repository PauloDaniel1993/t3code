import { T, useGT } from "gt-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { Suspense, lazy, useState } from "react";

import type { WorkspaceFileContext } from "../files/workspaceFiles";
import { Button } from "../ui/button";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { selectedStarMapFolder } from "./StarMapSurface.logic";

const StarMapPanel = lazy(() => import("./StarMapPanel"));

/**
 * The Map right-panel surface. The panel and its stylesheet load on first use, and it is
 * keyed by thread so each thread starts at its primary folder.
 */
export function StarMapSurface(props: {
  environmentId: EnvironmentId;
  cwd: string;
  workspace?: WorkspaceFileContext | undefined;
}) {
  const scope = props.workspace?.scope;
  return (
    <StarMapFolderSurface
      key={JSON.stringify([props.environmentId, scope?.projectId, scope?.threadId, props.cwd])}
      {...props}
    />
  );
}

function StarMapFolderSurface(props: Parameters<typeof StarMapSurface>[0]) {
  const gt = useGT();
  const [folderPath, setFolderPath] = useState<string | null>(null);
  const folder = selectedStarMapFolder(props.workspace, folderPath);
  if (folderPath !== null && (folder?.folder.path ?? folder?.folder.uri) !== folderPath) {
    setFolderPath(null);
  }
  const cwd = folder ? folder.effectivePath : props.cwd;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {props.workspace && props.workspace.folders.length > 1 ? (
        <div className="flex shrink-0 items-center border-b border-border/60 px-2 py-1">
          <Menu>
            <MenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="xs"
                  aria-label={gt("Wayfinder folder: {folder}", {
                    folder:
                      folder?.label ??
                      gt("Primary", { $context: "adjective, primary workspace folder" }),
                  })}
                />
              }
            >
              {folder?.label}
            </MenuTrigger>
            <MenuPopup align="start">
              <MenuRadioGroup
                value={folder?.folder.path ?? folder?.folder.uri ?? ""}
                onValueChange={setFolderPath}
              >
                {props.workspace.folders.map((entry) => (
                  <MenuRadioItem
                    key={entry.folder.path ?? entry.folder.uri}
                    value={entry.folder.path ?? entry.folder.uri!}
                    disabled={entry.effectivePath === null}
                  >
                    {entry.label}
                    {entry.isPrimary ? gt(" · Primary") : ""}
                    {entry.effectivePath === null ? gt(" · Unavailable") : ""}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuPopup>
          </Menu>
        </div>
      ) : null}
      {cwd === null ? (
        <p role="status" className="px-4 py-3 text-sm text-muted-foreground">
          <T>This workspace folder is unavailable.</T>
        </p>
      ) : (
        <Suspense fallback={null}>
          <StarMapPanel
            key={JSON.stringify([
              props.environmentId,
              folder?.folder.path ?? folder?.folder.uri,
              cwd,
            ])}
            environmentId={props.environmentId}
            cwd={cwd}
            workspace={props.workspace}
          />
        </Suspense>
      )}
    </div>
  );
}
