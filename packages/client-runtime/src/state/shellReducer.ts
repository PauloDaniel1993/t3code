import {
  OrchestrationV2ThreadShell,
  RepositoryIdentity,
  ProjectWorkspaceFolder,
  ThreadPullRequestLink,
  WorkspaceFileStatus,
  type OrchestrationProjectShell,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ShellStreamItem,
  type ProjectId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const sameThreadShell = Schema.toEquivalence(OrchestrationV2ThreadShell);
const sameLinks = Schema.toEquivalence(Schema.UndefinedOr(Schema.Array(ThreadPullRequestLink)));
const sameRepositoryIdentity = Schema.toEquivalence(
  Schema.UndefinedOr(Schema.NullOr(RepositoryIdentity)),
);
const sameWorkspaceFolder = Schema.toEquivalence(ProjectWorkspaceFolder);
const sameWorkspaceFileStatus = Schema.toEquivalence(Schema.UndefinedOr(WorkspaceFileStatus));

export function sameThreadPullRequests(
  left: OrchestrationV2ThreadShell["pullRequests"],
  right: OrchestrationV2ThreadShell["pullRequests"],
): boolean {
  return left === right || sameLinks(left, right);
}

/**
 * Links are compared apart from the rest of the row because a deferred snapshot arrives without
 * them; such a row keeps its links until they fill in.
 */
export function reuseUnchangedThreadShells(
  previous: OrchestrationV2ShellSnapshot | null,
  next: OrchestrationV2ShellSnapshot,
): OrchestrationV2ShellSnapshot {
  if (previous === null || previous.threads.length === 0) return next;
  const previousById = new Map(previous.threads.map((thread) => [thread.id, thread] as const));
  let changed = false;
  const threads = next.threads.map((thread) => {
    const prior = previousById.get(thread.id);
    if (prior === undefined) return thread;
    const candidate =
      thread.pullRequests === undefined && prior.pullRequests !== undefined
        ? { ...thread, pullRequests: prior.pullRequests }
        : thread;
    const retained = sameThreadShell(prior, candidate) ? prior : candidate;
    if (retained !== thread) changed = true;
    return retained;
  });
  return changed ? { ...next, threads } : next;
}

function upsertById<T extends { readonly id: unknown }>(
  items: ReadonlyArray<T>,
  item: T,
): ReadonlyArray<T> {
  const index = items.findIndex((candidate) => candidate.id === item.id);
  if (index === -1) return [...items, item];
  return items.map((candidate, candidateIndex) => (candidateIndex === index ? item : candidate));
}

function mergeFolderFacts(
  previous: ProjectWorkspaceFolder | undefined,
  next: ProjectWorkspaceFolder,
  primary: boolean,
): ProjectWorkspaceFolder {
  const availability = next.availability ?? previous?.availability;
  const vcs =
    next.vcs === undefined
      ? next.availability === "unavailable"
        ? undefined
        : previous?.vcs
      : next.vcs;
  const repositoryIdentity =
    vcs != null && !primary
      ? vcs.repositoryIdentity === undefined
        ? vcs.checkoutRoot === previous?.vcs?.checkoutRoot
          ? previous?.vcs?.repositoryIdentity
          : undefined
        : vcs.repositoryIdentity
      : undefined;
  const {
    availability: _availability,
    unavailableReason: _reason,
    remoteDescription: _remote,
    vcs: _vcs,
    ...definition
  } = next;
  const unavailableReason =
    availability === "unavailable"
      ? (next.unavailableReason ?? previous?.unavailableReason)
      : undefined;
  const remoteDescription = next.remoteDescription ?? previous?.remoteDescription;
  const merged = {
    ...definition,
    ...(availability === undefined ? {} : { availability }),
    ...(unavailableReason === undefined ? {} : { unavailableReason }),
    ...(remoteDescription === undefined ? {} : { remoteDescription }),
    ...(vcs === undefined
      ? {}
      : {
          vcs:
            vcs === null
              ? null
              : {
                  checkoutRoot: vcs.checkoutRoot,
                  ...(repositoryIdentity === undefined ? {} : { repositoryIdentity }),
                },
        }),
  };
  return previous !== undefined && sameWorkspaceFolder(previous, merged) ? previous : merged;
}

function folderKey(folder: ProjectWorkspaceFolder): string | undefined {
  return folder.path === undefined ? folder.uri : folder.path;
}

function retainProjectEnrichment(
  previous: OrchestrationProjectShell | undefined,
  next: OrchestrationProjectShell,
): OrchestrationProjectShell {
  let retained = next;
  if (
    next.repositoryIdentity == null &&
    previous?.repositoryIdentity != null &&
    previous.workspaceRoot === next.workspaceRoot
  ) {
    retained = { ...next, repositoryIdentity: previous.repositoryIdentity };
  }
  if (!next.workspaceFile || !previous?.workspaceFile) return retained;
  const priorFolders = new Map(previous.folders?.map((folder) => [folderKey(folder), folder]));
  return {
    ...retained,
    ...(next.folders === undefined
      ? {}
      : {
          folders: next.folders.map((folder, index) =>
            mergeFolderFacts(priorFolders.get(folderKey(folder)), folder, index === 0),
          ),
        }),
    ...(previous.workspaceFile === next.workspaceFile &&
    next.workspaceFileStatus === undefined &&
    previous.workspaceFileStatus !== undefined
      ? { workspaceFileStatus: previous.workspaceFileStatus }
      : {}),
  };
}

export interface MergeShellSnapshotOptions {
  /**
   * Metadata-only enrichment refresh: structure and sequence never change;
   * listed roots accept identity exactly (including null), and listed project
   * ids accept current folder facts and workspace-file status.
   * Omit this options object for authoritative HTTP/initial WebSocket snapshots.
   */
  readonly resolvedRepositoryIdentityRoots: ReadonlyArray<string>;
  readonly enrichedProjectIds?: ReadonlyArray<ProjectId>;
}

export function mergeShellSnapshotProjects(
  previous: OrchestrationV2ShellSnapshot | null | undefined,
  next: OrchestrationV2ShellSnapshot,
  options?: MergeShellSnapshotOptions,
): OrchestrationV2ShellSnapshot {
  if (previous === null || previous === undefined) {
    return next;
  }

  const isEnrichment = options !== undefined;
  const resolvedRootSet = isEnrichment ? new Set(options.resolvedRepositoryIdentityRoots) : null;
  const enrichedIdSet = new Set(options?.enrichedProjectIds);

  if (isEnrichment) {
    const nextById = new Map(next.projects.map((project) => [project.id, project] as const));
    const projects = previous.projects.map((project) => {
      const candidate = nextById.get(project.id);
      if (candidate === undefined) {
        return project;
      }
      let enriched = project;
      if (candidate.workspaceRoot === project.workspaceRoot) {
        if (
          resolvedRootSet?.has(project.workspaceRoot) === true ||
          (project.repositoryIdentity == null && candidate.repositoryIdentity != null)
        ) {
          // Preserve project references when an enrichment refresh repeats known facts.
          if (!sameRepositoryIdentity(project.repositoryIdentity, candidate.repositoryIdentity)) {
            enriched = { ...enriched, repositoryIdentity: candidate.repositoryIdentity };
          }
        }
      }
      if (
        enrichedIdSet.has(project.id) &&
        project.workspaceFile &&
        project.workspaceFile === candidate.workspaceFile
      ) {
        const factsByPath = new Map(
          candidate.folders?.map((folder) => [folderKey(folder), folder]),
        );
        if (project.folders !== undefined) {
          const folders = project.folders.map((folder, index) => {
            const facts = factsByPath.get(folderKey(folder));
            return facts === undefined
              ? folder
              : mergeFolderFacts(
                  folder,
                  {
                    ...facts,
                    ...folder,
                    availability: facts.availability,
                    unavailableReason: facts.unavailableReason,
                    remoteDescription: facts.remoteDescription,
                    vcs: facts.vcs,
                  },
                  index === 0,
                );
          });
          if (folders.some((folder, index) => folder !== project.folders?.[index])) {
            enriched = { ...enriched, folders };
          }
        }
        if (
          candidate.workspaceFileStatus !== undefined &&
          !sameWorkspaceFileStatus(project.workspaceFileStatus, candidate.workspaceFileStatus)
        ) {
          enriched = { ...enriched, workspaceFileStatus: candidate.workspaceFileStatus };
        }
      }
      return enriched;
    });
    return projects.every((project, index) => project === previous.projects[index])
      ? previous
      : { ...previous, projects };
  }

  const previousById = new Map(previous.projects.map((project) => [project.id, project] as const));
  return {
    ...next,
    projects: next.projects.map((project) => {
      const prior = previousById.get(project.id);
      return retainProjectEnrichment(prior, project);
    }),
  };
}

export function applyShellStreamEvent(
  snapshot: OrchestrationV2ShellSnapshot,
  event: Exclude<
    OrchestrationV2ShellStreamItem,
    { readonly kind: "snapshot" } | { readonly kind: "synchronized" }
  >,
): OrchestrationV2ShellSnapshot {
  if (event.sequence <= snapshot.snapshotSequence) return snapshot;

  switch (event.kind) {
    case "project.updated": {
      // Async display facts may be absent from a mutation. Keep identity for
      // the same root, folder facts for the same path, and the linked file's
      // status until enrichment supplies current values.
      const previous = snapshot.projects.find((project) => project.id === event.project.id);
      const project = retainProjectEnrichment(previous, event.project);
      return {
        ...snapshot,
        projects: upsertById(snapshot.projects, project),
        snapshotSequence: event.sequence,
      };
    }
    case "project.removed":
      return {
        ...snapshot,
        projects: snapshot.projects.filter((project) => project.id !== event.projectId),
        snapshotSequence: event.sequence,
      };
    case "thread.updated": {
      const existing =
        event.location === "active"
          ? snapshot.threads.find((thread) => thread.id === event.thread.id)
          : undefined;
      if (existing !== undefined && sameThreadShell(existing, event.thread)) {
        return { ...snapshot, snapshotSequence: event.sequence };
      }
      const withoutThread = (threads: OrchestrationV2ShellSnapshot["threads"]) =>
        threads.filter((thread) => thread.id !== event.thread.id);
      return {
        ...snapshot,
        threads:
          event.location === "active"
            ? upsertById(snapshot.threads, event.thread)
            : withoutThread(snapshot.threads),
        // The archive has its own bounded query/subscription. Older servers may
        // still send archive-located deltas here; remove them from the normal
        // shell instead of growing its persisted cache again.
        archivedThreads: withoutThread(snapshot.archivedThreads),
        snapshotSequence: event.sequence,
      };
    }
    case "thread.removed":
      return {
        ...snapshot,
        threads: snapshot.threads.filter((thread) => thread.id !== event.threadId),
        archivedThreads: snapshot.archivedThreads.filter((thread) => thread.id !== event.threadId),
        snapshotSequence: event.sequence,
      };
    default:
      return snapshot;
  }
}
