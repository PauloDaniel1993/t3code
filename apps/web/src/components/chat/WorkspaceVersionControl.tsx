import type {
  EnvironmentId,
  ThreadId,
  VcsWorkspaceAction,
  VcsWorkspaceActionMemberResult,
} from "@t3tools/contracts";
import {
  workspaceGitCheckouts,
  isCheckoutDrifted,
  isPathWithin,
  type WorkspaceThread,
} from "@t3tools/shared/workspaceFolders";
import {
  workspaceBranchState,
  workspaceActionOutcomeText,
} from "@t3tools/client-runtime/state/vcs";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { ChevronDownIcon, ChevronRightIcon, GitBranchIcon, FileDiffIcon } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { useOpenLink } from "../../browser/useOpenLink";
import { usePaginatedBranches } from "../../state/queries";
import { useWorkspaceStatuses } from "../../state/workspaceVcs";
import { useAtomCommand } from "../../state/use-atom-command";
import { vcsEnvironment } from "../../state/vcs";
import { randomUUID, cn } from "../../lib/utils";
import GitActionsControl from "../GitActionsControl";
import { type WorkspaceFoldersProject, type WorkspaceFolderRow } from "../workspaceFolders.logic";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { workspaceChangedFiles } from "./workspaceVersionControl.logic";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";

