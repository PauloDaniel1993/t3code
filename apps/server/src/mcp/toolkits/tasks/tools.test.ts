import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import { Tool } from "effect/unstable/ai";

import { NESTED_TASK_MESSAGE } from "./handlers.ts";
import { TasksToolkit } from "./tools.ts";

const schemaHasDescription = (schema: unknown): boolean => {
  if (!schema || typeof schema !== "object") return false;
  const record = schema as Record<string, unknown>;
  if (typeof record.description === "string" && record.description.length > 0) return true;
  return [record.anyOf, record.oneOf, record.allOf]
    .filter(Array.isArray)
    .some((members) => members.some(schemaHasDescription));
};

const jsonSchemaOf = (tool: (typeof TasksToolkit.tools)[keyof typeof TasksToolkit.tools]) =>
  Tool.getJsonSchema(tool) as {
    readonly type?: unknown;
    readonly properties?: Readonly<Record<string, unknown>>;
    readonly required?: ReadonlyArray<string>;
    readonly anyOf?: unknown;
    readonly oneOf?: unknown;
  };

it("exports provider-compatible object schemas with described parameters", () => {
  for (const tool of Object.values(TasksToolkit.tools)) {
    const schema = jsonSchemaOf(tool);
    expect(
      tool.description?.length ?? 0,
      `${tool.name} should have a useful description`,
    ).toBeGreaterThan(40);
    expect(schema.type, `${tool.name} must export a top-level object schema`).toBe("object");
    expect(schema.anyOf, `${tool.name} must not export a root anyOf`).toBeUndefined();
    expect(schema.oneOf, `${tool.name} must not export a root oneOf`).toBeUndefined();
    for (const [field, fieldSchema] of Object.entries(schema.properties ?? {})) {
      expect(
        schemaHasDescription(fieldSchema),
        `${tool.name}.${field} should explain what data the agent must pass`,
      ).toBe(true);
    }
  }
});

it("never lets a caller name the owning thread", () => {
  // The parent is taken from the invocation scope. If any tool accepted a
  // parent thread id, an agent could create or cancel tasks on a thread it is
  // not running in.
  for (const tool of Object.values(TasksToolkit.tools)) {
    const properties = Object.keys(jsonSchemaOf(tool).properties ?? {});
    expect(properties, `${tool.name} must not accept a parent thread`).not.toContain(
      "parentThreadId",
    );
  }
});

it("requires the brief that makes a task self-contained", () => {
  const create = jsonSchemaOf(TasksToolkit.tools.task_create);
  expect(create.required).toEqual(expect.arrayContaining(["title", "prompt", "context"]));
  // messageIds is only meaningful for one context choice, so it stays optional
  // and the handler rejects an empty list rather than the schema.
  expect(create.required).not.toContain("messageIds");
  expect(Object.keys(create.properties ?? {})).toEqual(
    expect.arrayContaining(["title", "prompt", "context", "messageIds", "model", "reasoning"]),
  );
});

it("lets the reasoning level be set without also naming a model", () => {
  // Reasoning is its own top-level argument, not a field of `model`, so
  // "run this task harder on the model I am already using" is one argument.
  const create = jsonSchemaOf(TasksToolkit.tools.task_create);
  expect(create.required).not.toContain("reasoning");
  expect(create.required).not.toContain("model");
  const reasoning = create.properties?.reasoning;
  expect(schemaHasDescription(reasoning)).toBe(true);
  // The levels are per-model and come from the live provider snapshot, so the
  // published schema must stay an open string rather than a stale enum.
  expect((reasoning as { readonly enum?: unknown }).enum).toBeUndefined();
});

it("takes a task thread id to cancel and an optional status filter to list", () => {
  expect(jsonSchemaOf(TasksToolkit.tools.task_cancel).required).toEqual(["threadId"]);
  const list = jsonSchemaOf(TasksToolkit.tools.task_list);
  expect(Object.keys(list.properties ?? {})).toEqual(["status"]);
  expect(list.required ?? []).toEqual([]);
});

it("publishes the model catalog an agent has to read before naming a model", () => {
  // instanceId slugs, model slugs and reasoning levels are all per-machine and
  // per-model. Without a way to look them up, an agent can only guess at
  // `model` and `reasoning`, and every guess costs a rejected call.
  const models = jsonSchemaOf(TasksToolkit.tools.task_models);
  expect(Object.keys(models.properties ?? {})).toEqual(["instanceId"]);
  expect(models.required ?? []).toEqual([]);
  expect(TasksToolkit.tools.task_models.description).toContain("reasoning levels");
});

it("tells a task what to do instead of creating a task of its own", () => {
  // Nesting is refused by the domain rule; what the agent needs from the tool
  // surface is the move that is still open to it, in both the description it
  // reads up front and the error it gets if it tries anyway.
  const create = TasksToolkit.tools.task_create.description ?? "";
  expect(create).toContain("A task cannot create tasks");
  expect(create.toLowerCase()).toContain("self-contained prompt");
  expect(NESTED_TASK_MESSAGE).toContain("Ask the thread that owns you");
  for (const part of ["title", "prompt", "context", "reasoning"]) {
    expect(NESTED_TASK_MESSAGE.toLowerCase()).toContain(part);
  }
});

it("annotates the write and destructive tools honestly", () => {
  // Same read path McpHttpServer uses to publish the MCP behaviour hints.
  const annotations = (tool: (typeof TasksToolkit.tools)[keyof typeof TasksToolkit.tools]) => ({
    readonly: Context.get(tool.annotations, Tool.Readonly),
    destructive: Context.get(tool.annotations, Tool.Destructive),
    idempotent: Context.get(tool.annotations, Tool.Idempotent),
  });
  // Creating a task starts a provider session: not readonly, and running it
  // twice makes two tasks.
  expect(annotations(TasksToolkit.tools.task_create)).toMatchObject({
    readonly: false,
    idempotent: false,
  });
  expect(annotations(TasksToolkit.tools.task_list)).toMatchObject({
    readonly: true,
    destructive: false,
  });
  expect(annotations(TasksToolkit.tools.task_models)).toMatchObject({
    readonly: true,
    destructive: false,
    idempotent: true,
  });
  // Cancelling interrupts real work, but cancelling twice changes nothing.
  expect(annotations(TasksToolkit.tools.task_cancel)).toMatchObject({
    destructive: true,
    idempotent: true,
  });
});
