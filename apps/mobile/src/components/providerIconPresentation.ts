export type ProviderIconKind = "claude" | "kimi" | "openai";

export function resolveProviderIconKind(provider: string | null | undefined): ProviderIconKind {
  if (provider === "claudeAgent") return "claude";
  if (provider === "kimi") return "kimi";
  return "openai";
}