export function WorkspaceVersionControl(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  project: WorkspaceFoldersProject;
  thread: WorkspaceThread | null;
  rows: ReadonlyArray<WorkspaceFolderRow>;
  onShowChanges?: ((folder: WorkspaceFolderRow) => void) | undefined;
  draftBranchControl?: ReactNode;
}) {
  const { environmentId, threadId, rows } = props;
  const threadRef = useMemo(() => ({ environmentId, threadId }), [environmentId, threadId]);
  const thread = props.thread ?? {
    worktreePath: null,
    workspaceFolders: rows.map((row) => ({
      ...row.folder,
      label: row.label,
      checkoutRoot: row.checkoutRoot,
    })),
    worktrees: undefined,
  };
  const checkouts = workspaceGitCheckouts(thread, props.project);
  const available = checkouts.map((checkout) =>
    rows.some(
      (row) =>
        row.isGit && row.effectivePath !== null && isPathWithin(checkout.root, row.effectivePath),
    ),
  );
  // The server falls back to the checkout root when its first frozen folder is gone.
  const statusCwds = checkouts.map((checkout, index) =>
    !available[index]
      ? null
      : rows.find((row) => row.label === checkout.label)?.effectivePath !== null
        ? checkout.cwd
        : checkout.root,
  );
  const statuses = useWorkspaceStatuses(environmentId, statusCwds);
  const branch = workspaceBranchState(
    checkouts,
    statuses.map((query) => query.status),
  );
  const [breakdown, setBreakdown] = useState(false);
  const [changesOpen, setChangesOpen] = useState(false);
  const [branchOpen, setBranchOpen] = useState(false);
  const [branchQuery, setBranchQuery] = useState("");
  const [pendingAction, setPendingAction] = useState<VcsWorkspaceAction | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<Record<string, string>>({});
  const [results, setResults] = useState<ReadonlyArray<VcsWorkspaceActionMemberResult>>([]);
  const runWorkspaceAction = useAtomCommand(vcsEnvironment.runWorkspaceAction, {
    reportFailure: false,
  });
  const switchBranch = useAtomCommand(vcsEnvironment.switchWorktreeSetBranch, {
    reportFailure: false,
  });
  const openLink = useOpenLink(threadRef);
  const branches = usePaginatedBranches({
    environmentId,
    cwd: branchOpen ? (checkouts[0]?.cwd ?? null) : null,
    query: branchQuery,
  });
  const ready = statuses.every(
    (query, index) => !available[index] || query.status?.isRepo === true,
  );
  const actionDisabled =
    busy || props.thread === null || !ready || branch.drifted > 0 || !available.some(Boolean);
  const changed = workspaceChangedFiles(
    props.project,
    thread,
    rows,
    statuses.map((query) => query.status),
  );
  const totals = changed.reduce(
    (sum, file) => ({
      insertions: sum.insertions + file.insertions,
      deletions: sum.deletions + file.deletions,
    }),
    { insertions: 0, deletions: 0 },
  );
  const changedRepos = new Set(changed.map((file) => file.checkout.repositoryRoot)).size;
  const stateMessage =
    props.thread === null
      ? "Start the thread to run workspace actions."
      : statuses.some((query) => query.error)
        ? "Repository status is unavailable. Refresh or reconnect to try again."
        : !ready
          ? "Waiting for repository status."
          : branch.drifted > 0
            ? "Batch actions paused. Switch drifted repositories back to their expected branches."
            : null;
  const run = async (action: VcsWorkspaceAction) => {
    if (actionDisabled) return;
    setBusy(true);
    setError(null);
    setResults([]);
    setProgress({});
    try {
      const result = await runWorkspaceAction({
        environmentId,
        input: {
          actionId: randomUUID(),
          threadId,
          action,
          ...(action === "commit" ? { commitMessage: message.trim() } : {}),
          members: checkouts
            .filter((_, index) => available[index])
            .map((checkout) => checkout.repositoryRoot),
          onProgress: (event) => {
            if (
              event.kind !== "phase_started" &&
              event.kind !== "action_finished" &&
              event.kind !== "action_failed"
            )
              return;
            const label =
              event.kind === "phase_started"
                ? event.label
                : event.kind === "action_finished"
                  ? event.result.toast.title
                  : event.message;
            setProgress((current) =>
              current[event.cwd] === label ? current : { ...current, [event.cwd]: label },
            );
          },
        },
      });
      if (result._tag === "Failure") {
        setError(String(squashAtomCommandFailure(result)));
        return;
      }
      setResults(result.value.results);
      setPendingAction(null);
      setMessage("");
      if (action === "create-prs")
        for (const member of result.value.results) {
          if (member.outcome._tag === "completed" && member.outcome.result.pr.url)
            await openLink(member.outcome.result.pr.url);
        }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not open the pull request.");
    } finally {
      setBusy(false);
    }
  };
  const switchTo = async (name: string, members?: Array<string>) => {
    if (busy || !props.thread) return;
    setBusy(true);
    setError(null);
    try {
      const result = await switchBranch({
        environmentId,
        input: { threadId, branch: name, ...(members ? { members } : {}) },
      });
      if (result._tag === "Failure") setError(String(squashAtomCommandFailure(result)));
      else setBranchOpen(false);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {props.thread === null && props.draftBranchControl ? (
        props.draftBranchControl
      ) : (
        <ThreadDetailsControl
          disabled={busy || !thread.worktrees?.length}
          onClick={() => setBranchOpen(true)}
          aria-label="Switch shared branch"
        >
          <GitBranchIcon className="size-3.5" />
          <span className="min-w-0 flex-1 truncate text-left">
            {ready ? branch.branch : "Loading branches…"} · {checkouts.length} repos
          </span>
          <ChevronDownIcon className="size-3" />
        </ThreadDetailsControl>
      )}
      <ThreadDetailsControl
        onClick={() => setChangesOpen(!changesOpen)}
        aria-expanded={changesOpen}
      >
        <FileDiffIcon className="size-3.5" />
        <span className="flex-1 text-left">
          {changed.length} files changed across {changedRepos} repos
        </span>
        <span className="font-mono text-2xs">
          <span className="text-success">+{totals.insertions}</span>{" "}
          <span className="text-destructive">−{totals.deletions}</span>
        </span>
      </ThreadDetailsControl>
      {changesOpen ? (
        <div className="px-3 py-2 text-2xs">
          {changed.length === 0 ? (
            <p className="text-muted-foreground">
              {ready ? "No working tree changes." : "Loading changes…"}
            </p>
          ) : (
            changed.map((file) => (
              <button
                type="button"
                key={`${file.checkout.repositoryRoot}/${file.path}`}
                className="block w-full truncate py-1 text-left hover:text-foreground text-muted-foreground"
                disabled={!props.onShowChanges}
                onClick={() => {
                  props.onShowChanges?.(file.row);
                }}
              >
                {file.canonicalPath}
              </button>
            ))
          )}
        </div>
      ) : null}
      <div className="flex flex-wrap gap-1 px-1 py-2">
        <Button
          variant="outline"
          size="xs"
          disabled={
            actionDisabled || !statuses.some((query) => query.status?.hasWorkingTreeChanges)
          }
          onClick={() => setPendingAction("commit")}
        >
          Commit all
        </Button>
        <Button
          variant="outline"
          size="xs"
          disabled={actionDisabled}
          onClick={() => setPendingAction("push")}
        >
          Push all
        </Button>
        <Button
          variant="outline"
          size="xs"
          disabled={actionDisabled}
          onClick={() => setPendingAction("create-prs")}
        >
          Create PRs ({available.filter(Boolean).length})
        </Button>
      </div>
      {stateMessage ? (
        <p
          className={cn(
            "px-2 py-1 text-2xs",
            branch.drifted ? "text-warning" : "text-muted-foreground",
          )}
        >
          {stateMessage}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="px-2 py-1 text-2xs text-destructive">
          {error}
        </p>
      ) : null}
      {busy ? (
        <div role="status" className="px-2 py-1 text-2xs">
          {checkouts.map((checkout, index) =>
            progress[statusCwds[index] ?? checkout.cwd] ? (
              <p key={checkout.repositoryRoot}>
                {checkout.label}: {progress[statusCwds[index] ?? checkout.cwd]}
              </p>
            ) : null,
          )}
        </div>
      ) : null}
      {results.length ? (
        <ul className="px-2 py-1 text-2xs" aria-label="Workspace action results">
          {results.map((result) => (
            <li
              key={result.repositoryRoot}
              className={
                result.outcome._tag === "completed" ? "text-muted-foreground" : "text-warning"
              }
            >
              {result.label}: {workspaceActionOutcomeText(result)}
            </li>
          ))}
        </ul>
      ) : null}
      <ThreadDetailsControl onClick={() => setBreakdown(!breakdown)} aria-expanded={breakdown}>
        <ChevronRightIcon className={cn("size-3", breakdown && "rotate-90")} />
        <span className="flex-1 text-left">Per-repo breakdown</span>
        <span className="text-2xs text-muted-foreground">{checkouts.length}</span>
      </ThreadDetailsControl>
      {breakdown
        ? checkouts.map((checkout, index) => {
            const status = statuses[index]?.status;
            const drifted = status != null && isCheckoutDrifted(checkout, status.refName);
            const row = rows.find((row) => row.label === checkout.label);
            return (
              <div
                key={checkout.repositoryRoot}
                className="ml-3 border-l border-border/60 pl-2 py-1"
              >
                <div className="px-1 text-xs font-medium">{row?.folder.name ?? checkout.label}</div>
                <p
                  className={cn(
                    "px-1 text-2xs",
                    drifted ? "text-warning" : "text-muted-foreground",
                  )}
                >
                  {!available[index]
                    ? "Unavailable · excluded from actions"
                    : status
                      ? `${status.refName ?? "Detached HEAD"} · ${status.workingTree.files.length} files changed${drifted ? " · Drifted" : ""}`
                      : statuses[index]?.error
                        ? "Status unavailable"
                        : "Loading status…"}
                </p>
                {available[index] && props.thread ? (
                  <GitActionsControl
                    gitCwd={statusCwds[index] ?? checkout.cwd}
                    activeThreadRef={threadRef}
                    displayMode="panel"
                    compact
                    disabled={busy}
                    syncThreadBranch={row?.isPrimary === true}
                    {...(row && props.onShowChanges
                      ? { onOpenChanges: () => props.onShowChanges?.(row) }
                      : {})}
                  />
                ) : null}
                {drifted && checkout.expectedBranch ? (
                  <div className="px-1 py-1">
                    <Button
                      variant="outline"
                      size="xs"
                      disabled={busy}
                      onClick={() =>
                        void switchTo(checkout.expectedBranch!, [checkout.repositoryRoot])
                      }
                    >
                      Switch back to {checkout.expectedBranch}
                    </Button>
                  </div>
                ) : null}
              </div>
            );
          })
        : null}
      {rows
        .filter((row) => !row.isGit)
        .map((row) => (
          <p
            key={row.label}
            className={cn(
              "px-2 py-1 text-2xs",
              row.unavailable ? "text-warning" : "text-muted-foreground",
            )}
          >
            {row.folder.name} ·{" "}
            {row.unavailable ? `${row.reason} · Unavailable` : "Shared · not checkpointed"}
          </p>
        ))}
      <Dialog
        open={pendingAction !== null}
        onOpenChange={(open) => {
          if (!busy && !open) setPendingAction(null);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>
              {pendingAction === "commit"
                ? "Commit all"
                : pendingAction === "push"
                  ? "Push all"
                  : "Create PRs"}
            </DialogTitle>
            <DialogDescription>
              {pendingAction === "commit"
                ? "Use one commit message for every repository. Each repository commits independently."
                : pendingAction === "push"
                  ? "Push each available repository on its own branch."
                  : "Open existing pull requests and create missing ones. Each repository runs independently."}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {pendingAction === "commit" ? (
              <Textarea
                aria-label="Commit message"
                placeholder="Commit message"
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                disabled={busy}
              />
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button variant="ghost" disabled={busy} onClick={() => setPendingAction(null)}>
              Cancel
            </Button>
            <Button
              disabled={actionDisabled || (pendingAction === "commit" && !message.trim())}
              onClick={() => {
                if (pendingAction) void run(pendingAction);
              }}
            >
              {busy ? "Running…" : "Continue"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <Dialog
        open={branchOpen}
        onOpenChange={(open) => {
          if (!busy) setBranchOpen(open);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Switch shared branch</DialogTitle>
            <DialogDescription>
              Switch every member of this worktree set. The branch must exist in each repository.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <Input
              aria-label="Find branch"
              value={branchQuery}
              onChange={(event) => setBranchQuery(event.target.value)}
            />
            <div className="mt-2 max-h-64 overflow-auto">
              {branches.refs
                .filter((ref) => !ref.isRemote)
                .map((ref) => (
                  <div key={ref.name}>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => void switchTo(ref.name)}
                    >
                      {ref.name}
                    </Button>
                  </div>
                ))}
              {branches.isPending ? <p className="text-xs">Loading branches…</p> : null}
              {branches.error ? <p className="text-xs text-destructive">{branches.error}</p> : null}
              {branches.data?.nextCursor != null ? (
                <Button variant="ghost" size="sm" onClick={branches.loadNext}>
                  Load more
                </Button>
              ) : null}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button variant="ghost" disabled={busy} onClick={() => setBranchOpen(false)}>
              Cancel
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
