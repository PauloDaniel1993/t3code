import type { FlowDefinitionEntry, ScheduledTask } from "@t3tools/contracts";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

export function ScheduledFlowFields({
  entries,
  value,
  error,
  onChange,
}: {
  entries: ReadonlyArray<typeof FlowDefinitionEntry.Type>;
  value: ScheduledTask["flow"];
  error: string | null;
  onChange: (value: NonNullable<ScheduledTask["flow"]>) => void;
}) {
  const selected = entries.find((entry) => entry.flowId === value?.flowId);
  return (
    <div className="space-y-3">
      <Label>Flow</Label>
      <Select
        value={value?.flowId ?? ""}
        onValueChange={(id) => {
          const entry = entries.find((flow) => flow.flowId === id);
          if (entry?.validation.valid) onChange({ flowId: entry.flowId, inputs: {} });
        }}
      >
        <SelectTrigger aria-label="Flow">
          <SelectValue>
            {selected?.definition?.title ?? value?.flowId ?? "Select a flow"}
          </SelectValue>
        </SelectTrigger>
        <SelectPopup>
          {entries.map((entry) => (
            <SelectItem key={entry.flowId} value={entry.flowId} disabled={!entry.validation.valid}>
              {entry.definition?.title ?? entry.flowId}
              {!entry.validation.valid
                ? ` : ${entry.validation.errors.map((issue) => issue.message).join("; ")}`
                : ""}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      {error && <p role="alert">{error}</p>}
      {value && !selected && <p role="status">Flow not found</p>}
      {(selected?.definition?.inputs ?? []).map((field) => (
        <div key={field.name} className="space-y-1">
          <Label htmlFor={`flow-input-${field.name}`}>
            {field.name} · {field.type}
            {field.required ? " (required)" : ""}
          </Label>
          <Textarea
            id={`flow-input-${field.name}`}
            value={value?.inputs[field.name] ?? ""}
            placeholder={
              field.default === undefined
                ? ""
                : Array.isArray(field.default)
                  ? field.default.join("\n")
                  : String(field.default)
            }
            onChange={(event) => {
              if (value)
                onChange({
                  ...value,
                  inputs: Object.fromEntries(
                    Object.entries({ ...value.inputs, [field.name]: event.target.value }).filter(
                      ([, text]) => text !== "",
                    ),
                  ),
                });
            }}
          />
          {field.description && (
            <p className="text-xs text-muted-foreground">{field.description}</p>
          )}
        </div>
      ))}
      <p className="text-xs text-muted-foreground">
        Inputs accept templates, including webhook placeholders such as {"{{body.path}}"},{" "}
        {"{{headers.name}}"} and {"{{query.name}}"}. Lists accept a JSON array or one item per line.
        Blank inputs use their declared defaults.
      </p>
      <Label htmlFor="flow-base-ref">Base ref (optional)</Label>
      <Input
        id="flow-base-ref"
        value={value?.baseRef ?? ""}
        onChange={(event) => {
          if (value) onChange({ ...value, baseRef: event.target.value || undefined });
        }}
      />
    </div>
  );
}
