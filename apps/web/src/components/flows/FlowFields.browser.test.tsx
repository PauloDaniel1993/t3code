import { useState } from "react";
import * as Effect from "effect/Effect";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { EnvironmentId, ProjectId, type FlowCondition, type FlowStep } from "@t3tools/contracts";
import { render } from "../../../test/render";
import { ConditionForm, StepForm } from "./FlowFields";
import { FlowModelContext } from "./FlowModelPicker";
import { FlowPrompt } from "./FlowPrompt";

const promptImages = vi.hoisted(() => ({
  mint: vi.fn(),
  upload: vi.fn(),
  import: vi.fn(),
  remove: vi.fn(),
}));

vi.mock(import("../../state/attachments"), async (original) => {
  const { attachmentEnvironment } = await original();
  const { Atom } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  return {
    attachmentEnvironment: {
      createUploadUrl: {
        ...attachmentEnvironment.createUploadUrl,
        permissionAtom: () => allowed,
        run: promptImages.mint,
      },
      remove: { ...attachmentEnvironment.remove, run: promptImages.remove },
    },
  };
});

vi.mock(import("../../state/flows"), async (original) => {
  const { flowEnvironment } = await original();
  const { Atom } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  return {
    flowEnvironment: {
      ...flowEnvironment,
      importImage: {
        ...flowEnvironment.importImage,
        permissionAtom: () => allowed,
        run: promptImages.import,
      },
    },
  };
});

vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  readPreparedConnection: (() => ({ httpBaseUrl: "https://fixture.test" })) as never,
}));

vi.mock(import("../../lib/attachmentByteUpload"), () => ({ uploadBytes: promptImages.upload }));

const imageUpload = { attachmentId: "pending-image", relativeUrl: "/api/upload" };
const imagePath = ".t3code/flow/images/original.png";

function setupPromptImages() {
  promptImages.mint.mockReset().mockReturnValue(Effect.succeed(imageUpload));
  promptImages.upload.mockReset().mockResolvedValue(undefined);
  promptImages.import.mockReset().mockReturnValue(Effect.succeed({ path: imagePath }));
  promptImages.remove.mockReset().mockReturnValue(Effect.void);
}

function PromptHarness() {
  const [images, setImages] = useState<ReadonlyArray<string>>([]);
  return (
    <FlowModelContext
      value={{
        environmentId: EnvironmentId.make("flow-environment"),
        projectId: ProjectId.make("flow-project"),
      }}
    >
      <FlowPrompt prompt="" images={images} onPrompt={() => {}} onImages={setImages} />
      <output aria-label="Prompt images">{images.join(", ")}</output>
    </FlowModelContext>
  );
}

function dropPromptImage(prompt: EventTarget, file: File) {
  const dataTransfer = new DataTransfer();
  dataTransfer.items.add(file);
  prompt.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }));
}

it("uploads the original supported Flow image, imports it, and releases its pending slot", async () => {
  setupPromptImages();
  await using screen = await render(<PromptHarness />);
  const canvas = document.createElement("canvas");
  canvas.width = 3000;
  canvas.height = 100;
  const source = new File(
    [
      await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((blob) =>
          blob ? resolve(blob) : reject(new Error("Could not create fixture image")),
        ),
      ),
    ],
    "image.png",
    { type: "image/png" },
  );
  dropPromptImage(screen.getByRole("textbox", { name: "Prompt" }).element(), source);
  await expect.element(screen.getByLabelText("Prompt images")).toHaveTextContent(imagePath);
  expect(promptImages.upload).toHaveBeenCalledWith(expect.objectContaining({ file: source }));
  expect(promptImages.upload.mock.calls[0]?.[0].file).toBe(source);
  expect(promptImages.remove).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
    environmentId: "flow-environment",
    input: { attachmentId: imageUpload.attachmentId },
  });
});

