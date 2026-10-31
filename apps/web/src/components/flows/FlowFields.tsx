/* oxlint-disable react/no-array-index-key -- Form slots are controlled values; their editable names and condition shapes cannot serve as keys. */
import type { ReactNode } from "react";
import type {
  FlowCondition,
  FlowInput,
  FlowModel,
  FlowOutputField,
  FlowStep,
  FlowValue,
  RuntimeMode,
  ProviderInteractionMode,
} from "@t3tools/contracts";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectPopup,
  SelectItem,
  SelectGroup,
} from "../ui/select";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-xs">
      <span>{label}</span>
      {children}
    </label>
  );
}

export function Choice({
  label,
  value,
  values,
  onChange,
  labels,
}: {
  label: string;
  value: string;
  values: ReadonlyArray<string>;
  labels?: Readonly<Record<string, string>>;
  onChange: (value: string) => void;
}) {
  return (
    <Field label={label}>
      <Select
        value={value}
        onValueChange={(value) => {
          if (value !== null) onChange(value);
        }}
      >
        <SelectTrigger size="sm" aria-label={label}>
          <SelectValue>{labels?.[value] ?? value}</SelectValue>
        </SelectTrigger>
        <SelectPopup>
          <SelectGroup>
            {values.map((item) => (
              <SelectItem key={item} value={item}>
                {labels?.[item] ?? item}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectPopup>
      </Select>
    </Field>
  );
}

export function TextField({
  label,
  value,
  onChange,
  multiline = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  multiline?: boolean;
}) {
  return (
    <Field label={label}>
      {multiline ? (
        <Textarea
          aria-label={label}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <Input
          size="compact"
          aria-label={label}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </Field>
  );
}

function NumberField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <Field label={label}>
      <Input
        size="compact"
        type="number"
        aria-label={label}
        value={value}
        onChange={(event) => {
          if (event.target.value !== "" && Number.isFinite(Number(event.target.value)))
            onChange(Number(event.target.value));
        }}
      />
    </Field>
  );
}

const valueTypes = ["string", "number", "boolean", "string[]"] as const;
function valueType(value: FlowValue) {
  return Array.isArray(value) ? "string[]" : typeof value;
}
function ValueField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: FlowValue;
  onChange: (value: FlowValue) => void;
}) {
  if (typeof value === "boolean")
    return (
      <Choice
        label={label}
        value={String(value)}
        values={["true", "false"]}
        onChange={(next) => onChange(next === "true")}
      />
    );
  if (typeof value === "number")
    return <NumberField label={label} value={value} onChange={onChange} />;
  return (
    <TextField
      label={label}
      multiline={Array.isArray(value)}
      value={typeof value === "string" ? value : value.join("\n")}
      onChange={(next) => onChange(typeof value === "string" ? next : next.split("\n"))}
    />
  );
}
function emptyValue(type: string): FlowValue {
  return type === "boolean" ? false : type === "number" ? 0 : type === "string[]" ? [] : "";
}

const emptyCondition: FlowCondition = { ref: "", op: "eq", value: "" };
export function ConditionForm({
  value,
  onChange,
}: {
  value: FlowCondition;
  onChange: (value: FlowCondition) => void;
}) {
  const kind =
    "all" in value ? "all" : "any" in value ? "any" : "not" in value ? "not" : "comparison";
  return (
    <fieldset className="flex min-w-0 flex-col gap-2 rounded border border-border p-2">
      <legend className="text-xs">Condition</legend>
      <Choice
        label="Condition kind"
        value={kind}
        values={["comparison", "all", "any", "not"]}
        onChange={(next) =>
          onChange(
            next === "all"
              ? { all: [emptyCondition] }
              : next === "any"
                ? { any: [emptyCondition] }
                : next === "not"
                  ? { not: emptyCondition }
                  : emptyCondition,
          )
        }
      />
      {"not" in value ? (
        <ConditionForm value={value.not} onChange={(not) => onChange({ not })} />
      ) : "all" in value || "any" in value ? (
        <>
          {("all" in value ? value.all : value.any).map((condition, index, conditions) => (
            <div key={index} className="flex flex-col gap-1">
              <ConditionForm
                value={condition}
                onChange={(next) => {
                  const children = conditions.map((child, i) => (i === index ? next : child));
                  onChange("all" in value ? { all: children } : { any: children });
                }}
              />
              <Button
                size="xs"
                variant="ghost"
                onClick={() => {
                  const children = conditions.filter((_, i) => i !== index);
                  onChange("all" in value ? { all: children } : { any: children });
                }}
              >
                Remove condition
              </Button>
            </div>
          ))}
          <Button
            size="xs"
            variant="outline"
            onClick={() =>
              onChange(
                "all" in value
                  ? { all: [...value.all, emptyCondition] }
                  : { any: [...value.any, emptyCondition] },
              )
            }
          >
            Add condition
          </Button>
        </>
      ) : (
        <>
          <TextField
            label="Reference"
            value={value.ref}
            onChange={(ref) => onChange({ ...value, ref })}
          />
          <Choice
            label="Operator"
            value={value.op}
            values={["eq", "neq", "lt", "lte", "gt", "gte", "contains", "isEmpty"]}
            onChange={(op) => {
              if (op === "isEmpty") onChange({ ref: value.ref, op });
              else if (
                op === "eq" ||
                op === "neq" ||
                op === "lt" ||
                op === "lte" ||
                op === "gt" ||
                op === "gte" ||
                op === "contains"
              )
                onChange({ ref: value.ref, op, value: "value" in value ? value.value : "" });
            }}
          />
          {"value" in value && (
            <>
              <Choice
                label="Value type"
                value={valueType(value.value)}
                values={valueTypes}
                onChange={(type) => onChange({ ...value, value: emptyValue(type) })}
              />
              <ValueField
                label="Value"
                value={value.value}
                onChange={(next) => onChange({ ...value, value: next })}
              />
            </>
          )}
        </>
      )}
    </fieldset>
  );
}

function OutputFieldsForm({
  fields,
  onChange,
}: {
  fields: ReadonlyArray<FlowOutputField>;
  onChange: (fields: ReadonlyArray<FlowOutputField>) => void;
}) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend>Output fields</legend>
      {fields.map((field, index) => {
        const update = (next: FlowOutputField) =>
          onChange(fields.map((entry, i) => (i === index ? next : entry)));
        return (
          <div key={index} className="flex flex-col gap-2 rounded border border-border p-2">
            <TextField
              label="Output name"
              value={field.name}
              onChange={(name) => update({ ...field, name })}
            />
            <Choice
              label="Output type"
              value={field.type}
              values={[...valueTypes, "enum"]}
              onChange={(type) => {
                if (type === "enum") update({ name: field.name, type, values: ["value"] });
                else if (
                  type === "string" ||
                  type === "number" ||
                  type === "boolean" ||
                  type === "string[]"
                )
                  update({ name: field.name, type });
              }}
            />
            {field.type === "enum" && (
              <TextField
                label="Enum values (one per line)"
                multiline
                value={field.values.join("\n")}
                onChange={(next) => update({ ...field, values: next.split("\n") })}
              />
            )}
            <Button
              variant="ghost"
              size="xs"
              onClick={() => onChange(fields.filter((_, i) => i !== index))}
            >
              Remove output
            </Button>
          </div>
        );
      })}
      <Button
        variant="outline"
        size="xs"
        onClick={() => onChange([...fields, { name: "result", type: "string" }])}
      >
        Add output field
      </Button>
    </fieldset>
  );
}

