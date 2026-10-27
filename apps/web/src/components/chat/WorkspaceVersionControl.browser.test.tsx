import { EnvironmentId, ProjectId, ThreadId, type VcsStatusResult } from "@t3tools/contracts";
import type { WorkspaceThread } from "@t3tools/shared/workspaceFolders";
import { createElement, type ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { act, render, type Screen } from "../../../test/render";
import { workspaceFolderRows, type WorkspaceFoldersProject } from "../workspaceFolders.logic";
import { WorkspaceVersionControl } from "./WorkspaceVersionControl";

const fixtures = vi.hoisted(() => ({
  statuses: [] as Array<{ status: VcsStatusResult | null; error: boolean }>,
  run: vi.fn(),
  switchBranch: vi.fn(),
  openLink: vi.fn(),
  queries: vi.fn(),
  canRun: true,
  canSwitch: true,
}));
vi.mock("../../state/workspaceVcs", () => ({
  useWorkspaceStatuses: (...args: unknown[]) => {
    fixtures.queries(...args);
    return fixtures.statuses;
  },
}));
const permission = (atom: { kind: string }) =>
  atom.kind === "run-permission" ? fixtures.canRun : fixtures.canSwitch;
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: { kind: string }) => permission(atom),
}));
vi.mock("../../rpc/atomRegistry", () => ({
  appAtomRegistry: { get: (atom: { kind: string }) => permission(atom) },
}));
vi.mock("../../state/vcs", () => ({
  vcsEnvironment: {
    runWorkspaceAction: { label: "run", permissionAtom: () => ({ kind: "run-permission" }) },
    switchWorktreeSetBranch: {
      label: "switch",
      permissionAtom: () => ({ kind: "branch-permission" }),
    },
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: { label: string }) =>
    command.label === "run" ? fixtures.run : fixtures.switchBranch,
}));
vi.mock("../../browser/useOpenLink", () => ({ useOpenLink: () => fixtures.openLink }));
vi.mock("../../state/queries", () => ({ usePaginatedBranches: () => ({ refs: [], data: null }) }));
vi.mock("../GitActionsControl", () => ({
  default: () => <div>Individual repository actions</div>,
}));
vi.mock("../ui/button", () => ({ Button: (props: object) => createElement("button", props) }));
vi.mock("../ui/input", () => ({ Input: (props: object) => createElement("input", props) }));
vi.mock("../ui/textarea", () => ({
  Textarea: (props: object) => createElement("textarea", props),
}));
vi.mock("../ui/dialog", () => {
  const Container = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Dialog: ({ open, children }: { open: boolean; children?: ReactNode }) =>
      open ? <div>{children}</div> : null,
    DialogPopup: Container,
    DialogHeader: Container,
    DialogTitle: Container,
    DialogDescription: Container,
    DialogPanel: Container,
    DialogFooter: Container,
  };
});

const environmentId = EnvironmentId.make("remote");
const threadId = ThreadId.make("thread");
const project = {
  id: ProjectId.make("project"),
  workspaceRoot: "/api",
  folders: [
    {
      name: "API",
      label: "api",
      path: "/api",
      availability: "available" as const,
      vcs: { checkoutRoot: "/api" },
    },
    {
      name: "Web",
      label: "web",
      path: "/web",
      availability: "available" as const,
      vcs: { checkoutRoot: "/web" },
    },
  ],
};
const thread = {
  worktreePath: "/set/api",
  workspaceFolders: project.folders.map((folder) => ({ ...folder, checkoutRoot: folder.path })),
  worktrees: [
    { repositoryRoot: "/api", path: "/set/api", branch: "feature" },
    { repositoryRoot: "/web", path: "/set/web", branch: "feature-web" },
  ],
};
const status = (refName: string): VcsStatusResult => ({
  isRepo: true,
  hasPrimaryRemote: true,
  refName,
  isDefaultRef: false,
  hasWorkingTreeChanges: true,
  hasUpstream: true,
  aheadCount: 0,
  behindCount: 0,
  pr: null,
  workingTree: {
    files: [{ path: "changed.ts", insertions: 1, deletions: 0 }],
    insertions: 1,
    deletions: 0,
  },
});
const text = (screen: Screen) => screen.container.textContent ?? "";
const button = (screen: Screen, label: string | RegExp) => {
  const element = screen
    .getByRole("button", { name: label, exact: typeof label === "string" })
    .element();
  if (!(element instanceof HTMLButtonElement)) throw new Error(`Expected a button for ${label}`);
  return element;
};
const renderWorkspace = (
  scope: WorkspaceThread = thread,
  workspace: WorkspaceFoldersProject = project,
) =>
  render(
    <WorkspaceVersionControl
      environmentId={environmentId}
      threadId={threadId}
      project={workspace}
      thread={scope}
      rows={workspaceFolderRows(workspace, scope)}
    />,
  );

