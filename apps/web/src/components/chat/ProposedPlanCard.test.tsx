import { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ writeFile: vi.fn(), toast: vi.fn() }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => state.writeFile }));
vi.mock("~/state/projects", () => ({ projectEnvironment: { writeFile: {} } }));
vi.mock("~/hooks/useCopyToClipboard", () => ({
  useCopyToClipboard: () => ({ copyToClipboard: vi.fn(), isCopied: false }),
}));
vi.mock("../ChatMarkdown", () => ({ default: () => null }));
vi.mock("../ui/toast", () => ({
  toastManager: { add: state.toast },
  stackedThreadToast: (value: unknown) => value,
}));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/input", () => ({ Input: "input" }));
vi.mock("../ui/badge", () => ({ Badge: "span" }));
vi.mock("../ui/menu", () => ({
  Menu: ({ children }: { children: ReactNode }) => children,
  MenuItem: "button",
  MenuPopup: "div",
  MenuTrigger: "div",
}));
vi.mock("../ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? children : null),
  DialogDescription: "p",
  DialogFooter: "footer",
  DialogHeader: "header",
  DialogPanel: "section",
  DialogPopup: "section",
  DialogTitle: "h2",
}));

import { ProposedPlanCard } from "./ProposedPlanCard";

let renderer: ReactTestRenderer | null = null;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.writeFile.mockReset();
  state.toast.mockReset();
  state.writeFile.mockResolvedValue(AsyncResult.success({ relativePath: "plans/plan.md" }));
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  vi.unstubAllGlobals();
});

it("saves a proposed plan in the thread's mapped primary instead of the current project root", async () => {
  act(() => {
    renderer = create(
      <ProposedPlanCard
        planMarkdown={"# Plan\n\nImplement the change."}
        environmentId={EnvironmentId.make("remote-env")}
        cwd="/session/primary/src"
        workspaceRoot="/new-project-primary"
      />,
    );
  });
  act(() => {
    renderer!.root
      .findAllByType("button")
      .find((button) => button.children.includes("Save to workspace"))!
      .props.onClick();
  });
  act(() => {
    renderer!.root.findByType("input").props.onChange({ target: { value: "plans/plan.md" } });
  });
  await act(async () => {
    renderer!.root
      .findAllByType("button")
      .find((button) => button.children.includes("Save"))!
      .props.onClick();
  });
  expect(state.writeFile).toHaveBeenCalledWith({
    environmentId: EnvironmentId.make("remote-env"),
    input: {
      cwd: "/session/primary/src",
      relativePath: "plans/plan.md",
      contents: "# Plan\n\nImplement the change.\n",
    },
  });
  expect(state.toast).toHaveBeenCalledWith(
    expect.objectContaining({ title: "Plan saved to workspace" }),
  );
});
