export type ProviderIconKind =
  | "claude"
  | "kimi"
  | "grok"
  | "cursor"
  | "opencode"
  | "openai";

export function resolveProviderIconKind(provider: string | null | undefined): ProviderIconKind {
  if (provider === "claudeAgent") return "claude";
  if (provider === "kimi") return "kimi";
  if (provider === "grok") return "grok";
  if (provider === "cursor") return "cursor";
  if (provider === "opencode") return "opencode";
  return "openai";
}
