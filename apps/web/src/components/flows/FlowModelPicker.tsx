import { createContext, useContext } from "react";
import { useAtomValue } from "@effect/atom-react";
import { type EnvironmentId, type ProjectId, type FlowModel } from "@t3tools/contracts";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { providerInstanceEntriesFor } from "../../providerInstances";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { flowModelInstanceId } from "./flowModelSelection";
import { Choice } from "./FlowFields";
export const FlowModelContext = createContext<{
  environmentId: EnvironmentId;
  projectId: ProjectId;
} | null>(null);
export function FlowModelPicker({
  value,
  onChange,
}: {
  value: FlowModel;
  onChange: (value: FlowModel) => void;
}) {
  const context = useContext(FlowModelContext);
  return context ? <EnvironmentModelPicker {...context} value={value} onChange={onChange} /> : null;
}
function EnvironmentModelPicker({
  environmentId,
  projectId,
  value,
  onChange,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  value: FlowModel;
  onChange: (value: FlowModel) => void;
}) {
  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const entries = providerInstanceEntriesFor(providers, settings, projectId);
  const instanceId = flowModelInstanceId(value);
  const models = getCustomModelOptionsByInstance(settings, providers, instanceId, value.model);
  const descriptors =
    providers
      .find((provider) => provider.instanceId === value.providerInstanceId)
      ?.models.find((model) => model.slug === value.model)?.capabilities?.optionDescriptors ?? [];
  if (!instanceId)
    return (
      <Choice
        label="Provider"
        value=""
        values={["", ...entries.map((entry) => entry.instanceId)]}
        onChange={(id) => {
          const entry = entries.find((entry) => entry.instanceId === id);
          if (entry)
            onChange({
              providerInstanceId: entry.instanceId,
              model: models.get(entry.instanceId)?.[0]?.slug ?? "",
            });
        }}
      />
    );
  return (
    <>
      <ProviderModelPicker
        environmentId={environmentId}
        activeInstanceId={instanceId}
        model={value.model}
        lockedProvider={null}
        instanceEntries={entries}
        modelOptionsByInstance={models}
        isComposerOwned={false}
        onInstanceModelChange={(providerInstanceId, model) =>
          onChange({ providerInstanceId, model })
        }
      />
      {descriptors.map((option) => (
        <Choice
          key={option.id}
          label={option.label}
          value={String(value.options?.[option.id] ?? "inherit")}
          values={[
            "inherit",
            ...(option.type === "boolean"
              ? ["true", "false"]
              : option.options.map((choice) => choice.id)),
          ]}
          onChange={(next) => {
            const options = { ...value.options };
            if (next === "inherit") delete options[option.id];
            else options[option.id] = option.type === "boolean" ? next === "true" : next;
            onChange({ ...value, options });
          }}
        />
      ))}
    </>
  );
}
