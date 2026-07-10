import { MAX_USER_INPUT_QUESTIONS } from "@t3tools/shared/userInput";
import { Tool } from "effect/unstable/ai";
import { expect, it } from "vite-plus/test";

import { RequestUserInputTool } from "./tools.ts";

const schemaHas = (
  schema:
    | {
        readonly minItems?: unknown;
        readonly maxItems?: unknown;
        readonly allOf?: ReadonlyArray<Record<string, unknown>>;
      }
    | undefined,
  key: "minItems" | "maxItems",
  value: number,
): boolean =>
  schema?.[key] === value || schema?.allOf?.some((member) => member[key] === value) === true;

const schemaDescription = (
  schema:
    | {
        readonly description?: unknown;
        readonly allOf?: ReadonlyArray<{ readonly description?: unknown }>;
      }
    | undefined,
): string =>
  [
    typeof schema?.description === "string" ? schema.description : "",
    ...(schema?.allOf ?? []).map((member) =>
      typeof member.description === "string" ? member.description : "",
    ),
  ].join(" ");

it("exports a ten-question request_user_input MCP schema", () => {
  const schema = Tool.getJsonSchema(RequestUserInputTool) as {
    readonly type?: unknown;
    readonly properties?: {
      readonly questions?: {
        readonly type?: unknown;
        readonly minItems?: unknown;
        readonly maxItems?: unknown;
        readonly description?: unknown;
        readonly allOf?: ReadonlyArray<Record<string, unknown>>;
        readonly items?: {
          readonly type?: unknown;
          readonly properties?: Readonly<Record<string, unknown>>;
        };
      };
    };
  };

  expect(RequestUserInputTool.description).toContain(`up to ${MAX_USER_INPUT_QUESTIONS}`);
  expect(RequestUserInputTool.description).toContain("Required T3 Code tool");
  expect(RequestUserInputTool.description).toContain("Always use this when available");
  expect(RequestUserInputTool.description).toContain(
    "instead of provider-native or host-injected question tools",
  );
  expect(schema.type).toBe("object");
  expect(schema.properties?.questions?.type).toBe("array");
  expect(schemaHas(schema.properties?.questions, "minItems", 1)).toBe(true);
  expect(schemaHas(schema.properties?.questions, "maxItems", MAX_USER_INPUT_QUESTIONS)).toBe(true);
  expect(schemaDescription(schema.properties?.questions)).toContain(
    `One to ${MAX_USER_INPUT_QUESTIONS}`,
  );
  expect(schema.properties?.questions?.items?.type).toBe("object");
  expect(schema.properties?.questions?.items?.properties?.id).toBeDefined();
  expect(schema.properties?.questions?.items?.properties?.options).toBeDefined();
});
