import { CommonActions, StackActions, useNavigation } from "@react-navigation/native";
import { useAtomValue } from "@effect/atom-react";
import type { ScopedThreadRef, VcsStatusResult } from "@t3tools/contracts";
import {
  workspaceActionOutcomeSummary,
  workspaceActionState,
} from "@t3tools/client-runtime/state/vcs";
import { threadPrimaryPath, type WorkspaceGitCheckout } from "@t3tools/shared/workspaceFolders";
import { use, useMemo, useState } from "react";
import { Atom } from "effect/reactivity";
import { Alert, Pressable, View } from "react-native";
import * as Cause from "effect/Cause";
import { msg, T, useGT, useMessages } from "gt-react-native";
import { m } from "../../../i18n/messages";
import { AppText as Text, AppTextInput } from "../../../components/ui/AppText";
import { Button } from "../../../components/ui/Button";
import { AppBar } from "../../../components/ui/AppBar";
import { SheetPane } from "../../../components/ui/SheetPane";
import { ScreenContent } from "../../../components/ui/ScreenContent";
import { NativeScrollView } from "../../../native/NativeScrollViewMarker";
import { tryOpenExternalUrl } from "../../../lib/openExternalUrl";
import { uuidv4 } from "../../../lib/uuid";
import { useThreadWorkspace, useWorkspaceGitQueries } from "../use-thread-workspace";
import { useAtomCommand } from "../../../state/use-atom-command";
import { useVcsActionState } from "../../../state/use-vcs-action-state";
import { vcsActionManager, vcsEnvironment, workspaceVcs } from "../../../state/vcs";
import { appAtomRegistry } from "../../../state/atom-registry";
import { filesystemEnvironment } from "../../../state/filesystem";
import { useEnvironmentQuery } from "../../../state/query";
import { InspectorSheetContext } from "../../layout/workspace-inspector-sheet";
import { ThreadRepositoryRows } from "./ThreadRepositoryRows";
import { workspaceGitSummary } from "./workspace-git-model";
import { ListRow } from "../../../components/ui/ListRow";
import { ListSection } from "../../../components/ui/ListSection";
import { useRemoteEnvironmentRuntime } from "../../../state/use-remote-environment-registry";
import { useOpenPullRequest } from "../../../native/useOpenPullRequest";
import {
  LinkedPullRequestRow,
  linkedPullRequestKey,
  useLinkedPullRequestLines,
} from "../LinkedPullRequestList";
import { useLinkedPullRequestActions } from "../useLinkedPullRequestActions";

