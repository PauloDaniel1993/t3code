import { EnvironmentId, ProjectId, ThreadId, type VcsStatusResult } from "@t3tools/contracts";
import type { WorkspaceThread } from "@t3tools/shared/workspaceFolders";
import { act, createElement, type ReactNode } from "react";
import { create, type ReactTestRenderer, type ReactTestInstance } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { workspaceFolderRows, type WorkspaceFoldersProject } from "../workspaceFolders.logic";
import { WorkspaceVersionControl } from "./WorkspaceVersionControl";

const fixtures = vi.hoisted(() => ({
  statuses: [] as Array<{ status: VcsStatusResult | null; error: boolean }>,
  run: vi.fn(),
  switchBranch: vi.fn(),
  openLink: vi.fn(),
  queries: vi.fn(),
}));
vi.mock("../../state/workspaceVcs", () => ({
  useWorkspaceStatuses: (...args: unknown[]) => {
    fixtures.queries(...args);
    return fixtures.statuses;
  },
}));
vi.mock("../../state/vcs", () => ({
  vcsEnvironment: { runWorkspaceAction: "run", switchWorktreeSetBranch: "switch" },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: string) => (command === "run" ? fixtures.run : fixtures.switchBranch),
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
let renderer: ReactTestRenderer;
const text = () => JSON.stringify(renderer.toJSON());
const nodeText = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.children.map(nodeText).join("");
const button = (label: string) =>
  renderer.root.findAllByType("button").find((node) => nodeText(node) === label)!;
const render = async (
  scope: WorkspaceThread = thread,
  workspace: WorkspaceFoldersProject = project,
) => {
  await act(() => {
    renderer = create(
      <WorkspaceVersionControl
        environmentId={environmentId}
        threadId={threadId}
        project={workspace}
        thread={scope}
        rows={workspaceFolderRows(workspace, scope)}
      />,
    );
  });
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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
});
afterEach(async () => {
  if (renderer) await act(() => renderer.unmount());
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it("asks for one message and shows independent repository failures after Commit all", async () => {
  await render();
  await act(() => button("Commit all").props.onClick());
  expect(button("Continue").props.disabled).toBe(true);
  await act(() =>
    renderer.root.findByType("textarea").props.onChange({ target: { value: "  Update both  " } }),
  );
  await act(async () => {
    button("Continue").props.onClick();
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
  expect(text()).toContain("Commit hook rejected");
  expect(text()).toContain("Repository is unavailable");
  expect(renderer.root.findAllByType("textarea")).toHaveLength(0);
});

it("pauses batches for drift while keeping individual actions and switching only the drifted member back", async () => {
  fixtures.statuses[1]!.status = status("other");
  await render();
  expect(button("Commit all").props.disabled).toBe(true);
  expect(button("Push all").props.disabled).toBe(true);
  expect(button("Create PRs (2)").props.disabled).toBe(true);
  await act(() => button("Per-repo breakdown2").props.onClick());
  expect(text()).toContain("Individual repository actions");
  await act(async () => {
    button("Switch back to feature-web").props.onClick();
  });
  expect(fixtures.switchBranch).toHaveBeenCalledWith({
    environmentId,
    input: { threadId, branch: "feature-web", members: ["/web"] },
  });
  expect(fixtures.run).not.toHaveBeenCalled();
});

it("allows batches on Mixed branches in current-checkout threads", async () => {
  fixtures.statuses[1]!.status = status("release");
  await render({ ...thread, worktreePath: null, worktrees: undefined });
  expect(text()).toContain("Mixed branches");
  expect(button("Commit all").props.disabled).toBe(false);
  expect(text()).not.toContain("Batch actions paused");
});
it("keeps a checkout with a healthy sibling folder and uses the root when its first folder disappears", async () => {
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
  await render(scope, workspace);
  expect(fixtures.queries).toHaveBeenCalledWith(environmentId, ["/set/api", "/set/web"]);
  expect(button("Push all").props.disabled).toBe(false);
  await act(() => button("2 files changed across 2 repos+2 −0").props.onClick());
  expect(text()).toContain("healthy/fix.ts");
  await act(() => button("Push all").props.onClick());
  await act(async () => {
    button("Continue").props.onClick();
  });
  expect(fixtures.run).toHaveBeenCalledWith({
    environmentId,
    input: expect.objectContaining({ action: "push", members: ["/api", "/web"] }),
  });
});
it("does not treat a nested independent repository as a healthy folder of its unavailable parent", async () => {
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
  await render(scope, workspace);
  expect(fixtures.queries).toHaveBeenCalledWith(environmentId, [
    "/set/api",
    null,
    "/set/web/child",
  ]);
  await act(() => button("Push all").props.onClick());
  await act(async () => {
    button("Continue").props.onClick();
  });
  expect(fixtures.run).toHaveBeenCalledWith({
    environmentId,
    input: expect.objectContaining({ members: ["/api", "/web/child"] }),
  });
});
