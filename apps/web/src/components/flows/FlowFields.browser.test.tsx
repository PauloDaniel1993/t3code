import { useState } from "react";
import { expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import type { FlowCondition } from "@t3tools/contracts";
import { render } from "../../../test/render";
import { ConditionForm } from "./FlowFields";

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
