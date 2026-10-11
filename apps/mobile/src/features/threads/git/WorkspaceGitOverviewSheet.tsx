import { CommonActions, StackActions, useNavigation } from "@react-navigation/native";
import { useAtomValue } from "@effect/atom-react";
import type { ScopedThreadRef, VcsStatusResult } from "@t3tools/contracts";
import {
  workspaceActionOutcomeSummary,
  workspaceActionState,
} from "@t3tools/client-runtime/state/vcs";
import type { WorkspaceGitCheckout } from "@t3tools/shared/workspaceFolders";
import {
  resolveThreadPullRequestChains,
  threadPullRequestKeyOf,
} from "@t3tools/shared/threadPullRequests";
import { useMemo, useState } from "react";
import { Atom } from "effect/unstable/reactivity";
import { Alert, Platform, Pressable, ScrollView, View } from "react-native";
import { Screen, ScreenStack, ScreenStackHeaderConfig } from "react-native-screens";
import * as Cause from "effect/Cause";
import { AppText as Text, AppTextInput } from "../../../components/AppText";
import { MaterialButton } from "../../../components/MaterialButton";
import { AndroidSheetHeader } from "../../../components/AndroidScreenHeader";
import { withUniwind } from "uniwind";
import { tryOpenExternalUrl } from "../../../lib/openExternalUrl";
import { uuidv4 } from "../../../lib/uuid";
import { useThreadWorkspace, useWorkspaceGitQueries } from "../use-thread-workspace";
import { useAtomCommand } from "../../../state/use-atom-command";
import { useVcsActionState } from "../../../state/use-vcs-action-state";
import { vcsActionManager, vcsEnvironment, workspaceVcs } from "../../../state/vcs";
import { appAtomRegistry } from "../../../state/atom-registry";
import { resolveGitOverviewReviewNavigationAction } from "./git-overview-navigation";
import { workspaceGitSummary } from "./workspace-git-model";
import { SheetListRow } from "./gitSheetComponents";

const ThemedScreen = withUniwind(Screen);
const ThemedHeader = withUniwind(ScreenStackHeaderConfig, {
  color: { fromClassName: "colorClassName", styleProperty: "color" },
});

