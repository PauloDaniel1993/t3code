import { EnvironmentId, ProjectId, DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { type ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import type {
  SidebarProjectGroupMember,
  SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import type { NewProjectScriptInput, ProjectScriptEditorDialog } from "../projectScriptEditor";
import type { useSettingsScope } from "./SettingsScopeContext";

type ScopeState = Pick<ReturnType<typeof useSettingsScope>, "scope" | "targets" | "target">;
const state = vi.hoisted(() => ({
  scope: null as ScopeState | null,
  submit: vi.fn(),
  readFile: vi.fn(),
  input: null as NewProjectScriptInput | null,
  error: "",
}));
vi.mock("./useScopedSettings", () => ({ useScopedSettingsWriteAllowed: () => true }));
vi.mock("./SettingsScopeContext", () => ({ useSettingsScope: () => state.scope }));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    environments: ["a", "b"].map((environmentId) => ({
      environmentId,
      serverConfig: {
        settings: DEFAULT_SERVER_SETTINGS,
        workspaceFileProjects: true,
        environment: { capabilities: { projectSettingsOverrides: true } },
      },
    })),
  }),
}));
vi.mock("./useProjectScriptSettings", () => ({
  useProjectScriptSettings: () => ({ saving: false, persist: vi.fn(), submit: state.submit }),
}));
vi.mock("../../hooks/useT3ProjectFileScripts", () => ({
  useT3ProjectFileState: (environmentId: string, cwd: string | null) => {
    state.readFile(environmentId, cwd);
    return {
      status: "valid",
      scripts: [{ name: "Dev", command: "vp dev", runOnWorktreeCreate: true, async: false }],
    };
  },
}));
vi.mock("../projectScriptEditor", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../projectScriptEditor")>()),
  ProjectScriptEditorDialog: (props: React.ComponentProps<typeof ProjectScriptEditorDialog>) =>
    props.request ? (
      <button
        onClick={async () => {
          try {
            await props.onSubmit(props.request!.scriptId, state.input!);
          } catch (error) {
            state.error = error instanceof Error ? error.message : String(error);
          }
        }}
      >
        Save action
      </button>
    ) : null,
}));
vi.mock("./ProjectActionsList", () => ({ ProjectActionsList: () => null }));
vi.mock("./settingsLayout", () => ({
  SettingsSection: ({ children }: { children: ReactNode }) => children,
  SettingsRow: ({ control }: { control?: ReactNode }) => control ?? null,
}));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/select", () => ({
  Select: ({
    onValueChange,
    children,
  }: {
    onValueChange: (value: string) => void;
    children: ReactNode;
  }) => <select onChange={(event) => onValueChange(event.target.value)}>{children}</select>,
  SelectItem: "option",
  SelectPopup: ({ children }: { children: ReactNode }) => children,
  SelectTrigger: () => null,
  SelectValue: () => null,
}));
vi.mock("../ui/menu", () => ({
  Menu: ({ children }: { children: ReactNode }) => children,
  MenuItem: "button",
  MenuTrigger: "div",
  MenuPopup: "div",
  MenuGroup: "div",
  MenuGroupLabel: "span",
  MenuSeparator: "hr",
}));

import { ProjectActionsSettings } from "./ProjectActionsSettings";

function member(environmentId: string): SidebarProjectGroupMember {
  return {
    environmentId: EnvironmentId.make(environmentId),
    id: ProjectId.make(environmentId),
    physicalProjectKey: `${environmentId}:/repos/api`,
    workspaceRoot: "/repos/api",
    title: "Workspace",
    environmentLabel: environmentId,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-10-11T00:00:00.000Z",
    updatedAt: "2026-10-11T00:00:00.000Z",
    folders: [
      { path: "/repos/api", name: "API", label: "api" },
      { path: "/repos/ui", name: "UI", label: "ui" },
    ],
  };
}
const first = member("a");
const second = member("b");
const group: SidebarProjectSnapshot = {
  ...first,
  projectKey: "workspace",
  displayName: "Workspace",
  memberProjects: [first, second],
  memberProjectRefs: [first, second].map((project) => ({
    environmentId: project.environmentId,
    projectId: project.id,
  })),
  groupedProjectCount: 2,
  environmentPresence: "mixed",
  allRemoteMembersAreDesktopLocal: false,
  allRemoteMembersAreWsl: false,
  remoteEnvironmentLabels: [],
};
function selectScope(members: SidebarProjectGroupMember[], environmentId: EnvironmentId | null) {
  const targets = members.map((project) => ({
    environmentId: project.environmentId,
    projectId: project.id,
    label: project.title,
    settings: DEFAULT_SERVER_SETTINGS,
    sources: {} as ScopeState["targets"][number]["sources"],
  }));
  state.scope = {
    scope: {
      kind: "project",
      group,
      label: "Workspace",
      members,
      environmentId,
      environmentIds: members.map((project) => project.environmentId),
    },
    targets,
    target: targets[0]!,
  };
}
function setup() {
  vi.clearAllMocks();
  state.error = "";
  state.submit.mockResolvedValue(AsyncResult.success(undefined));
  selectScope([first], first.environmentId);
  state.input = {
    name: "Dev",
    command: "vp dev",
    icon: "play" as const,
    runOnWorktreeCreate: false,
    waitForSetup: false,
    runOnSettle: false,
    keybinding: null,
    previewUrl: null,
    autoOpenPreview: false,
    folderPath: "/repos/ui",
  };
}