function setup() {
  fixtures.canRun = true;
  fixtures.canSwitch = true;
  vi.clearAllMocks();
  fixtures.statuses = ["feature", "feature-web"].map((refName) => ({
    status: status(refName),
    error: false,
  }));
  fixtures.run.mockResolvedValue({
    _tag: "Success",
    value: {
      results: [
        {
          repositoryRoot: "/api",
          cwd: "/set/api",
          label: "api",
          outcome: { _tag: "failed", message: "Commit hook rejected" },
        },
        {
          repositoryRoot: "/web",
          cwd: "/set/web",
          label: "web",
          outcome: { _tag: "unavailable", reason: "Repository is unavailable" },
        },
      ],
    },
  });
  fixtures.switchBranch.mockResolvedValue({ _tag: "Success", value: undefined });
}

it("asks for one message and shows independent repository failures after Commit all", async () => {
  setup();
  await using screen = await renderWorkspace();
  await act(() => button(screen, "Commit all").click());
  expect(button(screen, "Continue").disabled).toBe(true);
  await screen.getByRole("textbox").fill("  Update both  ");
  await act(async () => {
    button(screen, "Continue").click();
  });
  expect(fixtures.run).toHaveBeenCalledWith({
    environmentId,
    input: expect.objectContaining({
      threadId,
      action: "commit",
      commitMessage: "Update both",
      members: ["/api", "/web"],
    }),
  });
  expect(text(screen)).toContain("Commit hook rejected");
  expect(text(screen)).toContain("Repository is unavailable");
  expect(screen.container.querySelectorAll("textarea")).toHaveLength(0);
});

it("pauses batches for drift while keeping individual actions and switching only the drifted member back", async () => {
  setup();
  fixtures.statuses[1]!.status = status("other");
  await using screen = await renderWorkspace();
  expect(button(screen, "Commit all").disabled).toBe(true);
  expect(button(screen, "Push all").disabled).toBe(true);
  expect(button(screen, "Create PRs (2)").disabled).toBe(true);
  await act(() => button(screen, /^Per-repo breakdown/).click());
  expect(text(screen)).toContain("Individual repository actions");
  await act(async () => {
    button(screen, "Switch back to feature-web").click();
  });
  expect(fixtures.switchBranch).toHaveBeenCalledWith({
    environmentId,
    input: { threadId, branch: "feature-web", members: ["/web"] },
  });
  expect(fixtures.run).not.toHaveBeenCalled();
});

