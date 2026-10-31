import { describe, expect, it } from "vite-plus/test";
import { validateFlowDefinition } from "./flow.ts";

const agent = <T extends object>(id: string, extra?: T) => ({
  id,
  kind: "agent",
  prompt: "Work",
  ...extra,
});
const command = { id: "test", kind: "command", command: "echo ok" };
const review = agent("review", {
  outputs: [
    { name: "verdict", type: "enum", values: ["approve", "revise"] },
    { name: "issues", type: "string[]" },
  ],
});
const loop = {
  id: "loop",
  kind: "loop",
  maxIterations: 3,
  steps: [review],
  edges: [],
  until: { ref: "steps.review.output.verdict", op: "eq", value: "approve" },
};
const map = {
  id: "map",
  kind: "map",
  over: "inputs.files",
  steps: [agent("edit", { prompt: "{{item}} {{index}}" })],
  edges: [],
};
const flow = (extra = {}) => ({
  version: 1,
  title: "Flow",
  steps: [agent("start")],
  edges: [],
  ...extra,
});
const cases = [
  { name: "minimal", value: flow(), path: undefined },
  { name: "unknown version", value: flow({ version: 2 }), path: "$.version" },
  { name: "unknown property", value: flow({ typo: true }), path: "$.typo" },
  {
    name: "duplicate steps across levels",
    value: flow({ steps: [review, loop] }),
    path: "$.steps[1].steps[0].id",
  },
  {
    name: "cycle",
    value: flow({
      steps: [agent("a"), agent("b")],
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "a" },
      ],
    }),
    path: "$.steps[0].id",
  },
  {
    name: "endpoint outside level",
    value: flow({ steps: [loop], edges: [{ from: "review", to: "loop" }] }),
    path: "$.edges[0].from",
  },
  {
    name: "missing destination",
    value: flow({ edges: [{ from: "start", to: "missing" }] }),
    path: "$.edges[0].to",
  },
  {
    name: "earlier field",
    value: flow({
      steps: [command, agent("fix", { prompt: "{{steps.test.output.text}}" })],
      edges: [{ from: "test", to: "fix" }],
    }),
    path: undefined,
  },
  {
    name: "parallel field",
    value: flow({ steps: [command, agent("fix", { prompt: "{{steps.test.output.text}}" })] }),
    path: "$.steps[1].prompt",
  },
  {
    name: "self reference",
    value: flow({ steps: [agent("start", { prompt: "{{steps.start.output.text}}" })] }),
    path: "$.steps[0].prompt",
  },
  {
    name: "bad syntax",
    value: flow({ steps: [agent("start", { prompt: "{{inputs.x + 1}}" })] }),
    path: "$.steps[0].prompt",
  },
  {
    name: "unclosed template",
    value: flow({ steps: [agent("start", { prompt: "{{inputs.x" })] }),
    path: "$.steps[0].prompt",
  },
  {
    name: "missing input",
    value: flow({ steps: [agent("start", { prompt: "{{inputs.x}}" })] }),
    path: "$.steps[0].prompt",
  },
  {
    name: "input",
    value: flow({
      inputs: [{ name: "x", type: "number", default: 2 }],
      steps: [agent("start", { prompt: "{{inputs.x}}" })],
    }),
    path: undefined,
  },
  {
    name: "wrong default",
    value: flow({ inputs: [{ name: "x", type: "number", default: "2" }] }),
    path: "$.inputs[0].default",
  },
  {
    name: "duplicate input",
    value: flow({
      inputs: [
        { name: "x", type: "number" },
        { name: "x", type: "string" },
      ],
    }),
    path: "$.inputs[1].name",
  },
  { name: "loop until", value: flow({ steps: [loop] }), path: undefined },
  {
    name: "loop bound",
    value: flow({ steps: [{ ...loop, maxIterations: 51 }] }),
    path: "$.steps[0].maxIterations",
  },
  {
    name: "inner cycle",
    value: flow({ steps: [{ ...loop, edges: [{ from: "review", to: "review" }] }] }),
    path: "$.steps[0].steps[0].id",
  },
  {
    name: "unknown until field",
    value: flow({
      steps: [{ ...loop, until: { ref: "steps.review.output.missing", op: "isEmpty" } }],
    }),
    path: "$.steps[0].until.ref",
  },
  {
    name: "previous output",
    value: flow({
      steps: [
        {
          ...loop,
          steps: [
            agent("review", {
              prompt: "{{iteration}} {{steps.review.previous.output.text}}",
              thread: "continue",
              outputs: [{ name: "verdict", type: "enum", values: ["approve", "revise"] }],
            }),
          ],
        },
      ],
    }),
    path: undefined,
  },
  {
    name: "previous outside loop",
    value: flow({ steps: [agent("start", { prompt: "{{steps.start.previous.output.text}}" })] }),
    path: "$.steps[0].prompt",
  },
  {
    name: "continue outside loop",
    value: flow({ steps: [agent("start", { thread: "continue" })] }),
    path: "$.steps[0].thread",
  },
  {
    name: "sameAs earlier agent",
    value: flow({
      steps: [agent("start"), agent("fix", { thread: { sameAs: "start" } })],
      edges: [{ from: "start", to: "fix" }],
    }),
    path: undefined,
  },
  {
    name: "sameAs command",
    value: flow({
      steps: [command, agent("fix", { thread: { sameAs: "test" } })],
      edges: [{ from: "test", to: "fix" }],
    }),
    path: "$.steps[1].thread.sameAs",
  },
  {
    name: "sameAs parallel",
    value: flow({ steps: [agent("start"), agent("fix", { thread: { sameAs: "start" } })] }),
    path: "$.steps[1].thread.sameAs",
  },
  {
    name: "map input",
    value: flow({ inputs: [{ name: "files", type: "string[]" }], steps: [map] }),
    path: undefined,
  },
  {
    name: "map scalar",
    value: flow({ inputs: [{ name: "files", type: "string" }], steps: [map] }),
    path: "$.steps[0].over",
  },
  {
    name: "map command lines",
    value: flow({
      steps: [command, { ...map, over: "steps.test.output.lines" }],
      edges: [{ from: "test", to: "map" }],
    }),
    path: undefined,
  },
  {
    name: "map concurrency",
    value: flow({ steps: [{ ...map, concurrency: 9 }] }),
    path: "$.steps[0].concurrency",
  },
  {
    name: "item outside map",
    value: flow({ steps: [agent("start", { prompt: "{{item}}" })] }),
    path: "$.steps[0].prompt",
  },
  {
    name: "iteration outside loop",
    value: flow({ steps: [agent("start", { prompt: "{{iteration}}" })] }),
    path: "$.steps[0].prompt",
  },
  {
    name: "nested scope",
    value: flow({
      inputs: [{ name: "files", type: "string[]" }],
      steps: [
        {
          ...loop,
          steps: [
            review,
            {
              ...map,
              steps: [
                agent("edit", { prompt: "{{iteration}} {{item}} {{steps.review.output.text}}" }),
              ],
            },
          ],
          edges: [{ from: "review", to: "map" }],
        },
      ],
    }),
    path: undefined,
  },
  {
    name: "loop output outside",
    value: flow({
      steps: [loop, agent("fix", { prompt: "{{steps.loop.output.review.verdict}}" })],
      edges: [{ from: "loop", to: "fix" }],
    }),
    path: undefined,
  },
  {
    name: "inner output escapes",
    value: flow({
      steps: [loop, agent("fix", { prompt: "{{steps.review.output.verdict}}" })],
      edges: [{ from: "loop", to: "fix" }],
    }),
    path: "$.steps[1].prompt",
  },
  {
    name: "edge sees source",
    value: flow({
      steps: [command, agent("fix")],
      edges: [
        {
          from: "test",
          to: "fix",
          when: { not: { any: [{ ref: "steps.test.output.exitCode", op: "eq", value: 0 }] } },
        },
      ],
    }),
    path: undefined,
  },
  {
    name: "edge cannot see destination",
    value: flow({
      steps: [command, agent("fix")],
      edges: [
        {
          from: "test",
          to: "fix",
          when: { all: [{ ref: "steps.fix.output.text", op: "isEmpty" }] },
        },
      ],
    }),
    path: "$.edges[0].when.all[0].ref",
  },
  {
    name: "failure edge",
    value: flow({
      steps: [command, agent("fix")],
      edges: [{ from: "test", to: "fix", on: "failure" }],
    }),
    path: undefined,
  },
  {
    name: "duplicate output",
    value: flow({
      steps: [
        agent("start", {
          outputs: [
            { name: "x", type: "string" },
            { name: "x", type: "number" },
          ],
        }),
      ],
    }),
    path: "$.steps[0].outputs[1].name",
  },
  {
    name: "reserved text",
    value: flow({ steps: [agent("start", { outputs: [{ name: "text", type: "string" }] })] }),
    path: "$.steps[0].outputs[0].name",
  },
  {
    name: "cwd traversal",
    value: flow({ steps: [{ ...command, cwd: "src/../../outside" }] }),
    path: "$.steps[0].cwd",
  },
  {
    name: "cwd Windows root",
    value: flow({ steps: [{ ...command, cwd: "C:\\temp" }] }),
    path: "$.steps[0].cwd",
  },
  {
    name: "cwd relative",
    value: flow({ steps: [{ ...command, cwd: "src/../test" }] }),
    path: undefined,
  },
  {
    name: "unknown provider",
    value: flow({ defaults: { model: { providerInstanceId: "missing", model: "test" } } }),
    path: "$.defaults.model.providerInstanceId",
  },
  {
    name: "step provider",
    value: flow({
      steps: [agent("start", { model: { providerInstanceId: "missing", model: "test" } })],
    }),
    path: "$.steps[0].model.providerInstanceId",
  },
  {
    name: "known provider",
    value: flow({
      defaults: {
        model: { providerInstanceId: "codex", model: "test", options: { reasoningEffort: "high" } },
      },
    }),
    path: undefined,
  },
  {
    name: "layout missing step",
    value: flow({ layout: { missing: { x: 0, y: 0 } } }),
    path: "$.layout.missing",
  },
];
describe("flow validation", () => {
  it.each(cases)("$name", ({ value, path }) => {
    const result = validateFlowDefinition(value, { knownProviderInstanceIds: new Set(["codex"]) });
    if (path === undefined) expect(result).toEqual({ valid: true, errors: [] });
    else {
      expect(result.valid).toBe(false);
      expect(result.errors.map((error) => error.path)).toContain(path);
    }
  });
});
