import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  AuthTerminalOperateScope,
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";
import { owningFolder } from "@t3tools/shared/workspaceFolders";
import { useState } from "react";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { ControlPillMenu } from "../../components/ControlPill";
import { AndroidSheetHeader } from "../../components/AndroidScreenHeader";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { uuidv4 } from "../../lib/uuid";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentPresentation } from "../../state/presentation";
import { projectEnvironmentPresentation } from "../../state/environments";
import { useThreadWorkspace } from "./use-thread-workspace";
import { useProject } from "../../state/entities";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { vcsEnvironment } from "../../state/vcs";
import { ProjectWorkspaceFileSettings } from "../settings/ProjectWorkspaceFileSettings";
import {
  resolveTerminalOpenLocation,
  stagePendingTerminalLaunch,
} from "../terminal/terminalLaunchContext";
import { SheetListRow } from "./git/gitSheetComponents";
import {
  workspaceAvailabilityPending,
  workspaceRepositoryCount,
  workspaceSnapshotChanged,
  workspaceFolderRows,
  type WorkspaceFolderRow,
} from "./workspace-folders-model";

function FolderRow(props: {
  readonly target: { readonly environmentId: EnvironmentId; readonly threadId?: ThreadId };
  readonly row: WorkspaceFolderRow;
  readonly onTerminal?: () => void;
  readonly statusCwd?: string;
}) {
  const { row, target } = props;
  const navigation = useNavigation();
  const [pathVisible, setPathVisible] = useState(false);
  const status = useEnvironmentQuery(
    row.isGit && row.effectivePath
      ? vcsEnvironment.branchStatus({
          environmentId: target.environmentId,
          input: { cwd: props.statusCwd ?? row.effectivePath },
        })
      : null,
  );
  const subtitle = row.unavailable
    ? `${row.reason} · skipped`
    : row.isGit
      ? `${status.data ? (status.data.isRepo ? (status.data.refName ?? "Detached HEAD") : "Repository status unavailable") : status.error ? "Repository status unavailable" : "Loading branch…"} · ${row.isWorktree ? "Worktree" : "Current checkout"}`
      : "Shared · not checkpointed";
  return (
    <View className="ml-4 border-l border-border pl-3 py-2">
      <View className="flex-row items-center gap-2">
        <Pressable
          className="min-h-11 flex-1 justify-center"
          accessibilityRole="button"
          accessibilityLabel={`${row.folder.name}, show path`}
          accessibilityState={{ expanded: pathVisible }}
          onPress={() => setPathVisible(!pathVisible)}
        >
          <Text className="font-t3-medium">
            {row.folder.name}
            {row.isPrimary ? " · Primary" : ""}
          </Text>
          <Text
            className={
              row.unavailable ? "text-xs text-warning-foreground" : "text-xs text-foreground-muted"
            }
          >
            {subtitle}
          </Text>
        </Pressable>
        <ControlPillMenu
          title={row.folder.name}
          actions={[
            { id: "copy", title: "Copy path" },
            {
              id: "changes",
              title: "Show changes for this folder",
              attributes: { disabled: !row.isGit || !target.threadId },
            },
            {
              id: "terminal",
              title: "Open terminal here",
              attributes: { disabled: row.effectivePath === null || !props.onTerminal },
            },
          ]}
          onPressAction={({ nativeEvent }) => {
            if (nativeEvent.event === "copy") void copyTextWithHaptic(row.path);
            if (nativeEvent.event === "terminal") props.onTerminal?.();
            if (nativeEvent.event === "changes" && target.threadId)
              navigation.dispatch(
                StackActions.replace("WorkspaceChanges", {
                  environmentId: target.environmentId,
                  threadId: target.threadId,
                  folderPath: row.folder.path,
                }),
              );
          }}
        >
          <View
            accessibilityLabel={`Actions for ${row.folder.name}`}
            className="size-11 items-center justify-center"
          >
            <SymbolView name="ellipsis" size={18} tintColorClassName="accent-icon" />
          </View>
        </ControlPillMenu>
      </View>
      {pathVisible ? (
        <Text selectable className="text-xs text-foreground-secondary">
          {row.path}
        </Text>
      ) : null}
    </View>
  );
}