it("deletes a pending Flow image slot when the tile is removed while minting", async () => {
  setupPromptImages();
  const mint = Promise.withResolvers<typeof imageUpload>();
  promptImages.mint.mockReturnValue(Effect.promise(() => mint.promise));
  await using screen = await render(<PromptHarness />);
  const source = new File(["fixture"], "image.png", { type: "image/png" });
  dropPromptImage(screen.getByRole("textbox", { name: "Prompt" }).element(), source);
  await vi.waitFor(() => expect(promptImages.mint).toHaveBeenCalledOnce());
  await screen.getByRole("button", { name: "Remove image.png" }).click();
  mint.resolve(imageUpload);
  await vi.waitFor(() =>
    expect(promptImages.remove).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
      environmentId: "flow-environment",
      input: { attachmentId: imageUpload.attachmentId },
    }),
  );
  expect(promptImages.upload).not.toHaveBeenCalled();
  expect(promptImages.import).not.toHaveBeenCalled();
});

function ConditionHarness({ initial }: { initial: FlowCondition }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <ConditionForm value={value} onChange={setValue} />
      <output aria-label="Condition JSON">{JSON.stringify(value)}</output>
    </>
  );
}
it("round-trips nested conditions while editing typed values", async () => {
  const initial: FlowCondition = {
    all: [
      { ref: "steps.check.output.exitCode", op: "eq", value: 0 },
      { not: { any: [{ ref: "inputs.issue", op: "contains", value: "bug" }] } },
    ],
  };
  await using screen = await render(<ConditionHarness initial={initial} />);
  await expect
    .element(screen.getByLabelText("Condition JSON"))
    .toHaveTextContent(JSON.stringify(initial));
  await userEvent.fill(screen.getByRole("spinbutton", { name: "Value", exact: true }), "2");
  await expect.element(screen.getByLabelText("Condition JSON")).toHaveTextContent(
    JSON.stringify({
      all: [{ ref: "steps.check.output.exitCode", op: "eq", value: 2 }, initial.all[1]],
    }),
  );
});
it("preserves isEmpty without a value when editing a reference", async () => {
  await using screen = await render(
    <ConditionHarness initial={{ ref: "inputs.items", op: "isEmpty" }} />,
  );
  await userEvent.fill(
    screen.getByRole("textbox", { name: "Reference" }),
    "steps.command.output.lines",
  );
  await expect
    .element(screen.getByLabelText("Condition JSON"))
    .toHaveTextContent('{"ref":"steps.command.output.lines","op":"isEmpty"}');
});

function CommandHarness() {
  const [step, setStep] = useState<FlowStep>({
    id: "command",
    kind: "command",
    command: "echo $VALUE",
    env: { VALUE: "{{inputs.issue}}" },
  });
  return (
    <>
      <StepForm onRename={(id) => setStep({ ...step, id })} step={step} onChange={setStep} />
      <output aria-label="Step JSON">{JSON.stringify(step)}</output>
    </>
  );
}

it("keeps focus while renaming command environment variables", async () => {
  await using screen = await render(<CommandHarness />);
  await userEvent.type(
    screen.getByRole("textbox", { name: "Environment variable", exact: true }),
    "_NAME",
  );
  await expect.element(screen.getByLabelText("Step JSON")).toHaveTextContent(
    JSON.stringify({
      id: "command",
      kind: "command",
      command: "echo $VALUE",
      env: { VALUE_NAME: "{{inputs.issue}}" },
    }),
  );
  const id = screen.getByRole("textbox", { name: "Step id", exact: true });
  await userEvent.fill(id, "renamed");
  await expect.element(screen.getByLabelText("Step JSON")).toHaveTextContent(
    JSON.stringify({
      id: "command",
      kind: "command",
      command: "echo $VALUE",
      env: { VALUE_NAME: "{{inputs.issue}}" },
    }),
  );
  await userEvent.keyboard("{Enter}");
  await expect.element(screen.getByLabelText("Step JSON")).toHaveTextContent(
    JSON.stringify({
      id: "renamed",
      kind: "command",
      command: "echo $VALUE",
      env: { VALUE_NAME: "{{inputs.issue}}" },
    }),
  );
  await userEvent.fill(id, "committed-on-blur");
  await userEvent.tab();
  await expect.element(screen.getByLabelText("Step JSON")).toHaveTextContent(
    JSON.stringify({
      id: "committed-on-blur",
      kind: "command",
      command: "echo $VALUE",
      env: { VALUE_NAME: "{{inputs.issue}}" },
    }),
  );
});