function reportFailure(result: { readonly _tag: string; readonly cause?: Cause.Cause<unknown> }) {
  if (result._tag === "Failure" && result.cause) {
    const error = Cause.squash(result.cause);
    Alert.alert("Git action failed", error instanceof Error ? error.message : String(error));
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
  const { checkout, status } = props;
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
        "Default branch",
        `Run ${action === "push" ? "push" : "Create PR"} on ${status.refName}?`,
        [
          { text: "Cancel", style: "cancel" },
          { text: "Continue", onPress: () => void execute() },
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
        {status?.refName ?? "Status unavailable"}
        {props.drifted ? " · drifted" : ""} · {status?.workingTree.files.length ?? 0} files changed
        · +{status?.workingTree.insertions ?? 0}/−{status?.workingTree.deletions ?? 0}
      </Text>
      <Text selectable className="text-xs text-foreground-muted">
        {checkout.cwd}
      </Text>
      {actionState.isRunning ? <Text className="text-sm">{actionState.currentLabel}</Text> : null}
      {props.drifted && checkout.expectedBranch ? (
        <MaterialButton
          label={`Switch back to ${checkout.expectedBranch}`}
          disabled={busy}
          onPress={() => {
            setSwitching(true);
            void vcsActionManager
              .track(
                appAtomRegistry,
                { environmentId: props.target.environmentId, cwd: checkout.cwd },
                { operation: "switch_ref", label: "Switching back" },
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
        <MaterialButton
          label="Commit"
          disabled={busy || !status?.hasWorkingTreeChanges}
          onPress={() =>
            props.primary
              ? navigation.navigate("GitCommit", props.target)
              : setCommitOpen(!commitOpen)
          }
        />
        <MaterialButton
          label="Push"
          disabled={busy || !status?.hasPrimaryRemote || !status.refName}
          onPress={() => void runAction("push")}
        />
        <MaterialButton
          label={status?.pr?.state === "open" ? `PR #${status.pr.number}` : "Create PR"}
          disabled={busy || !status?.hasPrimaryRemote || !status.refName}
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
            accessibilityLabel={`Commit message for ${checkout.label}`}
            className="min-h-12 rounded-xl bg-input px-3 text-foreground"
            value={message}
            placeholder="Leave empty to auto-generate"
            onChangeText={setMessage}
            editable={!busy}
          />
          <MaterialButton
            label={`Commit ${checkout.label}`}
            disabled={busy}
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
  const pull = useAtomCommand(vcsEnvironment.pull, { reportFailure: false });
  return (
    <View className="gap-1">
      <Text className="font-t3-semibold">Primary repository</Text>
      <SheetListRow
        icon="arrow.down.circle"
        title="Pull latest"
        subtitle={`${props.status?.behindCount ?? 0} commits behind upstream`}
        disabled={props.busy || !props.status?.hasUpstream}
        onPress={() => {
          void vcsActionManager.track(
            appAtomRegistry,
            { environmentId: props.target.environmentId, cwd: props.checkout.cwd },
            { operation: "pull", label: "Pulling latest changes" },
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
      <SheetListRow
        icon="text.bubble"
        title="Review changes"
        subtitle="Inspect turn diffs, working tree changes, and base branch diff"
        disabled={props.busy || !props.status?.isRepo}
        onPress={() =>
          navigation.dispatch(
            resolveGitOverviewReviewNavigationAction(props.presentation) === "replace"
              ? StackActions.replace("ThreadReview", props.target)
              : CommonActions.navigate("ThreadReview", props.target),
          )
        }
      />
      <SheetListRow
        icon="point.topleft.down.curvedto.point.bottomright.up"
        title="Branches & worktrees"
        subtitle="Switch branch, create branch, or move the primary to a worktree"
        disabled={props.busy || !props.status?.isRepo}
        onPress={() => navigation.navigate("GitBranches", props.target)}
      />
    </View>
  );
}

export function WorkspaceGitOverviewSheet(props: {
  readonly target: ScopedThreadRef;
  readonly presentation?: "sheet" | "inspector";
  readonly headerInset?: number;
}) {
  const navigation = useNavigation();
  const workspace = useThreadWorkspace(props.target);
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
  const linkedPrChains = resolveThreadPullRequestChains(workspace.thread?.pullRequests ?? []);
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
      if (disabled) return;
      setBusy(true);
      try {
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
              ? "Workspace action completed"
              : completed > 0
                ? "Workspace action partially completed"
                : "Workspace action did not complete",
            workspaceActionOutcomeSummary(result.value),
          );
        }
      } finally {
        setBusy(false);
      }
    };
    if (action !== "commit" && statuses.some((status) => status?.isDefaultRef))
      Alert.alert("Default branches", "This action includes a repository on its default branch.", [
        { text: "Cancel", style: "cancel" },
        { text: "Continue", onPress: () => void execute() },
      ]);
    else await execute();
  };
  const content = (
    <ScrollView
      className="flex-1"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ padding: 16, paddingBottom: 40, gap: 12 }}
    >
      <SheetListRow
        icon="arrow.triangle.branch"
        title={`${workspace.thread?.worktrees?.length ? (workspace.thread.branch ?? summary.branch) : !participation.ready ? "Loading branches…" : summary.branch} · ${repoCount} ${repoCount === 1 ? "repo" : "repos"}`}
        subtitle={
          summary.drifted
            ? `${summary.drifted} repositories drifted. Batch actions paused.`
            : workspace.thread?.worktrees?.length
              ? "Change the branch across the worktree set"
              : "Each repository uses its current checkout"
        }
        disabled={busy || !workspace.thread?.worktrees?.length}
        onPress={() => setBranchOpen(!branchOpen)}
      />
      {branchOpen ? (
        <View className="gap-2">
          <AppTextInput
            accessibilityLabel="Shared branch"
            className="min-h-12 rounded-xl bg-input px-3 text-foreground"
            value={branch}
            onChangeText={setBranch}
            editable={!busy}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <MaterialButton
            label="Switch all repositories"
            disabled={busy || !branch.trim()}
            onPress={() => {
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
                  { operation: "switch_ref", label: "Switching workspace branch" },
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
      <SheetListRow
        icon="doc.text"
        title={
          participation.ready
            ? `${summary.files.length} files changed across ${repoCount} ${repoCount === 1 ? "repo" : "repos"}`
            : "Loading workspace changes…"
        }
        subtitle={
          participation.ready
            ? `+${summary.files.reduce((sum, file) => sum + file.insertions, 0)} / −${summary.files.reduce((sum, file) => sum + file.deletions, 0)}`
            : "Checking repository status"
        }
        onPress={() =>
          navigation.dispatch(
            resolveGitOverviewReviewNavigationAction(props.presentation ?? "sheet") === "replace"
              ? StackActions.replace("WorkspaceChanges", props.target)
              : CommonActions.navigate("WorkspaceChanges", props.target),
          )
        }
      />
      {repoCount > 0 ? (
        <View className="flex-row flex-wrap gap-2">
          <MaterialButton
            label="Commit all"
            disabled={disabled || summary.files.length === 0}
            onPress={() => setCommitOpen(!commitOpen)}
          />
          <MaterialButton
            label="Push all"
            disabled={disabled}
            onPress={() => void runBatch("push")}
          />
          <MaterialButton
            label={`Create PRs (${repoCount})`}
            disabled={disabled}
            onPress={() => void runBatch("create-prs")}
          />
        </View>
      ) : null}
      {commitOpen ? (
        <View className="gap-2">
          {summary.files.some((file) => file.folderLabel === null) ? (
            <Text className="text-sm text-warning-foreground">
              {summary.files.filter((file) => file.folderLabel === null).length} changed files
              outside workspace folders will also be committed.
            </Text>
          ) : null}
          <Text className="text-sm text-foreground-muted">
            One commit message for every repository
          </Text>
          <AppTextInput
            accessibilityLabel="Workspace commit message"
            className="min-h-12 rounded-xl bg-input px-3 text-foreground"
            value={message}
            onChangeText={setMessage}
            editable={!busy}
            multiline
          />
          <MaterialButton
            label="Commit all repositories"
            disabled={disabled || !message.trim()}
            onPress={() => void runBatch("commit")}
          />
        </View>
      ) : null}
      {summary.drifted ? (
        <Text className="text-sm text-warning-foreground">
          Switch drifted repositories back, or change the shared branch. Per-repo actions and
          inspection remain available.
        </Text>
      ) : null}
      {progress ? (
        <Text accessibilityLiveRegion="polite" className="text-sm">
          {progress}
        </Text>
      ) : null}
      {outcomes.length ? (
        <Text selectable className="text-sm">
          {workspaceActionOutcomeSummary({ results: outcomes })}
        </Text>
      ) : null}
      {outcomes.map((member) =>
        member.outcome._tag === "completed" &&
        member.outcome.result.toast.cta.kind === "open_pr" ? (
          <MaterialButton
            key={member.repositoryRoot}
            label={`Open PR · ${member.label}`}
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
          {breakdownOpen ? "⌃" : "⌄"} Per-repo breakdown · {repoCount}
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
            {row.folder.name} ·{" "}
            {row.unavailable ? `Unavailable · ${row.reason}` : "Shared · not checkpointed"}
          </Text>
        ))}
      {workspace.checkouts
        .filter((_, index) => queries[index]?.error || statuses[index]?.isRepo === false)
        .map((checkout) => (
          <Text key={checkout.repositoryRoot} className="text-sm text-warning-foreground">
            {checkout.label} · Repository status unavailable · excluded from actions
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
      {linkedPrChains.length ? (
        <View className="gap-2">
          <Text className="font-t3-semibold">Linked pull requests</Text>
          {linkedPrChains.map((chain) => (
            <View key={threadPullRequestKeyOf(chain.layers[0]!)}>
              {chain.layers.length > 1 ? (
                <Text className="text-sm text-foreground-muted">
                  {chain.kind === "native" ? "Stack" : "Branch stack"} · {chain.layers.length} PRs ·
                  bottom to top
                </Text>
              ) : null}
              {chain.layers.map((link) => (
                <SheetListRow
                  key={threadPullRequestKeyOf(link)}
                  icon="arrow.triangle.pull"
                  title={`#${link.number} ${link.snapshot?.title ?? "Pull request"}`}
                  subtitle={`${link.repository} · ${link.snapshot === null ? "Status pending" : link.snapshot.isDraft && link.snapshot.state === "open" ? "Draft" : link.snapshot.state}`}
                  onPress={() => void tryOpenExternalUrl(link.url, "pull-request")}
                />
              ))}
            </View>
          ))}
        </View>
      ) : null}
      <MaterialButton
        label="Refresh repositories"
        disabled={busy}
        onPress={() => void refreshAll()}
      />
    </ScrollView>
  );
  if (Platform.OS === "ios")
    return (
      <View
        className={
          props.presentation === "inspector"
            ? "flex-1 border-l border-border bg-sheet"
            : "flex-1 bg-sheet"
        }
      >
        <ScreenStack style={{ flex: 1 }}>
          <ThemedScreen
            activityState={2}
            enabled
            isNativeStack
            screenId="workspace-vcs"
            className="flex-1 bg-sheet"
          >
            {content}
            <ThemedHeader
              title="Version Control"
              hideBackButton
              translucent
              colorClassName="text-foreground"
            />
          </ThemedScreen>
        </ScreenStack>
      </View>
    );
  return (
    <View
      className={
        props.presentation === "inspector"
          ? "flex-1 border-l border-border bg-sheet"
          : "flex-1 bg-sheet"
      }
    >
      {props.presentation === "inspector" ? (
        <View style={{ paddingTop: props.headerInset ?? 0 }} className="px-4 py-3">
          <Text className="text-xl font-t3-semibold">Version Control</Text>
        </View>
      ) : (
        <AndroidSheetHeader title="Version Control" onBack={() => navigation.goBack()} />
      )}
      {content}
    </View>
  );
}
