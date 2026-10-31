import { X } from "lucide-react";
import { Checkbox } from "../ui/checkbox";
import { Collapsible, CollapsibleTrigger, CollapsiblePanel } from "../ui/collapsible";
/* oxlint-disable react/no-array-index-key -- Form slots are controlled values; their editable names and condition shapes cannot serve as keys. */
import { createContext, useContext, useState, type ReactNode } from "react";
import type {
  FlowCondition,
  FlowInput,
  FlowModel,
  FlowOutputField,
  FlowStep,
  FlowValue,
  ProviderInteractionMode,
} from "@t3tools/contracts";
import { FlowModelContext, FlowModelPicker } from "./FlowModelPicker";
import { RuntimeMode } from "@t3tools/contracts";
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

const FieldErrors = createContext<ReadonlyArray<{ path: string; message: string }>>([]);
const fieldPaths: Record<string, string> = {
  "Step id": "id",
  Prompt: "prompt",
  "Approval prompt": "prompt",
  Command: "command",
  "Working directory": "cwd",
  Timeout: "timeoutMs",
  "Maximum iterations": "maxIterations",
  "Iterate over": "over",
  Concurrency: "concurrency",
  "Maximum items": "maxItems",
  "Share thread with": "thread.sameAs",
  Reference: "ref",
};
function Field({
  label,
  children,
  hint,
  error,
}: {
  label: string;
  children: ReactNode;
  hint?: string | undefined;
  error?: string | null;
}) {
  const errors = useContext(FieldErrors).filter(
    (error) => fieldPaths[label] && error.path.endsWith(`.${fieldPaths[label]}`),
  );
  return (
    <div className="flex min-w-0 flex-col gap-1 text-xs">
      <div className="flex items-center justify-between gap-2 text-muted-foreground">
        <span>{label}</span>
        {hint && <span className="text-2xs">{hint}</span>}
      </div>
      {children}
      {error && (
        <span role="alert" className="text-destructive">
          {error}
        </span>
      )}
      {errors.map((error) => (
        <span role="alert" key={`${error.path}:${error.message}`} className="text-destructive">
          {error.message}
        </span>
      ))}
    </div>
  );
}

