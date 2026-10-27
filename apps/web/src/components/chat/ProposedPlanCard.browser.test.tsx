import { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { type ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";

const state = vi.hoisted(() => ({ writeFile: vi.fn(), toast: vi.fn() }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => state.writeFile }));
vi.mock("~/state/session", () => ({
  readEnvironmentScope: () => true,
  useEnvironmentScope: () => true,
}));
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

it("saves a proposed plan in the thread's mapped primary instead of the current project root", async () => {
  state.writeFile
    .mockReset()
    .mockResolvedValue(AsyncResult.success({ relativePath: "plans/plan.md" }));
  state.toast.mockReset();
  await using screen = await render(
    <ProposedPlanCard
      planMarkdown={"# Plan\n\nImplement the change."}
      environmentId={EnvironmentId.make("remote-env")}
      cwd="/session/primary/src"
      workspaceRoot="/new-project-primary"
    />,
  );
  await screen.getByRole("button", { name: "Save to workspace", exact: true }).click();
  await screen.getByRole("textbox").fill("plans/plan.md");
  await screen.getByRole("button", { name: "Save", exact: true }).click();
  await vi.waitFor(() => expect(state.writeFile).toHaveBeenCalled());
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