it("rejects a folder-scoped save after switching to all checkouts and reconnecting another environment", async () => {
  setup();
  await using screen = await render(<ProjectActionsSettings />);
  await screen.getByRole("button", { name: "Add action" }).click();
  selectScope([first, second], null);
  await screen.rerender(<ProjectActionsSettings />);
  await screen.getByRole("button", { name: "Save action" }).click();
  await vi.waitFor(() => expect(state.error).toContain("Choose one checkout"));
  expect(state.submit).not.toHaveBeenCalled();
  expect(state.error).toContain("Choose one checkout");
});

it("does not move an open editor's folder scope to another environment", async () => {
  setup();
  await using screen = await render(<ProjectActionsSettings />);
  await screen.getByRole("button", { name: "Add action" }).click();
  selectScope([second], second.environmentId);
  await screen.rerender(<ProjectActionsSettings />);
  await screen.getByRole("button", { name: "Save action" }).click();
  await vi.waitFor(() => expect(state.error).toContain("Choose one checkout"));
  expect(state.submit).not.toHaveBeenCalled();
  expect(state.error).toContain("Choose one checkout");
});

it("does not treat the only connected checkout as an explicit folder-scope target", async () => {
  setup();
  selectScope([first, second], null);
  state.scope = { ...state.scope!, targets: [state.scope!.targets[0]!] };
  await using screen = await render(<ProjectActionsSettings />);
  await screen.getByRole("button", { name: "Add action" }).click();
  await screen.getByRole("button", { name: "Save action" }).click();
  await vi.waitFor(() => expect(state.error).toContain("Choose one checkout"));
  expect(state.submit).not.toHaveBeenCalled();
  expect(state.error).toContain("Choose one checkout");
});

it("imports an equal-name action from a selected secondary folder as a manual scoped action", async () => {
  setup();
  const target: NonNullable<ScopeState["target"]> = {
    ...state.scope!.target!,
    settings: {
      ...DEFAULT_SERVER_SETTINGS,
      defaultProjectScripts: [
        { id: "dev", name: "Dev", command: "vp dev", icon: "play", runOnWorktreeCreate: false },
      ],
    },
  };
  state.scope = { ...state.scope!, target, targets: [target] };
  await using screen = await render(<ProjectActionsSettings />);
  await screen.getByRole("combobox").selectOptions("/repos/ui");
  await screen.getByRole("button", { name: /Dev.*vp dev/ }).click();
  await vi.waitFor(() => expect(state.submit).toHaveBeenCalled());
  expect(state.readFile).toHaveBeenLastCalledWith("a", "/repos/ui");
  expect(state.submit).toHaveBeenCalledWith(
    null,
    expect.objectContaining({
      name: "Dev",
      folderPath: "/repos/ui",
      runOnWorktreeCreate: false,
      waitForSetup: false,
    }),
  );
});

it("keeps the primary import's setup flags", async () => {
  setup();
  await using screen = await render(<ProjectActionsSettings />);
  await screen.getByRole("button", { name: /Dev.*vp dev/ }).click();
  await vi.waitFor(() => expect(state.submit).toHaveBeenCalled());
  expect(state.submit).toHaveBeenCalledWith(
    null,
    expect.objectContaining({
      folderPath: null,
      runOnWorktreeCreate: true,
      waitForSetup: true,
    }),
  );
});