export function ThreadWorkspaceFolders(props: {
  readonly target: ScopedThreadRef;
  readonly showEnvironmentMode?: boolean;
}) {
  const workspace = useThreadWorkspace(props.target);
  const navigation = useNavigation();
  const environment = useEnvironmentPresentation(props.target.environmentId).presentation;
  const canOperateTerminal = useEnvironmentScope(
    props.target.environmentId,
    AuthTerminalOperateScope,
  );
  const [gitExpanded, setGitExpanded] = useState(true);
  const [otherExpanded, setOtherExpanded] = useState(true);
  if (environment?.serverConfig?.workspaceFileProjects !== true) return null;
  if (
    props.showEnvironmentMode !== false &&
    workspace.project &&
    !workspace.project.workspaceFile &&
    (workspace.shell?.workspaceFolderCount ?? 1) < 2
  )
    return null;
  if (!workspace.project || !workspace.thread)
    return <Text className="p-4 text-foreground-muted">Loading workspace folders…</Text>;
  const { project, thread, rows } = workspace;
  if (props.showEnvironmentMode !== false && !project.workspaceFile && !thread.workspaceFolders)
    return null;
  const repoCount = workspaceRepositoryCount(rows);
  const openTerminal = (row: WorkspaceFolderRow) => {
    if (
      !row.effectivePath ||
      !row.folder.path ||
      !readEnvironmentScope(props.target.environmentId, AuthTerminalOperateScope)
    )
      return;
    const terminalId = `workspace-${uuidv4()}`;
    const location = resolveTerminalOpenLocation({
      terminalLocation: null,
      activeSessionLocation: null,
      workspaceRoot: project.workspaceRoot,
      thread,
      folderPath: row.folder.path,
      threadShellWorktreePath: thread.worktreePath,
      threadDetailWorktreePath: thread.worktreePath,
    });
    stagePendingTerminalLaunch({
      target: { ...props.target, terminalId },
      launch: {
        ...location,
        env: projectScriptRuntimeEnv({
          project: { cwd: project.workspaceRoot },
          thread,
          folderPath: row.folder.path,
        }),
      },
    });
    navigation.dispatch(StackActions.replace("ThreadTerminal", { ...props.target, terminalId }));
  };
  return (
    <View className="gap-2 p-4">
      {props.showEnvironmentMode !== false ? (
        <>
          <Text accessibilityRole="header" className="font-t3-semibold">
            Workspace
          </Text>
          <SheetListRow
            icon="folder"
            title={`${thread.worktreePath ? "Worktree" : "Current checkout"} · ${repoCount} ${repoCount === 1 ? "repo" : "repos"}`}
            subtitle={
              !rows[0]?.isGit
                ? "The primary folder is not a Git repository; worktree mode is unavailable."
                : "Branches and workspace mode"
            }
            disabled={!rows[0]?.isGit}
            onPress={() => navigation.navigate("GitBranches", props.target)}
          />
        </>
      ) : (
        <>
          <Text accessibilityRole="header" className="text-xl font-t3-semibold">
            Workspace folders
          </Text>
          <Text className="text-sm text-foreground-muted">
            {rows.length} folders · primary folder starts the thread
          </Text>
        </>
      )}
      {([true, false] as const).map((git) => {
        const group = rows.filter((row) => row.isGit === git);
        const expanded = git ? gitExpanded : otherExpanded;
        return (
          <View key={String(git)}>
            <Pressable
              className="min-h-11 flex-row items-center justify-between"
              accessibilityRole="button"
              accessibilityState={{ expanded }}
              onPress={() =>
                git ? setGitExpanded(!gitExpanded) : setOtherExpanded(!otherExpanded)
              }
            >
              <Text className="font-t3-medium">
                {git ? "Git repositories" : "Other folders"} · {group.length}
              </Text>
              <SymbolView
                name={expanded ? "chevron.up" : "chevron.down"}
                size={12}
                tintColorClassName="accent-icon"
              />
            </Pressable>
            {expanded
              ? group.map((row) => (
                  <FolderRow
                    key={row.label}
                    target={props.target}
                    row={row}
                    statusCwd={
                      owningFolder(
                        row.diffPath ?? row.effectivePath ?? "",
                        workspace.checkouts.map((checkout) => ({
                          path: checkout.root,
                          cwd: checkout.cwd,
                        })),
                      )?.cwd
                    }
                    onTerminal={canOperateTerminal ? () => openTerminal(row) : undefined}
                  />
                ))
              : null}
          </View>
        );
      })}
      {rows[0]?.unavailable ? (
        <Text className="text-sm text-warning-foreground">
          Primary folder unavailable. This thread cannot start a turn until it is available again.
        </Text>
      ) : null}
      {workspaceSnapshotChanged(project, thread) ? (
        <Text className="text-sm text-foreground-muted">
          This thread keeps the folders it started with. Start a new thread to use the updated
          workspace.
        </Text>
      ) : null}
      {workspaceAvailabilityPending(rows, workspace.unavailableFolderPaths) ? (
        <Text className="text-sm text-warning-foreground">
          Folder availability changed; applies on the next turn
        </Text>
      ) : null}
      {project.workspaceFileStatus &&
      project.workspaceFileStatus.state !== "ok" &&
      environment?.serverConfig ? (
        <ProjectWorkspaceFileSettings
          project={project}
          environment={{
            ...projectEnvironmentPresentation(props.target.environmentId, environment),
            serverConfig: environment.serverConfig,
          }}
        />
      ) : null}
    </View>
  );
}