function reportFailure(result: { readonly _tag: string; readonly cause?: Cause.Cause<unknown> }) {
  if (result._tag === "Failure" && result.cause) {
    const error = Cause.squash(result.cause);
    Alert.alert(
      m(msg("Git action failed")),
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function finishWorkspaceAction(action: () => Promise<void>, onSettled: () => void) {
  try {
    await action();
  } finally {
    onSettled();
  }
}

function RepositoryControls(props: {
  readonly target: ScopedThreadRef;
  readonly checkout: WorkspaceGitCheckout;
  readonly status: VcsStatusResult | null;
  readonly drifted: boolean;
  readonly batchBusy: boolean;
  readonly primary: boolean;
}) {
  const navigation = useNavigation();
  const gt = useGT();
  const { checkout, status } = props;
  const actionPermission = workspaceVcs.runAction.permissionAtom(props.target.environmentId);
  const branchPermission = workspaceVcs.switchBranch.permissionAtom(props.target.environmentId);
  const canRunAction = useAtomValue(actionPermission);
  const canSwitchBranch = useAtomValue(branchPermission);
  const run = useAtomCommand(
    vcsActionManager.runStackedAction({
      environmentId: props.target.environmentId,
      cwd: checkout.cwd,
    }),
    { reportFailure: false },
  );
  const switchBack = useAtomCommand(workspaceVcs.switchBranch, {
    reportFailure: false,
  });
  const refresh = useAtomCommand(vcsEnvironment.refreshStatus, { reportFailure: false });
  const actionState = useVcsActionState({
    environmentId: props.target.environmentId,
    cwd: checkout.cwd,
  });
  const [commitOpen, setCommitOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [switching, setSwitching] = useState(false);
  const busy = props.batchBusy || actionState.isRunning || switching;
  const runAction = async (action: "commit" | "push" | "create_pr") => {
    const execute = async () => {
      if (!appAtomRegistry.get(actionPermission)) return;
      const result = await run({
        actionId: uuidv4(),
        action,
        threadId: props.target.threadId,
        ...(action === "commit" && message.trim() ? { commitMessage: message.trim() } : {}),
      });
      reportFailure(result);
      if (result._tag === "Success") {
        setCommitOpen(false);
        Alert.alert(result.value.toast.title, result.value.toast.description);
        if (result.value.toast.cta.kind === "open_pr")
          void tryOpenExternalUrl(result.value.toast.cta.url, "pull-request");
      }
    };
    if (status?.isDefaultRef && action !== "commit")
      Alert.alert(
        gt("Default branch"),
        action === "push"
          ? gt("Run push on {branch}?", { branch: String(status.refName) })
          : gt("Run Create PR on {branch}?", { branch: String(status.refName) }),
        [
          { text: gt("Cancel"), style: "cancel" },
          { text: gt("Continue"), onPress: () => void execute() },
        ],
      );
    else await execute();
  };
  return (
    <View className="gap-2 border-t border-border py-3">
      <Text className="font-t3-semibold">{checkout.label}</Text>
      <Text
        className={
          props.drifted ? "text-sm text-warning-foreground" : "text-sm text-foreground-muted"
        }
      >
        {gt(
          "{status} · {drift, select, drifted {drifted · } other {}}{count} files changed · +{insertions}/−{deletions}",
          {
            status: status?.refName ?? gt("Status unavailable"),
            drift: props.drifted ? "drifted" : "current",
            count: status?.workingTree.files.length ?? 0,
            insertions: status?.workingTree.insertions ?? 0,
            deletions: status?.workingTree.deletions ?? 0,
          },
        )}
      </Text>
      <Text selectable className="text-xs text-foreground-muted">
        {checkout.cwd}
      </Text>
      {actionState.isRunning ? <Text className="text-sm">{actionState.currentLabel}</Text> : null}
      {props.drifted && checkout.expectedBranch ? (
        <Button
          label={gt("Switch back to {branch}", { branch: checkout.expectedBranch })}
          disabled={busy || !canSwitchBranch}
          onPress={() => {
            if (!appAtomRegistry.get(branchPermission)) return;
            setSwitching(true);
            void vcsActionManager
              .track(
                appAtomRegistry,
                { environmentId: props.target.environmentId, cwd: checkout.cwd },
                { operation: "switch_ref", label: gt("Switching back") },
                () =>
                  switchBack({
                    environmentId: props.target.environmentId,
                    cwds: [checkout.cwd],
                    input: {
                      threadId: props.target.threadId,
                      branch: checkout.expectedBranch!,
                      members: [checkout.repositoryRoot],
                    },
                  }),
              )
              .then(async (result) => {
                reportFailure(result);
                await refresh({
                  environmentId: props.target.environmentId,
                  input: { cwd: checkout.cwd },
                });
              })
              .finally(() => setSwitching(false));
          }}
        />
      ) : null}
      <View className="flex-row flex-wrap gap-2">
        <Button
          label={gt("Commit", { $context: "verb, commit Git changes" })}
          disabled={busy || !canRunAction || !status?.hasWorkingTreeChanges}
          onPress={() =>
            props.primary
              ? navigation.navigate("GitCommit", props.target)
              : setCommitOpen(!commitOpen)
          }
        />
        <Button
          label={gt("Push", { $context: "verb, upload Git commits to a remote" })}
          disabled={busy || !canRunAction || !status?.hasPrimaryRemote || !status.refName}
          onPress={() => void runAction("push")}
        />
        <Button
          label={
            status?.pr?.state === "open"
              ? gt("PR #{number}", { number: status.pr.number })
              : gt("Create PR")
          }
          disabled={
            busy ||
            (status?.pr?.state !== "open" && !canRunAction) ||
            !status?.hasPrimaryRemote ||
            !status.refName
          }
          onPress={() =>
            status?.pr?.state === "open"
              ? void tryOpenExternalUrl(status.pr.url, "pull-request")
              : void runAction("create_pr")
          }
        />
      </View>
      {commitOpen ? (
        <View className="gap-2">
          <AppTextInput
            accessibilityLabel={gt("Commit message for {repository}", {
              repository: checkout.label,
            })}
            className="min-h-12 rounded-xl bg-input px-3 text-foreground"
            value={message}
            placeholder={gt("Leave empty to auto-generate")}
            onChangeText={setMessage}
            editable={!busy}
          />
          <Button
            label={gt("Commit {repository}", { repository: checkout.label })}
            disabled={busy || !canRunAction}
            onPress={() => void runAction("commit")}
          />
        </View>
      ) : null}
    </View>
  );
}

function PrimaryRepositoryTools(props: {
  readonly target: ScopedThreadRef;
  readonly checkout: WorkspaceGitCheckout;
  readonly status: VcsStatusResult | null;
  readonly busy: boolean;
  readonly presentation: "sheet" | "inspector";
}) {
  const navigation = useNavigation();
  const gt = useGT();
  const pull = useAtomCommand(vcsEnvironment.pull, { reportFailure: false });
  const pullPermission = vcsEnvironment.pull.permissionAtom(props.target.environmentId);
  const canPull = useAtomValue(pullPermission);
  const canChangeThreadBranch = useAtomValue(
    workspaceVcs.switchBranch.permissionAtom(props.target.environmentId),
  );
  return (
    <View className="gap-1">
      <Text className="font-t3-semibold">
        <T>Primary repository</T>
      </Text>
      <ListSection>
        <ListRow
          icon="arrow.down.circle"
          label={gt("Pull latest", { $context: "verb, pull the latest Git changes" })}
          description={gt("{count} commits behind upstream", {
            count: props.status?.behindCount ?? 0,
          })}
          disabled={props.busy || !canPull || !props.status?.hasUpstream}
          onPress={() => {
            if (!appAtomRegistry.get(pullPermission)) return;
            void vcsActionManager.track(
              appAtomRegistry,
              { environmentId: props.target.environmentId, cwd: props.checkout.cwd },
              { operation: "pull", label: gt("Pulling latest changes") },
              async () => {
                const result = await pull({
                  environmentId: props.target.environmentId,
                  input: { cwd: props.checkout.cwd },
                });
                reportFailure(result);
                return result;
              },
            );
          }}
        />
      </ListSection>
      <ListSection>
        <ListRow
          icon="text.bubble"
          label={gt("Review changes", { $context: "verb, inspect changes" })}
          description={gt("Inspect turn diffs, working tree changes, and base branch diff")}
          disabled={props.busy || !props.status?.isRepo}
          onPress={() =>
            navigation.dispatch(
              props.presentation === "sheet"
                ? StackActions.replace("ThreadReview", props.target)
                : CommonActions.navigate("ThreadReview", props.target),
            )
          }
        />
      </ListSection>
      <ListSection>
        <ListRow
          icon="point.topleft.down.curvedto.point.bottomright.up"
          label={gt("Branches & worktrees")}
          description={gt("Switch branch, create branch, or move the primary to a worktree")}
          disabled={props.busy || !canChangeThreadBranch || !props.status?.isRepo}
          onPress={() => navigation.navigate("GitBranches", props.target)}
        />
      </ListSection>
    </View>
  );
}

export function WorkspaceGitOverviewSheet(props: {
  readonly target: ScopedThreadRef;
  readonly presentation?: "sheet" | "inspector";
}) {
  const navigation = useNavigation();
  const gt = useGT();
  const resolveMessage = useMessages();
  const isInspector = props.presentation === "inspector";
  const workspace = useThreadWorkspace(props.target);
  const closeInspectorSheet = use(InspectorSheetContext);
  const tracksRepositories = (workspace.project?.trackedFolders?.length ?? 0) > 0;
  const worktreePath = workspace.thread?.worktreePath ?? workspace.shell?.worktreePath ?? null;
  const taskFolderQuery = useEnvironmentQuery(
    tracksRepositories && worktreePath !== null
      ? filesystemEnvironment.taskFolder({
          environmentId: props.target.environmentId,
          input: { worktreePath },
        })
      : null,
  );
  const taskFolder = taskFolderQuery.data?.taskFolder ?? null;
  const queries = useWorkspaceGitQueries(props.target, workspace.checkouts);
  const statuses = queries.map((query) => query.status);
  const participation = workspaceActionState(
    workspace.checkouts,
    workspace.checkouts.map((checkout) => checkout.cwd),
    queries,
  );
  const eligibleCheckouts = workspace.checkouts.filter((_, index) => participation.eligible[index]);
  const summary = workspaceGitSummary(
    eligibleCheckouts,
    statuses.filter((_, index) => participation.eligible[index]),
    workspace.rows,
    workspace.checkouts,
  );
  const repoCount = participation.ready ? eligibleCheckouts.length : workspace.checkouts.length;
  const runtime = useRemoteEnvironmentRuntime(props.target.environmentId);
  const linkedPrLines = useLinkedPullRequestLines(workspace.shell, runtime);
  const linkedPrActions = useLinkedPullRequestActions({
    thread: workspace.shell,
    project: workspace.project,
    runtime,
  });
  const openPullRequest = useOpenPullRequest({
    replace: props.presentation !== "inspector",
    context: workspace.shell ?? undefined,
  });
  const actionPermission = workspaceVcs.runAction.permissionAtom(props.target.environmentId);
  const branchPermission = workspaceVcs.switchBranch.permissionAtom(props.target.environmentId);
  const canRunAction = useAtomValue(actionPermission);
  const canSwitchBranch = useAtomValue(branchPermission);
  const run = useAtomCommand(workspaceVcs.runAction, { reportFailure: false });
  const switchBranch = useAtomCommand(workspaceVcs.switchBranch, {
    reportFailure: false,
  });
  const refresh = useAtomCommand(vcsEnvironment.refreshStatus, { reportFailure: false });
  const actionState = useAtomValue(workspaceVcs.stateAtom(props.target));
  const memberBusy = useAtomValue(
    useMemo(
      () =>
        Atom.make((get) =>
          workspace.checkouts.some(
            (checkout) =>
              get(
                vcsActionManager.stateAtom({
                  environmentId: props.target.environmentId,
                  cwd: checkout.cwd,
                }),
              ).isRunning,
          ),
        ),
      [workspace.checkouts, props.target.environmentId],
    ),
  );
  const [switching, setBusy] = useState(false);
  const busy = switching || actionState.isRunning || memberBusy;
  const progress = actionState.currentLabel;
  const outcomes = actionState.result?.results ?? [];
  const [commitOpen, setCommitOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [branchOpen, setBranchOpen] = useState(false);
  const [branch, setBranch] = useState("");
  const [breakdownOpen, setBreakdownOpen] = useState(false);
  const disabled =
    !canRunAction ||
    busy ||
    !participation.ready ||
    !summary.known ||
    summary.drifted > 0 ||
    summary.members.length === 0;
  const refreshAll = async () => {
    for (const checkout of workspace.checkouts)
      await refresh({ environmentId: props.target.environmentId, input: { cwd: checkout.cwd } });
  };
  const runBatch = async (action: "commit" | "push" | "create-prs") => {
    const execute = async () => {
      if (disabled || !appAtomRegistry.get(actionPermission)) return;
      setBusy(true);
      await finishWorkspaceAction(
        async () => {
          const result = await run({
            environmentId: props.target.environmentId,
            cwds: eligibleCheckouts.map((checkout) => checkout.cwd),
            input: {
              actionId: uuidv4(),
              threadId: props.target.threadId,
              members: eligibleCheckouts.map((checkout) => checkout.repositoryRoot),
              action,
              ...(action === "commit" ? { commitMessage: message.trim() } : {}),
            },
          });
          reportFailure(result);
          if (result._tag === "Success") {
            setCommitOpen(false);
            const completed = result.value.results.filter(
              (member) => member.outcome._tag === "completed",
            ).length;
            Alert.alert(
              completed === result.value.results.length
                ? gt("Workspace action completed")
                : completed > 0
                  ? gt("Workspace action partially completed")
                  : gt("Workspace action did not complete"),
              workspaceActionOutcomeSummary(result.value, resolveMessage),
            );
          }
        },
        () => setBusy(false),
      );
    };
    if (action !== "commit" && statuses.some((status) => status?.isDefaultRef))
      Alert.alert(
        gt("Default branches"),
        gt("This action includes a repository on its default branch."),
        [
          { text: gt("Cancel"), style: "cancel" },
          { text: gt("Continue"), onPress: () => void execute() },
        ],
      );
    else await execute();
  };
  const content = (
    <NativeScrollView
      className="flex-1"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ padding: 16, paddingBottom: 40, gap: 12 }}
    >
      <ListSection>
        <ListRow
          icon="arrow.triangle.branch"
          label={gt("{branch} · {count, plural, =1 {{count} repo} other {{count} repos}}", {
            branch: workspace.thread?.worktrees?.length
              ? (workspace.thread.branch ?? summary.branch)
              : !participation.ready
                ? gt("Loading branches…")
                : summary.branch,
            count: repoCount,
          })}
          description={
            summary.drifted
              ? gt("{count} repositories drifted. Batch actions paused.", {
                  count: summary.drifted,
                })
              : workspace.thread?.worktrees?.length
                ? gt("Change the branch across the worktree set")
                : gt("Each repository uses its current checkout")
          }
          disabled={busy || !canSwitchBranch || !workspace.thread?.worktrees?.length}
          onPress={() => setBranchOpen(!branchOpen)}
        />
      </ListSection>
      {branchOpen ? (
        <View className="gap-2">
          <AppTextInput
            accessibilityLabel={gt("Shared branch")}
            className="min-h-12 rounded-xl bg-input px-3 text-foreground"
            value={branch}
            onChangeText={setBranch}
            editable={!busy}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Button
            label={gt("Switch all repositories")}
            disabled={busy || !canSwitchBranch || !branch.trim()}
            onPress={() => {
              if (!appAtomRegistry.get(branchPermission)) return;
              setBusy(true);
              const primary = workspace.checkouts[0];
              if (!primary) {
                setBusy(false);
                return;
              }
              void vcsActionManager
                .track(
                  appAtomRegistry,
                  { environmentId: props.target.environmentId, cwd: primary.cwd },
                  { operation: "switch_ref", label: gt("Switching workspace branch") },
                  () =>
                    switchBranch({
                      environmentId: props.target.environmentId,
                      cwds: workspace.checkouts.map((checkout) => checkout.cwd),
                      input: { threadId: props.target.threadId, branch: branch.trim() },
                    }),
                )
                .then(async (result) => {
                  reportFailure(result);
                  if (result._tag === "Success") setBranchOpen(false);
                  await refreshAll();
                })
                .finally(() => setBusy(false));
            }}
          />
        </View>
      ) : null}
      <ListSection>
        <ListRow
          icon="doc.text"
          label={
            participation.ready
              ? gt(
                  "{files} files changed across {repos, plural, =1 {{repos} repo} other {{repos} repos}}",
                  { files: summary.files.length, repos: repoCount },
                )
              : gt("Loading workspace changes…")
          }
          description={
            participation.ready
              ? `+${summary.files.reduce((sum, file) => sum + file.insertions, 0)} / −${summary.files.reduce((sum, file) => sum + file.deletions, 0)}`
              : gt("Checking repository status")
          }
          onPress={() =>
            navigation.dispatch(
              (props.presentation ?? "sheet") === "sheet"
                ? StackActions.replace("WorkspaceChanges", props.target)
                : CommonActions.navigate("WorkspaceChanges", props.target),
            )
          }
        />
      </ListSection>
      {repoCount > 0 ? (
        <View className="flex-row flex-wrap gap-2">
          <Button
            label={gt("Commit all", {
              $context: "verb, commit changes in all workspace repositories",
            })}
            disabled={disabled || summary.files.length === 0}
            onPress={() => setCommitOpen(!commitOpen)}
          />
          <Button
            label={gt("Push all", { $context: "verb, push all workspace repositories" })}
            disabled={disabled}
            onPress={() => void runBatch("push")}
          />
          <Button
            label={gt("Create PRs ({count})", { count: repoCount })}
            disabled={disabled}
            onPress={() => void runBatch("create-prs")}
          />
        </View>
      ) : null}
      {commitOpen ? (
        <View className="gap-2">
          {summary.files.some((file) => file.folderLabel === null) ? (
            <Text className="text-sm text-warning-foreground">
              {gt("{count} changed files outside workspace folders will also be committed.", {
                count: summary.files.filter((file) => file.folderLabel === null).length,
              })}
            </Text>
          ) : null}
          <Text className="text-sm text-foreground-muted">
            <T>One commit message for every repository</T>
          </Text>
          <AppTextInput
            accessibilityLabel={gt("Workspace commit message")}
            className="min-h-12 rounded-xl bg-input px-3 text-foreground"
            value={message}
            onChangeText={setMessage}
            editable={!busy}
            multiline
          />
          <Button
            label={gt("Commit all repositories")}
            disabled={disabled || !message.trim()}
            onPress={() => void runBatch("commit")}
          />
        </View>
      ) : null}
      {summary.drifted ? (
        <Text className="text-sm text-warning-foreground">
          <T>
            Switch drifted repositories back, or change the shared branch. Per-repo actions and
            inspection remain available.
          </T>
        </Text>
      ) : null}
      {progress ? (
        <Text accessibilityLiveRegion="polite" className="text-sm">
          {progress}
        </Text>
      ) : null}
      {outcomes.length ? (
        <Text selectable className="text-sm">
          {workspaceActionOutcomeSummary({ results: outcomes }, resolveMessage)}
        </Text>
      ) : null}
      {outcomes.map((member) =>
        member.outcome._tag === "completed" &&
        member.outcome.result.toast.cta.kind === "open_pr" ? (
          <Button
            key={member.repositoryRoot}
            label={gt("Open PR · {repository}", { repository: member.label })}
            onPress={() => {
              if (
                member.outcome._tag === "completed" &&
                member.outcome.result.toast.cta.kind === "open_pr"
              )
                void tryOpenExternalUrl(member.outcome.result.toast.cta.url, "pull-request");
            }}
          />
        ) : null,
      )}
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: breakdownOpen }}
        className="min-h-12 justify-center"
        onPress={() => setBreakdownOpen(!breakdownOpen)}
      >
        <Text className="font-t3-semibold">
          {gt("{arrow} Per-repo breakdown · {count}", {
            arrow: breakdownOpen ? "⌃" : "⌄",
            count: repoCount,
          })}
        </Text>
      </Pressable>
      {breakdownOpen
        ? summary.members.map((member) => (
            <RepositoryControls
              key={member.checkout.repositoryRoot}
              target={props.target}
              {...member}
              batchBusy={busy}
              primary={
                workspace.rows[0]?.isGit === true &&
                member.checkout.repositoryRoot === workspace.checkouts[0]?.repositoryRoot
              }
            />
          ))
        : null}
      {workspace.rows
        .filter((row) => !row.isGit)
        .map((row) => (
          <Text
            key={row.label}
            className={
              row.unavailable ? "text-sm text-warning-foreground" : "text-sm text-foreground-muted"
            }
          >
            {row.unavailable
              ? gt("{folder} · Unavailable · {reason}", {
                  folder: row.folder.name,
                  reason: String(row.reason),
                })
              : gt("{folder} · Shared · not checkpointed", { folder: row.folder.name })}
          </Text>
        ))}
      {workspace.checkouts
        .filter((_, index) => queries[index]?.error || statuses[index]?.isRepo === false)
        .map((checkout) => (
          <Text key={checkout.repositoryRoot} className="text-sm text-warning-foreground">
            {gt("{repository} · Repository status unavailable · excluded from actions", {
              repository: checkout.label,
            })}
          </Text>
        ))}
      {workspace.rows[0]?.isGit && workspace.checkouts[0] ? (
        <PrimaryRepositoryTools
          target={props.target}
          checkout={workspace.checkouts[0]}
          status={statuses[0] ?? null}
          busy={busy}
          presentation={props.presentation ?? "sheet"}
        />
      ) : null}
      {tracksRepositories && workspace.project ? (
        <ThreadRepositoryRows
          threadRef={props.target}
          projectId={workspace.project.id}
          threadCwd={threadPrimaryPath(workspace.thread ?? workspace.shell, workspace.project)}
          taskFolder={taskFolder}
          reachesTracked={worktreePath === null || taskFolder !== null}
          onTaskFolderChange={taskFolderQuery.refresh}
          explainsEmpty={false}
          onOpen={(section) => {
            const params = {
              ...props.target,
              repositoryCwd: section.cwd,
              repositoryName: section.name,
            };
            if (!isInspector) {
              navigation.dispatch(StackActions.replace("GitOverview", params));
              return;
            }
            const present = () => navigation.dispatch(StackActions.push("GitOverview", params));
            if (closeInspectorSheet) closeInspectorSheet(present);
            else present();
          }}
        />
      ) : null}
      {linkedPrActions.canLink ? (
        <ListSection>
          <ListRow
            icon="link"
            label={gt("Link pull request")}
            description={gt("Attach a pull request by URL or number")}
            onPress={linkedPrActions.promptLink}
          />
        </ListSection>
      ) : null}
      {linkedPrLines.length > 0 ? (
        <ListSection title={gt("Linked pull requests")}>
          {linkedPrLines.map((line, index) => (
            <LinkedPullRequestRow
              key={linkedPullRequestKey(line)}
              line={line}
              separator={index < linkedPrLines.length - 1}
              surfaceClassName="text-grouped-card"
              openPullRequest={openPullRequest}
              actions={linkedPrActions}
            />
          ))}
        </ListSection>
      ) : null}
      <Button
        label={gt("Refresh repositories")}
        disabled={busy}
        onPress={() => void refreshAll()}
      />
    </NativeScrollView>
  );
  return (
    <SheetPane surface={isInspector ? "screen" : "sheet"}>
      <AppBar
        title={gt("Version Control")}
        hideBottomBorder={!isInspector}
        onClose={isInspector ? undefined : () => navigation.goBack()}
      />
      <ScreenContent insetHorizontal={isInspector ? true : undefined}>{content}</ScreenContent>
    </SheetPane>
  );
}
