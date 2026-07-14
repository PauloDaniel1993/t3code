export const T3_MCP_USER_INPUT_TOOL_REFERENCE = "`t3-code` MCP `request_user_input`";

export const T3_MCP_USER_INPUT_NATIVE_DENIAL_MESSAGE =
  "The provider-native question tool is disabled in T3 Code because the `t3-code` MCP `request_user_input` tool is available. Call the `t3-code` MCP `request_user_input` tool instead; it supports 1 to 10 questions per call.";

export const T3_MCP_USER_INPUT_DEEPSEEK_UNSUPPORTED_MESSAGE =
  "DeepSeek is implemented in T3 Code as a local Chat Completions loop and does not support provider-side structured question tools or MCP tool calls. Use a tool-capable provider session with the `t3-code` MCP `request_user_input` tool for structured user-input questions.";

export const T3_MCP_USER_INPUT_TOOL_INSTRUCTIONS = `
When the \`t3-code\` MCP server exposes \`request_user_input\`, always use that product-native structured user-input tool for asking up to ten questions in one call.

Set \`multiSelect: true\` when a question allows the user to choose more than one option. Multi-select option replies are returned as arrays of selected labels; single-select and custom replies are returned as strings.

Do not call a provider-native or host-injected question tool while the T3 MCP user-input tool is available. Those tools are disabled in that state and will return an error directing you back to \`t3-code\` MCP \`request_user_input\`.
`.trim();