function DraftWorkspaceFolders(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}) {
  const project = useProject(props);
  const [gitExpanded, setGitExpanded] = useState(true);
  const [otherExpanded, setOtherExpanded] = useState(true);
  const rows = project ? workspaceFolderRows(project, null) : [];
  return (
    <View className="p-4">
      <Text accessibilityRole="header" className="text-xl font-t3-semibold">
        Workspace folders
      </Text>
      <Text className="py-2 text-sm text-foreground-muted">
        {rows.length} folders · primary folder starts the thread
      </Text>
      {([true, false] as const).map((git) => {
        const group = rows.filter((row) => row.isGit === git);
        const expanded = git ? gitExpanded : otherExpanded;
        return (
          <View key={String(git)}>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded }}
              className="min-h-11 justify-center"
              onPress={() =>
                git ? setGitExpanded(!gitExpanded) : setOtherExpanded(!otherExpanded)
              }
            >
              <Text className="font-t3-medium">
                {expanded ? "⌃" : "⌄"} {git ? "Git repositories" : "Other folders"} · {group.length}
              </Text>
            </Pressable>
            {expanded
              ? group.map((row) => (
                  <FolderRow
                    key={row.label}
                    target={props}
                    row={row}
                    statusCwd={
                      rows.find(
                        (candidate) =>
                          candidate.isGit && candidate.checkoutRoot === row.checkoutRoot,
                      )?.effectivePath ?? undefined
                    }
                  />
                ))
              : null}
          </View>
        );
      })}
    </View>
  );
}

export function ThreadWorkspaceFoldersSheet({
  route,
}: StaticScreenProps<{
  readonly environmentId: EnvironmentId;
  readonly threadId?: ThreadId;
  readonly projectId?: ProjectId;
}>) {
  const navigation = useNavigation();
  return (
    <View className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <AndroidSheetHeader title="Workspace folders" onBack={() => navigation.goBack()} />
      ) : null}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingBottom: 32 }}
      >
        {route.params.threadId ? (
          <ThreadWorkspaceFolders
            target={{ environmentId: route.params.environmentId, threadId: route.params.threadId }}
            showEnvironmentMode={false}
          />
        ) : route.params.projectId ? (
          <DraftWorkspaceFolders
            environmentId={route.params.environmentId}
            projectId={route.params.projectId}
          />
        ) : null}
      </ScrollView>
    </View>
  );
}
