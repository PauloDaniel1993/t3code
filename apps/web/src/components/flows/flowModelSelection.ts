import { ProviderInstanceId, type FlowModel } from "@t3tools/contracts";
export function flowModelInstanceId(value: FlowModel) {
  return value.providerInstanceId.trim() ? ProviderInstanceId.make(value.providerInstanceId) : null;
}