export function InputFieldsForm({
  fields,
  onChange,
}: {
  fields: ReadonlyArray<FlowInput>;
  onChange: (fields: ReadonlyArray<FlowInput>) => void;
}) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend>Flow inputs</legend>
      {fields.map((field, index) => {
        const update = (next: FlowInput) =>
          onChange(fields.map((entry, i) => (i === index ? next : entry)));
        return (
          <div key={index} className="flex flex-col gap-2 rounded border border-border p-2">
            <TextField
              label="Input name"
              value={field.name}
              onChange={(name) => update({ ...field, name })}
            />
            <TextField
              label="Input description"
              value={field.description ?? ""}
              onChange={(description) => update({ ...field, description })}
            />
            <Choice
              label="Input type"
              value={field.type}
              values={valueTypes}
              onChange={(type) => {
                const base = {
                  name: field.name,
                  description: field.description,
                  required: field.required,
                };
                if (type === "number") update({ ...base, type });
                else if (type === "boolean") update({ ...base, type });
                else if (type === "string[]") update({ ...base, type });
                else update({ ...base, type: "string" });
              }}
            />
            <Choice
              label="Required"
              value={String(field.required ?? false)}
              values={["true", "false"]}
              onChange={(next) => update({ ...field, required: next === "true" })}
            />
            <Choice
              label="Has default"
              value={String(field.default !== undefined)}
              values={["true", "false"]}
              onChange={(next) => {
                const { default: _default, ...rest } = field;
                onChange(
                  fields.map((entry, i) =>
                    i === index
                      ? next === "true"
                        ? inputWithDefault(rest, emptyValue(field.type))
                        : rest
                      : entry,
                  ),
                );
              }}
            />
            {field.default !== undefined && (
              <ValueField
                label="Default value"
                value={field.default}
                onChange={(value) => update(inputWithDefault(field, value))}
              />
            )}
            <Button
              variant="ghost"
              size="xs"
              onClick={() => onChange(fields.filter((_, i) => i !== index))}
            >
              Remove input
            </Button>
          </div>
        );
      })}
      <Button
        variant="outline"
        size="xs"
        onClick={() => onChange([...fields, { name: "input", type: "string" }])}
      >
        Add flow input
      </Button>
    </fieldset>
  );
}
function inputWithDefault(field: FlowInput, value: FlowValue): FlowInput {
  const base = { name: field.name, description: field.description, required: field.required };
  if (field.type === "number")
    return { ...base, type: field.type, default: typeof value === "number" ? value : 0 };
  if (field.type === "boolean")
    return { ...base, type: field.type, default: typeof value === "boolean" ? value : false };
  if (field.type === "string[]")
    return { ...base, type: field.type, default: Array.isArray(value) ? value : [] };
  return { ...base, type: "string", default: typeof value === "string" ? value : "" };
}

