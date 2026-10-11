import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import * as Option from "effect/Option";
import { useMemo } from "react";
import { Pressable, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { vcsEnvironment } from "../../state/vcs";
import { worktreeBranchAgreement } from "./git/workspace-git-model";
import { workspaceFolderChipCount } from "./workspace-folders-model";
import { useEnvironmentServerConfig } from "../../state/entities";

export function WorkspaceFoldersChip(props: {
  readonly thread?: EnvironmentThreadShell;
  readonly project?: EnvironmentProject;
}) {
  const navigation = useNavigation();
  const enabled =
    useEnvironmentServerConfig(props.thread?.environmentId ?? props.project?.environmentId ?? null)
      ?.workspaceFileProjects === true;
  const count = workspaceFolderChipCount(props.thread ?? null, props.project ?? null);
  if (count < 2 || !enabled) return null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Workspace folders, ${count}`}
      hitSlop={10}
      className="flex-row items-center gap-1 px-2"
      onPress={(event) => {
        event.stopPropagation();
        if (props.thread)
          navigation.navigate("ThreadWorkspaceFolders", {
            environmentId: props.thread.environmentId,
            threadId: props.thread.id,
          });
        else if (props.project)
          navigation.navigate("ThreadWorkspaceFolders", {
            environmentId: props.project.environmentId,
            projectId: props.project.id,
          });
      }}
    >
      <SymbolView name="folder" size={12} tintColorClassName="accent-icon" />
      <Text className="text-xs">{count}</Text>
      <SymbolView name="chevron.down" size={9} tintColorClassName="accent-icon" />
    </Pressable>
  );
}

/** Mounted list cells lease only branch facts, never secondary remote status. */
export function WorkspaceBranchHint(props: {
  readonly thread: EnvironmentThreadShell;
  readonly active: boolean;
}) {
  const enabled =
    useEnvironmentServerConfig(props.thread.environmentId)?.workspaceFileProjects === true;
  if (!enabled || !props.active || !props.thread.worktrees || props.thread.worktrees.length < 2)
    return null;
  return <ActiveWorkspaceBranchHint thread={props.thread} members={props.thread.worktrees} />;
}

function ActiveWorkspaceBranchHint(props: {
  readonly thread: EnvironmentThreadShell;
  readonly members: NonNullable<EnvironmentThreadShell["worktrees"]>;
}) {
  const members = props.members;
  const statuses = useAtomValue(
    useMemo(
      () =>
        Atom.make((get) =>
          members.map((member, index) =>
            Option.getOrNull(
              AsyncResult.value(
                get(
                  vcsEnvironment.branchStatus({
                    environmentId: props.thread.environmentId,
                    input: {
                      cwd: index === 0 ? (props.thread.worktreePath ?? member.path) : member.path,
                    },
                  }),
                ),
              ),
            ),
          ),
        ),
      [members, props.thread.environmentId, props.thread.worktreePath],
    ),
  );
  const hint = worktreeBranchAgreement(members, statuses);
  if (!hint) return null;
  return (
    <View>
      <Text
        className={
          hint.drifted ? "text-xs text-warning-foreground" : "text-xs text-foreground-muted"
        }
      >
        · {hint.drifted ? hint.total - hint.agreed : hint.agreed}/{hint.total}
        {hint.drifted ? " drifted" : ""}
      </Text>
    </View>
  );
}
