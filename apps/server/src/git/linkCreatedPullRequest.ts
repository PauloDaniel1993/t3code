import { sourceControlRepositorySelector } from "@t3tools/shared/sourceControl";
import {
  type CommandId,
  pullRequestHostOf,
  type GitRunStackedActionResult,
  type RepositoryIdentity,
  type SourceControlProviderKind,
  type ThreadId,
} from "@t3tools/contracts";
import { parseChangeRequestUrl } from "@t3tools/shared/changeRequestUrl";
import { isSamePath } from "@t3tools/shared/workspaceFolders";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";

export interface CreatedPullRequestKey {
  readonly host: string;
  readonly repository: string;
  readonly number: number;
  readonly url: string;
}

/**
 * The identity a stacked action's pull request should be linked under, or
 * null when the action did not leave one behind. Reading the host and
 * repository from the URL keeps the link host-level even when the checkout's
 * remote differs from where the PR was opened (a fork, say); the checkout's
 * repository is only consulted when the URL is one this cannot read.
 */
export function createdPullRequestKey(
  result: Pick<GitRunStackedActionResult, "pr">,
  checkout: { readonly repositoryIdentity?: RepositoryIdentity | null | undefined } | undefined,
): CreatedPullRequestKey | null {
  const { status, number, url } = result.pr;
  if ((status !== "created" && status !== "opened_existing") || number === undefined || !url) {
    return null;
  }
  const parsed = parseChangeRequestUrl(url);
  if (parsed !== null) return { ...parsed, url };
  const identity = checkout?.repositoryIdentity;
  const kind = identity?.provider as SourceControlProviderKind | undefined;
  const repository = sourceControlRepositorySelector(identity);
  if (!identity || kind === undefined || repository === null) return null;
  return {
    host: pullRequestHostOf(identity, kind),
    repository: repository.toLowerCase(),
    number,
    url,
  };
}

/**
 * Never fails: the git action already succeeded and its result is on its way to the client, so
 * a link that cannot be made is logged and dropped.
 */
export const linkCreatedPullRequest: <E>(input: {
  readonly threadId: ThreadId;
  /** The checkout the action ran in: any repository the thread works in. */
  readonly cwd: string;
  readonly result: Pick<GitRunStackedActionResult, "pr">;
  readonly commandId: Effect.Effect<CommandId, E>;
}) => Effect.Effect<
  void,
  never,
  | Orchestrator.OrchestratorV2
  | ProjectService.ProjectService
  | RepositoryIdentityResolver.RepositoryIdentityResolver
> = Effect.fn("linkCreatedPullRequest")(
  function* <E>(input: {
    readonly threadId: ThreadId;
    readonly cwd: string;
    readonly result: Pick<GitRunStackedActionResult, "pr">;
    readonly commandId: Effect.Effect<CommandId, E>;
  }) {
    const { status, number, url } = input.result.pr;
    if ((status !== "created" && status !== "opened_existing") || number === undefined || !url)
      return;
    const engine = yield* Orchestrator.OrchestratorV2;
    const thread = yield* engine
      .getThreadShell(input.threadId)
      .pipe(Effect.map(Option.fromNullishOr));
    if (Option.isNone(thread)) return;
    let key = createdPullRequestKey(input.result, undefined);
    if (key === null) {
      const projects = yield* ProjectService.ProjectService;
      const project = Option.getOrUndefined(yield* projects.getShell(thread.value.projectId));
      if (project !== undefined && isSamePath(input.cwd, project.workspaceRoot)) {
        key = createdPullRequestKey(input.result, project);
      }
      if (key === null) {
        const identities = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
        key = createdPullRequestKey(input.result, {
          repositoryIdentity: yield* identities.resolve(input.cwd),
        });
      }
    }
    if (key === null) return;
    const commandId = yield* input.commandId;
    yield* engine
      .dispatch({
        type: "thread.pull-request.link",
        commandId,
        threadId: input.threadId,
        ...key,
        source: "created",
      })
      .pipe(Effect.asVoid);
  },
  (effect, input) =>
    effect.pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause as Cause.Cause<never>)
          : Effect.logWarning("failed to link created pull request to thread", {
              threadId: input.threadId,
            }),
      ),
    ),
);