export function ModelFields({
  value,
  onChange,
}: {
  value: FlowModel | undefined;
  onChange: (model: FlowModel | undefined) => void;
}) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend>Model</legend>
      <Choice
        label="Model override"
        value={value ? "override" : "inherit"}
        values={["inherit", "override"]}
        onChange={(next) =>
          onChange(next === "inherit" ? undefined : { providerInstanceId: "", model: "" })
        }
      />
      {value && (
        <>
          <TextField
            label="Provider instance"
            value={value.providerInstanceId}
            onChange={(providerInstanceId) => onChange({ ...value, providerInstanceId })}
          />
          <TextField
            label="Model"
            value={value.model}
            onChange={(model) => onChange({ ...value, model })}
          />
          {Object.entries(value.options ?? {}).map(([key, option]) => (
            <div key={key} className="flex flex-col gap-1">
              <TextField
                label="Option name"
                value={key}
                onChange={(name) => {
                  const options = { ...value.options };
                  delete options[key];
                  options[name] = option;
                  onChange({ ...value, options });
                }}
              />
              <TextField
                label={`Option ${key}`}
                value={String(option)}
                onChange={(next) =>
                  onChange({
                    ...value,
                    options: {
                      ...value.options,
                      [key]: typeof option === "boolean" ? next === "true" : next,
                    },
                  })
                }
              />
              <Choice
                label="Option type"
                value={typeof option}
                values={["string", "boolean"]}
                onChange={(type) =>
                  onChange({
                    ...value,
                    options: { ...value.options, [key]: type === "boolean" ? false : "" },
                  })
                }
              />
              <Button
                size="xs"
                variant="ghost"
                onClick={() => {
                  const options = { ...value.options };
                  delete options[key];
                  onChange({ ...value, options });
                }}
              >
                Remove option
              </Button>
            </div>
          ))}
          <Button
            size="xs"
            variant="outline"
            onClick={() => onChange({ ...value, options: { ...value.options, option: "" } })}
          >
            Add model option
          </Button>
        </>
      )}
    </fieldset>
  );
}

