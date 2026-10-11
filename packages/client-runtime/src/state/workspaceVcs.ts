import type {
  VcsRunWorkspaceActionInput,
  VcsRunWorkspaceActionResult,
  VcsWorkspaceActionProgressEvent,
  VcsStatusResult,
} from "@t3tools/contracts";
import {
  isCheckoutDrifted,
  isPathWithin,
  isSamePath,
  type WorkspaceGitCheckout,
} from "@t3tools/shared/workspaceFolders";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

export type VcsBranchStatus = Pick<VcsStatusResult, "isRepo" | "refName">;
export type RunWorkspaceActionInput = VcsRunWorkspaceActionInput & {
  readonly cwds: ReadonlyArray<string>;
  readonly onProgress?: (event: VcsWorkspaceActionProgressEvent) => void;
};

/** Match frozen checkout identities, including healthy siblings of a missing first folder. */
export function workspaceCheckoutStatusCwds(
  checkouts: ReadonlyArray<WorkspaceGitCheckout>,
  rows: ReadonlyArray<{
    label: string;
    checkoutRoot: string | null | undefined;
    effectivePath: string | null;
    isGit: boolean;
  }>,
) {
  return checkouts.map((checkout) => {
    const available = rows.some(
      (row) =>
        row.isGit &&
        (row.label === checkout.label ||
          (typeof row.checkoutRoot === "string" &&
            isSamePath(row.checkoutRoot, checkout.repositoryRoot))) &&
        row.effectivePath !== null &&
        isPathWithin(checkout.root, row.effectivePath),
    );
    return !available
      ? null
      : rows.find((row) => row.label === checkout.label)?.effectivePath !== null
        ? checkout.cwd
        : checkout.root;
  });
}

/** Missing checkouts are excluded; unresolved status still waits before starting a batch. */
export function workspaceActionState(
  checkouts: ReadonlyArray<WorkspaceGitCheckout>,
  cwds: ReadonlyArray<string | null>,
  queries: ReadonlyArray<{ status: VcsStatusResult | null; error: boolean }>,
) {
  const eligible = checkouts.map(
    (_, index) =>
      cwds[index] != null && !queries[index]?.error && queries[index]?.status?.isRepo === true,
  );
  const ready = checkouts.every(
    (_, index) => cwds[index] === null || queries[index]?.error || queries[index]?.status != null,
  );
  const branch = workspaceBranchState(
    checkouts.filter((_, index) => eligible[index]),
    queries.filter((_, index) => eligible[index]).map((query) => query.status),
  );
  return {
    eligible,
    ready,
    members: checkouts
      .filter((_, index) => eligible[index])
      .map((checkout) => checkout.repositoryRoot),
    branch: {
      ...branch,
      branch:
        !branch.mixed && checkouts[0]?.expectedBranch ? checkouts[0].expectedBranch : branch.branch,
    },
  };
}

export class WorkspaceActionMissingResultError extends Schema.TaggedError<WorkspaceActionMissingResultError>()(
  "WorkspaceActionMissingResultError",
  { actionId: Schema.String },
) {
  override get message() {
    return "Workspace action ended without a result. Refresh status before retrying.";
  }
}

/** A member failure is an outcome; only the workspace terminal event finishes the batch. */
export function consumeWorkspaceActionProgress<E, R>(
  stream: Stream.Stream<VcsWorkspaceActionProgressEvent, E, R>,
  actionId: string,
  onProgress?: (event: VcsWorkspaceActionProgressEvent) => void,
) {
  return Effect.gen(function* () {
    let result: VcsRunWorkspaceActionResult | undefined;
    yield* Stream.runForEach(stream, (event) =>
      Effect.sync(() => {
        if (event.actionId !== actionId) return;
        if (event.kind === "workspace_action_finished") result = { results: event.results };
        try {
          onProgress?.(event);
        } catch {
          /* Presentation cannot fail a Git operation. */
        }
      }),
    );
    if (result === undefined) return yield* new WorkspaceActionMissingResultError({ actionId });
    return result;
  });
}

/** Unknown branches never count as agreement or drift. Current checkouts can be mixed. */
export function workspaceBranchState(
  checkouts: ReadonlyArray<Pick<WorkspaceGitCheckout, "expectedBranch">>,
  statuses: ReadonlyArray<VcsBranchStatus | null>,
) {
  const drifted = checkouts.filter(
    (checkout, index) =>
      statuses[index] !== null &&
      statuses[index] !== undefined &&
      isCheckoutDrifted(checkout, statuses[index]!.refName),
  ).length;
  const known = statuses.filter((status) => status?.isRepo === true);
  const complete = known.length === checkouts.length;
  const mixed =
    checkouts.every((checkout) => checkout.expectedBranch === null) &&
    new Set(known.map((status) => status!.refName)).size > 1;
  return {
    drifted,
    complete,
    mixed,
    branch: mixed
      ? "Mixed branches"
      : (checkouts[0]?.expectedBranch ?? statuses[0]?.refName ?? "Detached HEAD"),
    hint: !complete
      ? null
      : drifted > 0
        ? `${drifted}/${checkouts.length} drifted`
        : `${checkouts.length}/${checkouts.length}`,
  };
}

export function workspaceActionOutcomeText(result: VcsRunWorkspaceActionResult["results"][number]) {
  switch (result.outcome._tag) {
    case "completed":
      return result.outcome.result.toast.title;
    case "failed":
      return result.outcome.message;
    case "drifted":
      return `Paused: switch back to ${result.outcome.expectedBranch}`;
    case "unavailable":
      return `Unavailable: ${result.outcome.reason}`;
  }
}
