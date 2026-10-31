import { expect, it } from "vite-plus/test";
import { flowModelInstanceId } from "./flowModelSelection";
it.each(["", "   ", "devReplay"])("handles override provider %j before model selection", (id) => {
  expect(flowModelInstanceId({ providerInstanceId: id, model: "" })).toBe(id.trim() ? id : null);
});
