# Desktop Taskbar Icon Configuration

T3 Code configures the Windows taskbar icon through both packaged build assets and runtime Electron identity.

## Packaged Executable Icon

Windows icon source assets are declared in:

- `scripts/lib/brand-assets.ts`

Current Windows icon sources:

- Production: `assets/prod/t3-black-windows.ico`
- Nightly: `assets/nightly/blueprint-windows.ico`
- Development: `assets/dev/blueprint-windows.ico`

During desktop artifact builds, `scripts/build-desktop-artifact.ts` copies the selected `.ico` file into the staged Electron resources directory as:

```text
icon.ico
```

Electron Builder then embeds that icon into the Windows executable with:

```ts
win: {
  icon: "icon.ico",
  signAndEditExecutable: true,
}
```

`signAndEditExecutable: true` matters because resource editing applies the icon and product metadata to the packaged executable.

## Windows Taskbar Identity

Windows taskbar grouping is controlled by the app user model ID.

The ID is resolved in:

- `apps/desktop/src/app/DesktopEnvironment.ts`

Default values:

```ts
appUserModelId: isDevelopment ? "com.t3tools.t3code.dev" : "com.t3tools.t3code";
```

The ID is applied at runtime in:

- `apps/desktop/src/app/DesktopAppIdentity.ts`

```ts
electronApp.setAppUserModelId(environment.appUserModelId);
```

## BrowserWindow Icon

The runtime window icon is resolved in:

- `apps/desktop/src/window/DesktopWindow.ts`

On Windows, the window options use the resolved `.ico` resource:

```ts
const ext = platform === "win32" ? "ico" : "png";
```

This affects the running window icon, while pinned taskbar behavior usually depends on the executable or shortcut icon plus the Windows app user model ID.