it("allows batches on Mixed branches in current-checkout threads", async () => {
  setup();
  fixtures.statuses[1]!.status = status("release");
  await using screen = await renderWorkspace({
    ...thread,
    worktreePath: null,
    worktrees: undefined,
  });
  expect(text(screen)).toContain("Mixed branches");
  expect(button(screen, "Commit all").disabled).toBe(false);
  expect(text(screen)).not.toContain("Batch actions paused");
});
it("runs the healthy members when another checkout disappears", async () => {
  setup();
  fixtures.statuses[1] = { status: null, error: true };
  await using screen = await renderWorkspace();
  await act(() => button(screen, "Push all").click());
  await act(async () => {
    button(screen, "Continue").click();
  });
  expect(fixtures.run).toHaveBeenCalledWith({
    environmentId,
    input: expect.objectContaining({ members: ["/api"], cwds: ["/set/api"] }),
  });
  expect(text(screen)).not.toContain("Loading branches");
});
it("keeps created PR links in the results until the user opens them", async () => {
  setup();
  fixtures.run.mockResolvedValue({
    _tag: "Success",
    value: {
      results: [
        {
          repositoryRoot: "/api",
          cwd: "/set/api",
          label: "api",
          outcome: {
            _tag: "completed",
            result: {
              toast: { title: "Created PR" },
              pr: { url: "https://example.com/pr/1" },
            },
          },
        },
      ],
    },
  });
  await using screen = await renderWorkspace();
  await act(() => button(screen, "Create PRs (2)").click());
  await act(async () => {
    button(screen, "Continue").click();
  });
  expect(fixtures.openLink).not.toHaveBeenCalled();
  await act(() => button(screen, "Open PR").click());
  expect(fixtures.openLink).toHaveBeenCalledWith("https://example.com/pr/1");
});
it("keeps a checkout with a healthy sibling folder and uses the root when its first folder disappears", async () => {
  setup();
  const missing = { ...project.folders[1]!, path: "/web/missing" };
  const healthy = { ...missing, path: "/web/healthy", name: "Healthy", label: "healthy" };
  const scope = {
    ...thread,
    workspaceFolders: [
      thread.workspaceFolders[0]!,
      { ...missing, checkoutRoot: "/web" },
      { ...healthy, checkoutRoot: "/web" },
    ],
  };
  const workspace = {
    ...project,
    folders: [project.folders[0]!, { ...missing, availability: "unavailable" as const }, healthy],
  };
  const webStatus = status("feature-web");
  fixtures.statuses[1]!.status = {
    ...webStatus,
    workingTree: {
      ...webStatus.workingTree,
      files: [{ path: "healthy/fix.ts", insertions: 1, deletions: 0 }],
    },
  };
  await using screen = await renderWorkspace(scope, workspace);
  expect(fixtures.queries).toHaveBeenCalledWith(environmentId, ["/set/api", "/set/web"]);
  expect(button(screen, "Push all").disabled).toBe(false);
  await act(() => button(screen, /^2 files changed across 2 repos/).click());
  expect(text(screen)).toContain("healthy/fix.ts");
  await act(() => button(screen, "Push all").click());
  await act(async () => {
    button(screen, "Continue").click();
  });
  expect(fixtures.run).toHaveBeenCalledWith({
    environmentId,
    input: expect.objectContaining({ action: "push", members: ["/api", "/web"] }),
  });
});
it("does not treat a nested independent repository as a healthy folder of its unavailable parent", async () => {
  setup();
  const child = {
    ...project.folders[1]!,
    path: "/web/child",
    name: "Child",
    label: "child",
    vcs: { checkoutRoot: "/web/child" },
  };
  const workspace = {
    ...project,
    folders: [
      project.folders[0]!,
      { ...project.folders[1]!, availability: "unavailable" as const },
      child,
    ],
  };
  const scope = {
    ...thread,
    workspaceFolders: [...thread.workspaceFolders, { ...child, checkoutRoot: "/web/child" }],
    worktrees: [
      ...thread.worktrees,
      { repositoryRoot: "/web/child", path: "/set/web/child", branch: "feature" },
    ],
  };
  fixtures.statuses = [
    { status: status("feature"), error: false },
    { status: null, error: false },
    { status: status("feature"), error: false },
  ];
  await using screen = await renderWorkspace(scope, workspace);
  expect(fixtures.queries).toHaveBeenCalledWith(environmentId, [
    "/set/api",
    null,
    "/set/web/child",
  ]);
  await act(() => button(screen, "Push all").click());
  await act(async () => {
    button(screen, "Continue").click();
  });
  expect(fixtures.run).toHaveBeenCalledWith({
    environmentId,
    input: expect.objectContaining({ members: ["/api", "/web/child"] }),
  });
});

it("disables workspace mutations without the command permissions", async () => {
  setup();
  fixtures.canRun = false;
  fixtures.canSwitch = false;
  fixtures.statuses[1]!.status = status("other");
  await using screen = await renderWorkspace();
  expect(button(screen, "Commit all").disabled).toBe(true);
  expect(button(screen, "Push all").disabled).toBe(true);
  expect(button(screen, "Switch shared branch").disabled).toBe(true);
  await act(() => button(screen, /^Per-repo breakdown/).click());
  expect(button(screen, "Switch back to feature-web").disabled).toBe(true);
  await act(async () => button(screen, "Switch back to feature-web").click());
  expect(fixtures.switchBranch).not.toHaveBeenCalled();
});

it("keeps batch Git actions available while worktree branch changes require the extra scope", async () => {
  setup();
  fixtures.canSwitch = false;
  await using screen = await renderWorkspace();
  expect(button(screen, "Push all").disabled).toBe(false);
  expect(button(screen, "Switch shared branch").disabled).toBe(true);
});

it("rechecks the grant when confirming an already-open workspace action", async () => {
  setup();
  await using screen = await renderWorkspace();
  await act(() => button(screen, "Push all").click());
  fixtures.canRun = false;
  await act(async () => button(screen, "Continue").click());
  expect(fixtures.run).not.toHaveBeenCalled();
});

it("rechecks the grant when switching a drifted checkout back", async () => {
  setup();
  fixtures.statuses[1]!.status = status("other");
  await using screen = await renderWorkspace();
  await act(() => button(screen, /^Per-repo breakdown/).click());
  const switchBack = button(screen, "Switch back to feature-web");
  expect(switchBack.disabled).toBe(false);
  fixtures.canSwitch = false;
  await act(() => switchBack.click());
  expect(fixtures.switchBranch).not.toHaveBeenCalled();
});
