import { sha256 } from "@noble/hashes/sha2";
import * as SchemaParser from "effect/SchemaParser";
import * as SchemaIssue from "effect/SchemaIssue";
import * as Result from "effect/Result";
import {
  FlowDefinition,
  type FlowStep,
  type FlowEdge,
  type FlowInput,
  type FlowCondition,
  type FlowValue,
  type FlowOutputField,
  type FlowValidationError,
} from "@t3tools/contracts";

const FLOW_TEXT_MAX_BYTES = 16_000;
const FLOW_FIELD_MAX_BYTES = 4_096;
const FLOW_LIST_MAX_ITEMS = 200;
const FLOW_COMMAND_MAX_BYTES = 16_384;
export class FlowValueError extends Error {
  readonly path: string;
  constructor(path: string, message: string) {
    super(message);
    this.path = path;
    this.name = "FlowValueError";
  }
}
export type FlowReference =
  | { kind: "input"; name: string }
  | { kind: "step"; stepId: string; previous: boolean; fields: ReadonlyArray<string> }
  | { kind: "local"; name: "item" | "index" | "iteration" };
export function parseFlowReference(reference: string, path = "$"): FlowReference {
  if (reference === "item" || reference === "index" || reference === "iteration")
    return { kind: "local", name: reference };
  const input = /^inputs\.([a-zA-Z_][a-zA-Z0-9_-]*)$/.exec(reference);
  if (input) return { kind: "input", name: input[1]! };
  const step =
    /^steps\.([a-z0-9][a-z0-9-]{0,63})\.(previous\.)?output\.([a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*)$/.exec(
      reference,
    );
  if (step)
    return {
      kind: "step",
      stepId: step[1]!,
      previous: step[2] !== undefined,
      fields: step[3]!.split("."),
    };
  throw new FlowValueError(path, `Invalid flow reference: ${reference}`);
}
export interface FlowReferenceContext {
  readonly inputs?: Readonly<Record<string, FlowValue>>;
  readonly steps?: Readonly<
    Record<string, { readonly output?: unknown; readonly previous?: { readonly output?: unknown } }>
  >;
  readonly item?: string;
  readonly index?: number;
  readonly iteration?: number;
}
export function resolveFlowReference(
  reference: string,
  context: FlowReferenceContext,
  path = "$",
): unknown {
  const parsed = parseFlowReference(reference, path);
  let value: unknown;
  if (parsed.kind === "input")
    value =
      context.inputs && Object.hasOwn(context.inputs, parsed.name)
        ? context.inputs[parsed.name]
        : undefined;
  else if (parsed.kind === "local") value = context[parsed.name];
  else {
    const step =
      context.steps && Object.hasOwn(context.steps, parsed.stepId)
        ? context.steps[parsed.stepId]
        : undefined;
    value = parsed.previous ? step?.previous?.output : step?.output;
    for (const field of parsed.fields) {
      value =
        typeof value === "object" && value !== null && Object.hasOwn(value, field)
          ? Reflect.get(value, field)
          : undefined;
    }
  }
  return value;
}
export function resolveFlowMapItems(
  reference: string,
  context: FlowReferenceContext,
  maxItems = 50,
) {
  const value = resolveFlowReference(reference, context, "$.over");
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === "string"))
    throw new FlowValueError("$.over", "Map requires an available string[]");
  if (reference.endsWith(".lines")) {
    const parent = reference.slice(0, -"lines".length);
    if (resolveFlowReference(`${parent}kind`, context) === "command") {
      const count = resolveFlowReference(`${parent}lineCount`, context);
      if (typeof count === "number" && count > value.length)
        throw new FlowValueError("$.over", "Command lines were truncated");
    }
  }
  if (value.length > maxItems) throw new FlowValueError("$.over", "Map exceeds maxItems");
  return value;
}
function templateReferences(template: string, path: string) {
  template = template.replace(/\\\{\{(?:[^{}]*?\}\})?/g, "");
  const matches = [...template.matchAll(/\{\{\s*([^{}]*?)\s*\}\}/g)];
  const rest = template.replace(/\{\{\s*([^{}]*?)\s*\}\}/g, "");
  if (rest.includes("{{") || rest.includes("}}"))
    throw new FlowValueError(path, "Unclosed flow reference");
  return matches.map((match) => match[1]!.trim());
}
const encoder = new TextEncoder();
function truncateUtf8(text: string, bytes: number, tail = false) {
  const encoded = encoder.encode(text);
  if (encoded.length <= bytes) return text;
  if (tail) {
    let start = encoded.length - bytes;
    while (start < encoded.length && (encoded[start]! & 0xc0) === 0x80) start++;
    return new TextDecoder().decode(encoded.subarray(start));
  }
  let end = bytes;
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end--;
  return new TextDecoder().decode(encoded.subarray(0, end));
}
export function capFlowText(text: string, sourceThreadLabel: string) {
  if (encoder.encode(text).length <= FLOW_TEXT_MAX_BYTES) return text;
  const marker = `\n[Truncated; full output in ${truncateUtf8(sourceThreadLabel, 512)}]`;
  return truncateUtf8(text, FLOW_TEXT_MAX_BYTES - encoder.encode(marker).length) + marker;
}
function renderTemplate(
  template: string,
  context: FlowReferenceContext,
  sourceThreadLabel: (stepId: string) => string,
  path: string,
  environment: boolean,
) {
  return template.replace(
    /(\\\{\{)|\{\{\s*([^{}]*?)\s*\}\}/g,
    (_match, literal: string | undefined, raw: string | undefined) => {
      if (literal !== undefined) return "{{";
      try {
        const reference = raw!.trim();
        const parsed = parseFlowReference(reference, path);
        const value = resolveFlowReference(reference, context, path);
        if (Array.isArray(value) && value.every((item) => typeof item === "string"))
          return value.map((item) => (environment ? item : `- ${item}`)).join("\n");
        if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean")
          return "";
        return parsed.kind === "step" && parsed.fields.at(-1) === "text"
          ? capFlowText(String(value), sourceThreadLabel(parsed.fields.at(-2) ?? parsed.stepId))
          : String(value);
      } catch (error) {
        if (error instanceof FlowValueError) return "";
        throw error;
      }
    },
  );
}
export function renderFlowTemplate(
  template: string,
  context: FlowReferenceContext,
  sourceThreadLabel: (stepId: string) => string,
  path = "$",
) {
  return renderTemplate(template, context, sourceThreadLabel, path, false);
}
export function renderFlowCommandEnv(
  env: Readonly<Record<string, string>>,
  context: FlowReferenceContext,
  sourceThreadLabel: (stepId: string) => string,
) {
  return Object.fromEntries(
    Object.entries(env).map(([name, template]) => [
      name,
      renderTemplate(template, context, sourceThreadLabel, `$.env.${name}`, true),
    ]),
  );
}
export function evaluateFlowCondition(
  condition: FlowCondition,
  context: FlowReferenceContext,
  path = "$",
): boolean {
  if ("all" in condition)
    return condition.all.every((child, i) =>
      evaluateFlowCondition(child, context, `${path}.all[${i}]`),
    );
  if ("any" in condition)
    return condition.any.some((child, i) =>
      evaluateFlowCondition(child, context, `${path}.any[${i}]`),
    );
  if ("not" in condition) return !evaluateFlowCondition(condition.not, context, `${path}.not`);
  let actual: unknown;
  try {
    actual = resolveFlowReference(condition.ref, context, `${path}.ref`);
  } catch (error) {
    if (!(error instanceof FlowValueError)) throw error;
  }
  if (actual === undefined || actual === null) return condition.op === "isEmpty";
  const equal = (left: unknown, right: unknown): boolean =>
    Array.isArray(left) && Array.isArray(right)
      ? left.length === right.length && left.every((entry, i) => entry === right[i])
      : left === right;
  switch (condition.op) {
    case "eq":
      return equal(actual, condition.value);
    case "neq":
      return !equal(actual, condition.value);
    case "isEmpty":
      return actual === null || actual === "" || (Array.isArray(actual) && actual.length === 0);
    case "contains":
      return typeof actual === "string" && typeof condition.value === "string"
        ? actual.includes(condition.value)
        : Array.isArray(actual) && actual.includes(condition.value);
    case "lt":
      return (
        typeof actual === "number" &&
        typeof condition.value === "number" &&
        actual < condition.value
      );
    case "lte":
      return (
        typeof actual === "number" &&
        typeof condition.value === "number" &&
        actual <= condition.value
      );
    case "gt":
      return (
        typeof actual === "number" &&
        typeof condition.value === "number" &&
        actual > condition.value
      );
    case "gte":
      return (
        typeof actual === "number" &&
        typeof condition.value === "number" &&
        actual >= condition.value
      );
  }
}
type ReferenceType = {
  readonly type: FlowOutputField["type"] | "items";
  readonly values?: ReadonlyArray<string>;
};
function matchesType(field: ReferenceType, value: unknown): value is FlowValue {
  switch (field.type) {
    case "enum":
      return typeof value === "string" && (field.values?.includes(value) ?? false);
    case "string[]":
      return Array.isArray(value) && value.every((item) => typeof item === "string");
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "items":
      return false;
  }
}
export function resolveFlowInputs(
  inputs: ReadonlyArray<FlowInput>,
  values: Readonly<Record<string, unknown>>,
) {
  const output = new Map<string, FlowValue>();
  for (const name of Object.keys(values))
    if (!inputs.some((input) => input.name === name))
      throw new FlowValueError(`$.inputs.${name}`, "Unknown flow input");
  for (const input of inputs) {
    const value = Object.hasOwn(values, input.name) ? values[input.name] : undefined;
    const resolved = value === undefined ? input.default : value;
    if (resolved === undefined) {
      if (input.required)
        throw new FlowValueError(`$.inputs.${input.name}`, "Missing required flow input");
      continue;
    }
    if (!matchesType(input, resolved))
      throw new FlowValueError(`$.inputs.${input.name}`, `Expected ${input.type}`);
    output.set(input.name, resolved);
  }
  return Object.fromEntries(output);
}
export function coerceFlowInputs(
  inputs: ReadonlyArray<FlowInput>,
  values: Readonly<Record<string, string>>,
) {
  const output = new Map<string, unknown>(Object.entries(values));
  for (const input of inputs) {
    const raw = Object.hasOwn(values, input.name) ? values[input.name] : undefined;
    if (raw === undefined) continue;
    switch (input.type) {
      case "string":
        break;
      case "number":
        if (raw.trim() === "")
          throw new FlowValueError(`$.inputs.${input.name}`, "Expected a finite number");
        output.set(input.name, Number(raw));
        break;
      case "boolean":
        output.set(input.name, raw.trim() === "true" ? true : raw.trim() === "false" ? false : raw);
        break;
      case "string[]": {
        let parsed: unknown;
        if (raw.trim().startsWith("[") && raw.trim().endsWith("]")) {
          try {
            parsed = JSON.parse(raw);
          } catch {
            /* A line-list item can start with a bracket. */
          }
        }
        output.set(
          input.name,
          parsed ??
            raw
              .split(/\r?\n/)
              .map((item) => item.trim())
              .filter(Boolean),
        );
        break;
      }
    }
  }
  return resolveFlowInputs(inputs, Object.fromEntries(output));
}
export function validateFlowReport(fields: ReadonlyArray<FlowOutputField>, value: unknown) {
  const errors: FlowValidationError[] = [];
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return { valid: false, errors: [{ path: "$.fields", message: "Expected output fields" }] };
  for (const name of Object.keys(value))
    if (!fields.some((field) => field.name === name))
      errors.push({ path: `$.fields.${name}`, message: "Unknown output field" });
  for (const field of fields) {
    const actual: unknown = Object.hasOwn(value, field.name)
      ? Reflect.get(value, field.name)
      : undefined;
    const path = `$.fields.${field.name}`;
    const withinLimits = (item: unknown) =>
      typeof item !== "string" || encoder.encode(item).length <= FLOW_FIELD_MAX_BYTES;
    if (
      !matchesType(field, actual) ||
      !withinLimits(actual) ||
      (Array.isArray(actual) &&
        (actual.length > FLOW_LIST_MAX_ITEMS || !actual.every(withinLimits)))
    )
      errors.push({ path, message: `Expected ${field.type} within output limits` });
  }
  return { valid: errors.length === 0, errors };
}
export function capFlowCommandOutput(combined: string, stdout: string) {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
  return {
    lineCount: lines.length,
    text: truncateUtf8(combined, FLOW_COMMAND_MAX_BYTES, true),
    lines: lines
      .slice(0, FLOW_LIST_MAX_ITEMS)
      .map((line) => truncateUtf8(line, FLOW_FIELD_MAX_BYTES)),
  };
}

type Scope = {
  available: ReadonlyMap<string, FlowStep>;
  previous: ReadonlyMap<string, FlowStep>;
  inLoop: boolean;
  inMap: boolean;
  canContinue: boolean;
};
function outputType(step: FlowStep, fields: ReadonlyArray<string>): ReferenceType | undefined {
  const [name, ...rest] = fields;
  if (step.kind === "loop") {
    if (rest.length === 0 && name === "iterations") return { type: "number" };
    if (rest.length === 0 && name === "exitReason")
      return { type: "enum", values: ["condition", "maxIterations"] };
    const [id, ...innerFields] = rest;
    const inner = name === "steps" ? step.steps.find((child) => child.id === id) : undefined;
    return inner ? outputType(inner, innerFields) : undefined;
  }
  if (rest.length > 0) return undefined;
  if (step.kind === "agent")
    return name === "text"
      ? { type: "string" }
      : step.outputs?.find((field) => field.name === name);
  if (step.kind === "command") {
    if (name === "text") return { type: "string" };
    if (name === "lines") return { type: "string[]" };
    if (name === "exitCode" || name === "lineCount") return { type: "number" };
    if (name === "timedOut") return { type: "boolean" };
    return undefined;
  }
  if (step.kind === "approval") {
    if (name === "decision") return { type: "enum", values: ["approve", "reject"] };
    return name === "comment" ? { type: "string" } : undefined;
  }
  return name === "items" ? { type: "items" } : undefined;
}
const decodeDefinition = SchemaParser.decodeUnknownResult(FlowDefinition, {
  errors: "all",
  onExcessProperty: "error",
});
const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1();
export function validateFlowDefinition(
  value: unknown,
  options: { readonly knownProviderInstanceIds?: ReadonlySet<string> } = {},
) {
  const decoded = decodeDefinition(value);
  if (Result.isFailure(decoded)) {
    const errors = formatIssues(decoded.failure).issues.map((issue) => ({
      path:
        "$" +
        (issue.path ?? [])
          .map((part) =>
            typeof part === "number"
              ? `[${part}]`
              : `.${String(typeof part === "object" ? part.key : part)}`,
          )
          .join(""),
      message: issue.message,
    }));
    return { valid: false, errors };
  }
  const definition = decoded.success;
  const errors: FlowValidationError[] = [];
  const fail = (path: string, message: string) => errors.push({ path, message });
  const protect = (path: string, f: () => void) => {
    try {
      f();
    } catch (error) {
      if (error instanceof FlowValueError) fail(error.path, error.message);
      else throw error;
    }
  };
  const ids = new Map<string, FlowStep>();
  const collect = (steps: ReadonlyArray<FlowStep>, path: string) =>
    steps.forEach((step, i) => {
      const p = `${path}[${i}]`;
      if (ids.has(step.id)) fail(`${p}.id`, "Duplicate step id");
      ids.set(step.id, step);
      if (step.kind === "loop" || step.kind === "map") collect(step.steps, `${p}.steps`);
    });
  collect(definition.steps, "$.steps");
  const inputs = new Map((definition.inputs ?? []).map((input) => [input.name, input]));
  const seenInputs = new Set<string>();
  definition.inputs?.forEach((input, i) => {
    if (seenInputs.has(input.name)) fail(`$.inputs[${i}].name`, "Duplicate flow input");
    seenInputs.add(input.name);
  });
  const checkModel = (model: { providerInstanceId: string } | undefined, path: string) => {
    if (
      model &&
      options.knownProviderInstanceIds &&
      !options.knownProviderInstanceIds.has(model.providerInstanceId)
    )
      fail(`${path}.providerInstanceId`, "Unknown provider instance");
  };
  checkModel(definition.defaults?.model, "$.defaults.model");
  const checkRef = (reference: string, path: string, scope: Scope) => {
    const ref = parseFlowReference(reference, path);
    if (ref.kind === "input") {
      const input = inputs.get(ref.name);
      if (!input) throw new FlowValueError(path, "Unknown flow input");
      return input;
    }
    if (ref.kind === "local") {
      if (ref.name === "iteration" ? !scope.inLoop : !scope.inMap)
        throw new FlowValueError(path, `${ref.name} is outside its container`);
      return { type: ref.name === "item" ? "string" : "number" } as const;
    }
    const step = (ref.previous && scope.inLoop ? scope.previous : scope.available).get(ref.stepId);
    if (ref.previous && !scope.inLoop)
      throw new FlowValueError(path, "Previous output requires a loop");
    if (!step) throw new FlowValueError(path, "Referenced step cannot have run earlier");
    const type = outputType(step, ref.fields);
    if (!type) throw new FlowValueError(path, "Unknown step output field");
    return type;
  };
  const checkCondition = (condition: FlowCondition, path: string, scope: Scope): void => {
    if ("all" in condition)
      condition.all.forEach((child, i) => checkCondition(child, `${path}.all[${i}]`, scope));
    else if ("any" in condition)
      condition.any.forEach((child, i) => checkCondition(child, `${path}.any[${i}]`, scope));
    else if ("not" in condition) checkCondition(condition.not, `${path}.not`, scope);
    else
      protect(`${path}.ref`, () => {
        const field = checkRef(condition.ref, `${path}.ref`, scope);
        if (condition.op === "isEmpty") return;
        const valid =
          condition.op === "contains"
            ? (field.type === "string" || field.type === "string[]") &&
              typeof condition.value === "string"
            : condition.op === "eq" || condition.op === "neq"
              ? matchesType(field, condition.value)
              : field.type === "number" &&
                typeof condition.value === "number" &&
                Number.isFinite(condition.value);
        if (!valid) fail(`${path}.value`, `Invalid ${condition.op} operand for ${field.type}`);
      });
  };
  const locations = new Map<
    string,
    {
      path: string;
      lineage: ReadonlyArray<string>;
      ancestors: ReadonlySet<string>;
      parallelMaps: ReadonlyArray<string>;
    }
  >();
  const checkLevel = (
    steps: ReadonlyArray<FlowStep>,
    edges: ReadonlyArray<FlowEdge>,
    path: string,
    outer: Scope,
    lineage: ReadonlyArray<string> = [],
    parallelMaps: ReadonlyArray<string> = [],
  ): void => {
    const local = new Map(steps.map((step) => [step.id, step]));
    edges.forEach((edge, i) => {
      if (!local.has(edge.from))
        fail(`${path}.edges[${i}].from`, "Unknown edge endpoint at this level");
      if (!local.has(edge.to))
        fail(`${path}.edges[${i}].to`, "Unknown edge endpoint at this level");
    });
    const ancestors = (id: string, seen = new Set<string>()): Set<string> => {
      for (const edge of edges)
        if (edge.to === id && local.has(edge.from) && !seen.has(edge.from)) {
          seen.add(edge.from);
          ancestors(edge.from, seen);
        }
      return seen;
    };
    const scopeFor = (id: string): Scope => ({
      ...outer,
      available: new Map([
        ...outer.available,
        ...[...ancestors(id)]
          .filter((ancestor) => ancestor !== id)
          .flatMap((ancestor) => {
            const step = local.get(ancestor);
            return step ? [[ancestor, step] as const] : [];
          }),
      ]),
    });
    steps.forEach((step, i) => {
      const p = `${path}.steps[${i}]`;
      const scope = scopeFor(step.id);
      locations.set(step.id, {
        path: p,
        lineage: [...lineage, step.id],
        ancestors: ancestors(step.id),
        parallelMaps,
      });
      if (ancestors(step.id).has(step.id)) fail(`${p}.id`, "Cycle at this graph level");
      if (step.kind === "agent") {
        checkModel(step.model, `${p}.model`);
        if (step.thread === "continue" && !scope.canContinue)
          fail(`${p}.thread`, "Continue requires a loop");
        if (typeof step.thread === "object") {
          const target = scope.available.get(step.thread.sameAs);
          if (target?.kind !== "agent")
            fail(`${p}.thread.sameAs`, "Expected an earlier agent step");
        }
        const fields = new Set<string>();
        step.outputs?.forEach((field, j) => {
          if (field.name === "text" || field.name === "kind" || fields.has(field.name))
            fail(`${p}.outputs[${j}].name`, "Duplicate or reserved output field");
          fields.add(field.name);
        });
      }
      if (step.kind === "agent" || step.kind === "approval" || step.kind === "command") {
        if (step.kind === "command" && step.command.includes("{{"))
          fail(`${p}.command`, "Command must be a literal shell line; use env for references");
        const templates =
          step.kind === "command"
            ? Object.entries(step.env ?? {}).map(([name, value]) => [`env.${name}`, value] as const)
            : [["prompt", step.prompt] as const];
        for (const [key, template] of templates)
          protect(`${p}.${key}`, () => {
            for (const ref of templateReferences(template, `${p}.${key}`))
              checkRef(ref, `${p}.${key}`, scope);
          });
        if (step.kind === "command" && step.cwd !== undefined) {
          const parts = step.cwd.replaceAll("\\", "/").split("/");
          let depth = 0;
          if (
            /^(?:[a-z]:|\/|\\)/i.test(step.cwd) ||
            parts.some((part) => {
              if (part === "..") return --depth < 0;
              if (part !== "." && part !== "") depth++;
              return false;
            })
          )
            fail(`${p}.cwd`, "Command cwd must stay inside the workspace");
        }
      } else {
        if (step.kind === "map")
          protect(`${p}.over`, () => {
            if (checkRef(step.over, `${p}.over`, scope).type !== "string[]")
              throw new FlowValueError(`${p}.over`, "Map requires a string[] reference");
          });
        const previous = new Map<string, FlowStep>();
        const addPrevious = (children: ReadonlyArray<FlowStep>) =>
          children.forEach((child) => {
            previous.set(child.id, child);
          });
        if (step.kind === "loop") addPrevious(step.steps);
        const inner = {
          ...scope,
          previous,
          inLoop: scope.inLoop || step.kind === "loop",
          inMap: scope.inMap || step.kind === "map",
          canContinue: step.kind === "loop",
        };
        checkLevel(
          step.steps,
          step.edges,
          p,
          inner,
          [...lineage, step.id],
          step.kind === "map" && (step.concurrency ?? 1) > 1
            ? [...parallelMaps, step.id]
            : parallelMaps,
        );
        if (step.kind === "loop")
          checkCondition(step.until, `${p}.until`, {
            ...inner,
            available: new Map([
              ...scope.available,
              ...step.steps.map((child) => [child.id, child] as const),
            ]),
          });
      }
    });
    edges.forEach((edge, i) => {
      if (edge.when) {
        const scope = scopeFor(edge.from);
        const source = local.get(edge.from);
        checkCondition(edge.when, `${path}.edges[${i}].when`, {
          ...scope,
          available: new Map([
            ...scope.available,
            ...(source ? [[source.id, source] as const] : []),
          ]),
        });
      }
    });
  };
  checkLevel(definition.steps, definition.edges, "$", {
    available: new Map(),
    previous: new Map(),
    inLoop: false,
    inMap: false,
    canContinue: false,
  });
  const threadRoot = (id: string, seen = new Set<string>()): string => {
    const step = ids.get(id);
    if (seen.has(id) || step?.kind !== "agent" || typeof step.thread !== "object") return id;
    seen.add(id);
    return threadRoot(step.thread.sameAs, seen);
  };
  const agents = [...ids.values()].filter((step) => step.kind === "agent");
  agents.forEach((step, index) => {
    const location = locations.get(step.id)!;
    const root = threadRoot(step.id);
    const rootLocation = locations.get(root);
    if (rootLocation && location.parallelMaps.some((id) => !rootLocation.parallelMaps.includes(id)))
      fail(`${location.path}.thread`, "Concurrent map items cannot share an outer thread");
    for (const other of agents.slice(0, index)) {
      if (threadRoot(other.id) !== root) continue;
      const otherLocation = locations.get(other.id)!;
      const divergence = location.lineage.findIndex((id, i) => otherLocation.lineage[i] !== id);
      if (divergence < 0 || divergence >= otherLocation.lineage.length) continue;
      const left = location.lineage[divergence]!;
      const right = otherLocation.lineage[divergence]!;
      if (!locations.get(left)!.ancestors.has(right) && !locations.get(right)!.ancestors.has(left))
        fail(`${location.path}.thread`, "Concurrently runnable steps cannot share a thread");
    }
  });
  for (const id of Object.keys(definition.layout ?? {}))
    if (!ids.has(id)) fail(`$.layout.${id}`, "Unknown layout step");
  return { valid: errors.length === 0, errors };
}

function canonicalFlowValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalFlowValue);
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => [key, canonicalFlowValue(child)]),
    );
  return value;
}
export function serializeFlowDefinition(value: unknown) {
  return `${JSON.stringify(canonicalFlowValue(value), null, 2)}\n`;
}
export function flowDefinitionRevision(value: unknown) {
  return Array.from(sha256(new TextEncoder().encode(serializeFlowDefinition(value))), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
