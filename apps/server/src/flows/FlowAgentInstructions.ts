// @effect-diagnostics preferSchemaOverJson:off -- Describe declared output fields in the step prompt.
import type { FlowOutputField } from "@t3tools/contracts";

export const flowReportInstruction = (outputs: ReadonlyArray<FlowOutputField> | undefined) =>
  outputs?.length
    ? `\n\nBefore finishing, call t3_flow_report with fields matching: ${JSON.stringify(outputs)}.`
    : "";
