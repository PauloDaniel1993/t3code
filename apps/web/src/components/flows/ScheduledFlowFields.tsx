import type { FlowDefinitionEntry, ScheduledTask } from "@t3tools/contracts";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Checkbox } from "../ui/checkbox";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Collapsible, CollapsibleTrigger, CollapsiblePanel } from "../ui/collapsible";
import { SettingsField as Field } from "../ui/settings-field";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
  SelectGroup,
} from "../ui/select";

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
  const updateInput = (name: string, text: string) => {
    if (value)
      onChange({
        ...value,
        inputs: Object.fromEntries(
          Object.entries({ ...value.inputs, [name]: text }).filter(([, entry]) => entry !== ""),
        ),
      });
  };
  return (
    <div className="flex flex-col gap-3">
      <Field label="Flow">
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
            <SelectGroup>
              {entries.map((entry) => (
                <SelectItem
                  key={entry.flowId}
                  value={entry.flowId}
                  disabled={!entry.validation.valid}
                >
                  {entry.definition?.title ?? entry.flowId}
                  {!entry.validation.valid && (
                    <Badge variant="error" size="sm">
                      Invalid
                    </Badge>
                  )}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectPopup>
        </Select>
      </Field>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {value && !selected && (
        <Badge variant="error" size="sm">
          Flow not found
        </Badge>
      )}
      {(selected?.definition?.inputs ?? []).map((field) => {
        const current = value?.inputs[field.name] ?? "";
        const placeholder =
          field.default === undefined
            ? ""
            : Array.isArray(field.default)
              ? field.default.join("\n")
              : String(field.default);
        return (
          <Field
            key={field.name}
            label={field.name}
            htmlFor={`flow-input-${field.name}`}
            hint={`${field.type} · ${field.required ? "required" : "optional"}`}
          >
            {field.type === "boolean" ? (
              <div className="flex flex-col gap-1">
                <Checkbox
                  id={`flow-input-${field.name}`}
                  checked={current === "true" || (!current && field.default === true)}
                  onCheckedChange={(checked) => updateInput(field.name, String(checked === true))}
                />
                <Collapsible>
                  <CollapsibleTrigger render={<Button size="xs" variant="ghost" />}>
                    Template or default
                  </CollapsibleTrigger>
                  <CollapsiblePanel>
                    <Input
                      size="sm"
                      aria-label={`${field.name} template`}
                      value={current}
                      placeholder={placeholder}
                      onChange={(event) => updateInput(field.name, event.target.value)}
                    />
                  </CollapsiblePanel>
                </Collapsible>
              </div>
            ) : field.type === "string[]" ? (
              <Textarea
                size="sm"
                id={`flow-input-${field.name}`}
                value={current}
                placeholder={placeholder}
                onChange={(event) => updateInput(field.name, event.target.value)}
              />
            ) : (
              <Input
                size="sm"
                id={`flow-input-${field.name}`}
                value={current}
                placeholder={placeholder}
                onChange={(event) => updateInput(field.name, event.target.value)}
              />
            )}
            {field.description && (
              <p className="text-2xs text-muted-foreground">{field.description}</p>
            )}
          </Field>
        );
      })}
      <p className="text-2xs text-muted-foreground">
        Inputs accept templates such as {"{{body.path}}"}, {"{{headers.name}}"} and{" "}
        {"{{query.name}}"}. Lists accept JSON or one item per line. Blank inputs use their defaults.
      </p>
      <Field label="Base ref" hint="optional" htmlFor="flow-base-ref">
        <Input
          size="sm"
          id="flow-base-ref"
          value={value?.baseRef ?? ""}
          onChange={(event) => {
            if (value) onChange({ ...value, baseRef: event.target.value || undefined });
          }}
        />
      </Field>
    </div>
  );
}
