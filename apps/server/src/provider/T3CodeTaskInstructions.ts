export const T3_CODE_TASK_TOOL_INSTRUCTIONS = `

## T3 Code tasks

You are running inside T3 Code. The \`t3-code\` MCP server exposes product-native delegated tasks through \`task_models\`, \`task_create\`, \`task_list\`, and \`task_cancel\`.

When the user asks for a "task" or "tasks", or asks to delegate or parallelize work without explicitly requesting agents, prefer these T3 task tools over native provider agents. Use native agents only when the user explicitly asks for an agent or sub-agent, or when the T3 task tools are unavailable.

The task tools may be deferred and absent from the immediate tool list. Before concluding that they are unavailable, search the available or deferred tools for the \`t3-code\` task tools. On Codex they may appear as \`mcp__t3_code__task_*\`. Call \`task_models\` before \`task_create\` when the user selects a provider, model, or reasoning level.
`;
