import { MAX_USER_INPUT_QUESTIONS } from "@t3tools/shared/userInput";
import * as Schema from "effect/Schema";
import { Tool } from "effect/unstable/ai";
import { expect, it } from "vite-plus/test";

import { RequestUserInputResult, RequestUserInputTool } from "./tools.ts";

const decodeRequestUserInputResult = Schema.decodeUnknownSync(RequestUserInputResult);

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

const schemaDescription = (schema: unknown): string => {
  if (!schema || typeof schema !== "object") return "";
  const record = schema as Record<string, unknown>;
  const nested = ["allOf", "anyOf", "oneOf"].flatMap((key) =>
    Array.isArray(record[key]) ? record[key] : [],
  );
  return [
    typeof record.description === "string" ? record.description : "",
    ...nested.map(schemaDescription),
  ].join(" ");
};

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
          readonly properties?: Readonly<
            Record<
              string,
              {
                readonly description?: unknown;
                readonly allOf?: ReadonlyArray<{ readonly description?: unknown }>;
              }
            >
          >;
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
  expect(schema.properties?.questions?.items?.properties?.multiSelect).toBeDefined();
  expect(schemaDescription(schema.properties?.questions?.items?.properties?.multiSelect)).toContain(
    "returned as a string array",
  );
  expect(RequestUserInputTool.description).toContain("Set multiSelect to true");
  expect(RequestUserInputTool.description).toContain("returned as a string array");
});

it("accepts string and multi-select array replies in the MCP result", () => {
  expect(
    decodeRequestUserInputResult({
      answers: {
        scope: "Server",
        areas: ["Server", "Web"],
      },
    }),
  ).toEqual({
    answers: {
      scope: "Server",
      areas: ["Server", "Web"],
    },
  });
});

it("rejects invalid or empty multi-select arrays in the MCP result", () => {
  expect(() => decodeRequestUserInputResult({ answers: { areas: [] } })).toThrow();
  expect(() =>
    decodeRequestUserInputResult({ answers: { areas: { selected: ["Server"] } } }),
  ).toThrow();
});
