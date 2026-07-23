## Why

T3 Code cannot currently use a user's Kimi Code membership as a coding-agent provider, even though the official Kimi Code CLI exposes subscription authentication and an ACP interface suitable for editor integrations. Adding a first-class Kimi driver lets users bring that subscription into the same provider, model-selection, and session experience as Codex, Claude, Cursor, Grok, and OpenCode without introducing separate pay-as-you-go API credentials.

## What Changes

- Add a built-in `kimi` provider driver backed by the locally installed Kimi Code CLI and `kimi acp`.
- Reuse the Kimi CLI's OAuth-managed Kimi Code membership credentials; T3 Code will not request, store, or expose the user's OAuth tokens.
- Detect CLI installation, version, and authentication readiness, with actionable install/login guidance when Kimi is unavailable.
- Support Kimi ACP sessions, streaming assistant and tool events, approvals and user input, interruption, native session resume, model/mode options, attachments supported by the negotiated ACP capabilities, and provider-backed text generation.
- Support Kimi subagent delegation inside an active ACP prompt, including parallel foreground subagents whose results are required for the current response, without pretending detached background work is supervised when upstream ACP does not publish its lifecycle.
- Add Kimi provider settings, web/mobile presentation metadata, iconography, model-picker/handoff availability, update metadata, and focused contract/server/client tests.
- Treat direct Moonshot/Kimi Platform API-key configuration as out of scope for this subscription provider.

## Capabilities

### New Capabilities

- `kimi-subscription-provider`: Defines Kimi Code CLI configuration, subscription authentication and readiness, ACP runtime behavior, session/model/tool support, text generation, maintenance, and provider UI behavior.

### Modified Capabilities

None.

## Impact

- Provider settings and exports in `packages/contracts`.
- Built-in driver registration, Kimi status probing, ACP adapter/runtime mapping, session resume, text generation, and provider maintenance in `apps/server`.
- Provider settings, model-picker metadata, icons, status presentation, and add-instance flows in `apps/web`, plus Kimi identity/model presentation in `apps/mobile`.
- Kimi Code CLI becomes an optional external runtime dependency for users who enable the provider; existing providers and persisted unknown-driver compatibility remain unchanged.
