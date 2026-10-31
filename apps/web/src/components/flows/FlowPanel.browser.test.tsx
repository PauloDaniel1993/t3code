import "~/index.css";
import { expect, it, vi } from "vite-plus/test";
import { userEvent, page } from "vite-plus/test/browser";
import { EnvironmentId, ProjectId, ThreadId, type FlowDefinition } from "@t3tools/contracts";
import { render } from "../../../test/render";
import FlowPanel from "./FlowPanel";
import { flowDrafts, useFlowPanelRequest } from "./flowPanelState";

const state = vi.hoisted(() => ({
  definition: null as FlowDefinition | null,
  calls: [] as Array<{ kind: string; input: unknown }>,
}));
vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
  useAtomValue: () => true,
}));
vi.mock("../../state/flows", () => {
  const query = (kind: string) => () => ({ kind });
  const command = (kind: string) => ({ kind, permissionAtom: () => true });
  return {
    flowEnvironment: {
      list: query("list"),
      runs: query("runs"),
      run: query("run"),
      save: command("save"),
      start: command("start"),
      rename: command("rename"),
      delete: command("delete"),
      validate: command("validate"),
      runsPage: command("runsPage"),
    },
  };
});
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    scheduledTasksLive: () => ({ kind: "schedules" }),
    upsertScheduledTask: { permissionAtom: () => true },
    setScheduledTaskEnabled: { kind: "setEnabled", permissionAtom: () => true },
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (query: { kind: string } | null) => ({
    isPending: false,
    error: null,
    data:
      query?.kind === "list"
        ? {
            flows: [
              {
                flowId: "demo",
                definition: state.definition,
                revision: "r1",
                validation: { valid: true, errors: [] },
              },
            ],
          }
        : query?.kind === "runs"
          ? { runs: [], nextCursor: null }
          : query?.kind === "schedules"
            ? { tasks: [] }
            : null,
  }),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand:
    (command: { kind: string }) =>
    async ({ input }: { input: unknown }) => {
      state.calls.push({ kind: command.kind, input });
      return { _tag: "Success", value: { id: "run", flowId: "demo", revision: "r2", errors: [] } };
    },
}));
vi.mock("./FlowModelPicker", async () => {
  const { createContext } = await import("react");
  return { FlowModelContext: createContext(null), FlowModelPicker: () => null };
});
vi.mock("./FlowCanvas", () => ({ FlowCanvas: () => <div aria-label="Design canvas" /> }));
vi.mock("../settings/ScheduledTasksSettings", () => ({ ScheduledTaskEditorDialog: () => null }));
vi.mock("../settings/SettingsScopeContext", () => ({ SettingsScopeProvider: () => null }));

function setup(definition?: FlowDefinition) {
  state.calls.length = 0;
  state.definition = definition ?? {
    version: 1,
    title: "Demo",
    steps: [{ kind: "command", id: "check", command: "echo ok" }],
    edges: [],
  };
  flowDrafts.clear();
  useFlowPanelRequest.setState({ requests: {} });
  return (
    <FlowPanel
      environmentId={EnvironmentId.make("test")}
      projectId={ProjectId.make("project")}
      threadRef={{ environmentId: EnvironmentId.make("test"), threadId: ThreadId.make("thread") }}
    />
  );
}

it("starts an input-free flow directly from the toolbar", async () => {
  await using screen = await render(setup());
  await userEvent.click(screen.getByRole("button", { name: "Start", exact: true }));
  await expect.element(screen.getByText(/Viewing run/)).toBeVisible();
  expect(state.calls.filter((call) => call.kind === "start")).toEqual([
    { kind: "start", input: { projectId: "project", flowId: "demo", inputs: {} } },
  ]);
  await expect
    .element(page.getByRole("button", { name: "Start flow", exact: true }))
    .not.toBeInTheDocument();
});

it("keeps input collection in a popover until the flow is submitted", async () => {
  const definition: FlowDefinition = {
    version: 1,
    title: "Inputs",
    steps: [{ kind: "command", id: "check", command: "echo ok" }],
    edges: [],
    inputs: [{ name: "issue", type: "string", required: true }],
  };
  await using screen = await render(setup(definition));
  await userEvent.click(screen.getByRole("button", { name: "Start", exact: true }));
  expect(state.calls).toEqual([]);
  await userEvent.fill(page.getByRole("textbox", { name: "issue", exact: true }), "Fix it");
  await userEvent.click(page.getByRole("button", { name: "Start flow", exact: true }));
  expect(state.calls.find((call) => call.kind === "start")?.input).toEqual({
    projectId: "project",
    flowId: "demo",
    inputs: { issue: "Fix it" },
  });
});

it("selects the offending step and exposes flow-level validation problems", async () => {
  await using screen = await render(
    setup({
      version: 1,
      title: "Invalid",
      steps: [{ kind: "command", id: "check", command: "echo {{inputs.issue}}" }],
      edges: [],
      inputs: [
        { name: "issue", type: "string" },
        { name: "issue", type: "string" },
      ],
    }),
  );
  await userEvent.click(screen.getByRole("button", { name: /problems$/ }));
  await expect
    .element(screen.getByRole("textbox", { name: "Step id", exact: true }))
    .toHaveValue("check");
  await expect.element(page.getByText(/inputs\[1\]/)).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: /steps\[0\].command/ }));
  await userEvent.keyboard("{Escape}");
  await expect
    .element(screen.getByRole("textbox", { name: "Step id", exact: true }))
    .toHaveValue("check");
  await expect.element(screen.getByRole("button", { name: "Start", exact: true })).toBeDisabled();
});

it("opens new, rename and delete as dismissible dialogs", async () => {
  await using screen = await render(setup());
  await userEvent.click(screen.getByRole("button", { name: "New flow", exact: true }));
  await expect.element(page.getByRole("dialog", { name: "New flow" })).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await userEvent.click(screen.getByRole("button", { name: "Flow actions" }));
  await userEvent.click(page.getByRole("menuitem", { name: "Rename flow file" }));
  await expect.element(page.getByRole("dialog", { name: "Rename flow file" })).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await userEvent.click(screen.getByRole("button", { name: "Flow actions" }));
  await userEvent.click(page.getByRole("menuitem", { name: "Delete flow", exact: true }));
  await expect.element(page.getByRole("alertdialog", { name: "Delete flow" })).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Cancel", exact: true }));
  expect(state.calls).toEqual([]);
  await userEvent.click(screen.getByRole("button", { name: "New flow", exact: true }));
  await userEvent.fill(page.getByRole("textbox", { name: "New flow id", exact: true }), "fresh");
  await userEvent.click(page.getByRole("button", { name: "Create flow", exact: true }));
  await expect.element(page.getByRole("dialog", { name: "New flow" })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Flow actions" }));
  await userEvent.click(page.getByRole("menuitem", { name: "Rename flow file" }));
  await userEvent.fill(page.getByRole("textbox", { name: "New flow id", exact: true }), "renamed");
  await userEvent.click(page.getByRole("button", { name: "Rename", exact: true }));
  await expect
    .element(page.getByRole("dialog", { name: "Rename flow file" }))
    .not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Flow actions" }));
  await userEvent.click(page.getByRole("menuitem", { name: "Delete flow", exact: true }));
  await userEvent.click(page.getByRole("button", { name: "Confirm delete", exact: true }));
  await expect
    .element(page.getByRole("alertdialog", { name: "Delete flow" }))
    .not.toBeInTheDocument();
  expect(state.calls.map((call) => call.kind)).toEqual(["save", "rename", "delete"]);
});
