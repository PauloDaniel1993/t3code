## Why

Appearance themes in v1 adjust app chrome, typography, density, and code font sizing, but code syntax colors still use the existing renderer defaults. Users who need higher contrast or a preferred editor-like palette need a dedicated syntax theme choice without making the core Appearance editor responsible for every syntax token.

## What Changes

- Add a syntax theme picker to Appearance settings.
- Store the selected syntax theme in client-local appearance settings or a closely scoped client setting.
- Apply the selected syntax theme to chat code blocks, file previews, and diff renderers where supported.
- Keep `Default` aligned with the current T3 Code syntax rendering.
- Include accessible high-contrast syntax theme options.

## Impact

- Affected areas:
  - `packages/contracts/src/settings.ts`
  - `apps/web/src/appearance`
  - chat markdown code block rendering
  - diff rendering
  - file/code preview rendering
- Required verification:
  - focused syntax theme application tests
  - visual verification of chat code, diffs, and previews in light/dark modes
  - `vp check`
  - `vp run typecheck`