const optionLabels: Record<string, string> = {
  inherit: "Inherit flow default",
  override: "Override model",
  "full-access": "Full access",
  "approval-required": "Approval required",
  "auto-accept-edits": "Auto-accept edits",
  auto: "Auto",
  default: "Default",
  plan: "Plan",
  new: "New thread",
  continue: "Continue previous step's thread",
  sameAs: "Same thread as step…",
  eq: "equals",
  neq: "does not equal",
  lt: "less than",
  lte: "at most",
  gt: "greater than",
  gte: "at least",
  contains: "contains",
  isEmpty: "is empty",
  string: "Text",
  number: "Number",
  boolean: "Yes/No",
  "string[]": "List of text",
  enum: "Choice",
  true: "Yes",
  false: "No",
  worktree: "Fresh worktree per run",
  root: "Project folder",
  fail: "Stop on failure",
  all: "All conditions",
  any: "Any condition",
  not: "Not",
  comparison: "Comparison",
  success: "Success",
  failure: "Failure",
  always: "Always",
  conditional: "Only when…",
};
export function FlowSection({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 border-t border-border/60 pt-3">
      <h4 className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
        {children}
      </h4>
      {action}
    </div>
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
  labels?: Readonly<Record<string, ReactNode>>;
  onChange: (value: string) => void;
}) {
  if (values.length === 2 && values.includes("true") && values.includes("false"))
    return (
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <Checkbox
          checked={value === "true"}
          onCheckedChange={(checked) => onChange(String(checked === true))}
        />
        {label}
      </label>
    );
  return (
    <Field label={label}>
      <Select
        value={value}
        onValueChange={(value) => {
          if (value !== null) onChange(value);
        }}
      >
        <SelectTrigger size="xs" aria-label={label}>
          <SelectValue>{labels?.[value] ?? optionLabels[value] ?? value}</SelectValue>
        </SelectTrigger>
        <SelectPopup>
          <SelectGroup>
            {[...new Set(values)].map((item) => (
              <SelectItem key={item} value={item}>
                {labels?.[item] ?? optionLabels[item] ?? item}
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
  hint,
  mono = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  multiline?: boolean;
  hint?: string | undefined;
  mono?: boolean;
}) {
  return (
    <Field label={label} hint={hint}>
      {multiline ? (
        <Textarea
          size="sm"
          aria-label={label}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <Input
          size="compact"
          font={mono ? "mono" : "default"}
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
  const wrap = (kind: "all" | "any" | "not") =>
    onChange(
      kind === "all"
        ? { all: [value, emptyCondition] }
        : kind === "any"
          ? { any: [value, emptyCondition] }
          : { not: value },
    );
  const comparison = "ref" in value;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {"not" in value ? (
        <>
          <div className="flex items-center gap-2 text-2xs text-muted-foreground">
            Not{" "}
            <Button size="xs" variant="ghost" onClick={() => onChange(value.not)}>
              Remove not
            </Button>
          </div>
          <div className="border-l border-border/60 pl-2">
            <ConditionForm value={value.not} onChange={(not) => onChange({ not })} />
          </div>
        </>
      ) : !comparison ? (
        <>
          <span className="text-2xs font-medium text-muted-foreground">
            {"all" in value ? "All conditions" : "Any condition"}
          </span>
          {("all" in value ? value.all : value.any).map((condition, index, conditions) => (
            <div key={index} className="border-l border-border/60 pl-2">
              <ConditionForm
                value={condition}
                onChange={(next) => {
                  const children = conditions.map((child, i) => (i === index ? next : child));
                  onChange("all" in value ? { all: children } : { any: children });
                }}
              />
              <Button
                size="xs"
                variant="ghost-destructive"
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
            variant="ghost"
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
          <div className="grid grid-cols-[minmax(0,1fr)_100px_minmax(0,1fr)] items-end gap-2">
            <TextField
              label="Reference"
              mono
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
              <ValueField
                label="Value"
                value={value.value}
                onChange={(next) => onChange({ ...value, value: next })}
              />
            )}
          </div>
          {"value" in value && (
            <Collapsible>
              <CollapsibleTrigger render={<Button size="xs" variant="ghost" />}>
                Value type
              </CollapsibleTrigger>
              <CollapsiblePanel>
                <Choice
                  label="Value type"
                  value={valueType(value.value)}
                  values={valueTypes}
                  onChange={(type) => onChange({ ...value, value: emptyValue(type) })}
                />
              </CollapsiblePanel>
            </Collapsible>
          )}
        </>
      )}
      <div className="flex gap-1">
        <Button size="xs" variant="ghost" onClick={() => wrap("all")}>
          + and
        </Button>
        <Button size="xs" variant="ghost" onClick={() => wrap("any")}>
          + or
        </Button>
        <Button size="xs" variant="ghost" onClick={() => wrap("not")}>
          Not
        </Button>
      </div>
    </div>
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
      <FlowSection
        action={
          <Button
            variant="ghost"
            size="xs"
            onClick={() => onChange([...fields, { name: "result", type: "string" }])}
          >
            + Field
          </Button>
        }
      >
        Output fields
      </FlowSection>
      {fields.map((field, index) => {
        const update = (next: FlowOutputField) =>
          onChange(fields.map((entry, i) => (i === index ? next : entry)));
        return (
          <div key={index} className="grid grid-cols-[minmax(0,1fr)_100px_24px] items-end gap-2">
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
            <Button
              variant="ghost-destructive"
              size="icon-xs"
              aria-label="Remove output"
              onClick={() => onChange(fields.filter((_, i) => i !== index))}
            >
              <X />
            </Button>
            {field.type === "enum" && (
              <div className="col-span-full">
                <TextField
                  label="Enum values (one per line)"
                  multiline
                  value={field.values.join("\n")}
                  onChange={(next) => update({ ...field, values: next.split("\n") })}
                />
              </div>
            )}
          </div>
        );
      })}
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
      <FlowSection
        action={
          <Button
            variant="ghost"
            size="xs"
            onClick={() => onChange([...fields, { name: "input", type: "string" }])}
          >
            + Input
          </Button>
        }
      >
        Inputs
      </FlowSection>
      {fields.map((field, index) => {
        const update = (next: FlowInput) =>
          onChange(fields.map((entry, i) => (i === index ? next : entry)));
        return (
          <div
            key={index}
            className="grid grid-cols-[minmax(0,1fr)_90px_auto_24px] items-end gap-2"
          >
            <TextField
              label="Input name"
              value={field.name}
              onChange={(name) => update({ ...field, name })}
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
            <Button
              variant="ghost-destructive"
              size="icon-xs"
              aria-label="Remove input"
              onClick={() => onChange(fields.filter((_, i) => i !== index))}
            >
              <X />
            </Button>
            <Collapsible className="col-span-full">
              <CollapsibleTrigger render={<Button size="xs" variant="ghost" />}>
                Description and defaults
              </CollapsibleTrigger>
              <CollapsiblePanel>
                <div className="flex flex-col gap-2 py-2">
                  <TextField
                    label="Input description"
                    value={field.description ?? ""}
                    onChange={(description) => update({ ...field, description })}
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
                </div>
              </CollapsiblePanel>
            </Collapsible>
          </div>
        );
      })}
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
  const context = useContext(FlowModelContext);
  return (
    <fieldset className="flex flex-col gap-2">
      <FlowSection>Agent defaults</FlowSection>
      <Choice
        label="Override model"
        value={String(!!value)}
        values={["true", "false"]}
        onChange={(next) =>
          onChange(next === "false" ? undefined : { providerInstanceId: "", model: "" })
        }
      />
      {value && (
        <>
          <FlowModelPicker value={value} onChange={onChange} />
          {!context && <p>Choose a connected environment to select a model.</p>}
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
        values={["inherit", ...RuntimeMode.literals]}
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
  onRename,
  errors = [],
}: {
  onRename: (id: string) => void;
  errors?: ReadonlyArray<{ path: string; message: string }>;
  step: FlowStep;
  onChange: (step: FlowStep) => void;
}) {
  const [id, setId] = useState(step.id);
  const [idError, setIdError] = useState<string | null>(null);
  const commitId = () => {
    try {
      onRename(id);
      setIdError(null);
    } catch (error) {
      setIdError(error instanceof Error ? error.message : String(error));
    }
  };
  return (
    <FieldErrors value={errors}>
      <div className="flex flex-col gap-3">
        <Field label="Step id" error={idError}>
          <Input
            size="compact"
            aria-label="Step id"
            value={id}
            onChange={(event) => setId(event.target.value)}
            onBlur={commitId}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commitId();
              }
            }}
          />
        </Field>
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
                    thread === "sameAs"
                      ? { sameAs: "" }
                      : thread === "continue"
                        ? "continue"
                        : "new",
                })
              }
            />
            {typeof step.thread === "object" && (
              <TextField
                label="Share thread with"
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
            <p className="text-xs text-muted-foreground">
              Command lines are literal. Put flow references in environment values and read them
              from the shell.
            </p>
            {Object.entries(step.env ?? {}).map(([name, value], index) => (
              <div
                key={index}
                className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_24px] items-end gap-2"
              >
                <TextField
                  label="Environment variable"
                  mono
                  value={name}
                  onChange={(next) => {
                    if (next !== name && Object.hasOwn(step.env ?? {}, next)) return;
                    onChange({
                      ...step,
                      env: Object.fromEntries(
                        Object.entries(step.env ?? {}).map(([key, entry]) => [
                          key === name ? next : key,
                          entry,
                        ]),
                      ),
                    });
                  }}
                />
                <TextField
                  label={`Environment value ${name}`}
                  value={value}
                  onChange={(next) => onChange({ ...step, env: { ...step.env, [name]: next } })}
                />
                <Button
                  size="icon-xs"
                  variant="ghost-destructive"
                  aria-label="Remove environment variable"
                  onClick={() => {
                    const env = { ...step.env };
                    delete env[name];
                    onChange({ ...step, env });
                  }}
                >
                  <X />
                </Button>
              </div>
            ))}
            <Button
              size="xs"
              variant="outline"
              onClick={() => {
                let name = "VALUE";
                for (let i = 2; Object.hasOwn(step.env ?? {}, name); i++) name = `VALUE_${i}`;
                onChange({ ...step, env: { ...step.env, [name]: "" } });
              }}
            >
              Add environment variable
            </Button>
            <TextField
              label="Working directory"
              value={step.cwd ?? ""}
              onChange={(cwd) => onChange({ ...step, cwd: cwd || undefined })}
            />
            <TextField
              label="Timeout"
              hint="ms · default 10 min"
              value={step.timeoutMs === undefined ? "" : String(step.timeoutMs)}
              onChange={(value) =>
                onChange({ ...step, timeoutMs: value === "" ? undefined : Number(value) })
              }
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
              label="Iterate over"
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
              labels={{ fail: "Stop the flow", continue: "Continue other items" }}
              value={step.onItemFailure ?? "fail"}
              values={["fail", "continue"]}
              onChange={(next) =>
                onChange({ ...step, onItemFailure: next === "continue" ? "continue" : "fail" })
              }
            />
          </>
        )}
      </div>
    </FieldErrors>
  );
}