export function AgentModes({
  value,
  onChange,
}: {
  value: {
    runtimeMode?: "full-access" | "approval-required" | "auto-accept-edits" | "auto" | undefined;
    interactionMode?: "default" | "plan" | undefined;
  };
  onChange: (value: {
    runtimeMode?: RuntimeMode | undefined;
    interactionMode?: ProviderInteractionMode | undefined;
  }) => void;
}) {
  return (
    <>
      <Choice
        label="Runtime mode"
        value={value.runtimeMode ?? "inherit"}
        values={["inherit", "approval-required", "auto-accept-edits", "auto", "full-access"]}
        onChange={(mode) =>
          onChange({
            ...value,
            runtimeMode:
              mode === "full-access" ||
              mode === "approval-required" ||
              mode === "auto" ||
              mode === "auto-accept-edits"
                ? mode
                : undefined,
          })
        }
      />
      <Choice
        label="Interaction mode"
        value={value.interactionMode ?? "inherit"}
        values={["inherit", "default", "plan"]}
        onChange={(mode) =>
          onChange({
            ...value,
            interactionMode: mode === "default" || mode === "plan" ? mode : undefined,
          })
        }
      />
    </>
  );
}

export function StepForm({
  step,
  onChange,
}: {
  step: FlowStep;
  onChange: (step: FlowStep) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <TextField label="Step id" value={step.id} onChange={(id) => onChange({ ...step, id })} />
      {step.kind === "agent" && (
        <>
          <TextField
            label="Prompt"
            multiline
            value={step.prompt}
            onChange={(prompt) => onChange({ ...step, prompt })}
          />
          <ModelFields value={step.model} onChange={(model) => onChange({ ...step, model })} />
          <AgentModes value={step} onChange={(modes) => onChange({ ...step, ...modes })} />
          <Choice
            label="Thread"
            value={typeof step.thread === "object" ? "sameAs" : (step.thread ?? "new")}
            values={["new", "continue", "sameAs"]}
            onChange={(thread) =>
              onChange({
                ...step,
                thread:
                  thread === "sameAs" ? { sameAs: "" } : thread === "continue" ? "continue" : "new",
              })
            }
          />
          {typeof step.thread === "object" && (
            <TextField
              label="Same as step"
              value={step.thread.sameAs}
              onChange={(sameAs) => onChange({ ...step, thread: { sameAs } })}
            />
          )}
          <OutputFieldsForm
            fields={step.outputs ?? []}
            onChange={(outputs) => onChange({ ...step, outputs })}
          />
        </>
      )}
      {step.kind === "command" && (
        <>
          <TextField
            label="Command"
            multiline
            value={step.command}
            onChange={(command) => onChange({ ...step, command })}
          />
          <TextField
            label="Working directory"
            value={step.cwd ?? ""}
            onChange={(cwd) => onChange({ ...step, cwd: cwd || undefined })}
          />
          <NumberField
            label="Timeout (ms)"
            value={step.timeoutMs ?? 600000}
            onChange={(timeoutMs) => onChange({ ...step, timeoutMs })}
          />
        </>
      )}
      {step.kind === "approval" && (
        <TextField
          label="Approval prompt"
          multiline
          value={step.prompt}
          onChange={(prompt) => onChange({ ...step, prompt })}
        />
      )}
      {step.kind === "loop" && (
        <>
          <NumberField
            label="Maximum iterations"
            value={step.maxIterations}
            onChange={(maxIterations) => onChange({ ...step, maxIterations })}
          />
          <ConditionForm value={step.until} onChange={(until) => onChange({ ...step, until })} />
        </>
      )}
      {step.kind === "map" && (
        <>
          <TextField
            label="Over reference"
            value={step.over}
            onChange={(over) => onChange({ ...step, over })}
          />
          <NumberField
            label="Concurrency"
            value={step.concurrency ?? 1}
            onChange={(concurrency) => onChange({ ...step, concurrency })}
          />
          <NumberField
            label="Maximum items"
            value={step.maxItems ?? 50}
            onChange={(maxItems) => onChange({ ...step, maxItems })}
          />
          <Choice
            label="On item failure"
            value={step.onItemFailure ?? "fail"}
            values={["fail", "continue"]}
            onChange={(next) =>
              onChange({ ...step, onItemFailure: next === "continue" ? "continue" : "fail" })
            }
          />
        </>
      )}
    </div>
  );
}
