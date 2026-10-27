// @effect-diagnostics nodeBuiltinImport:off globalConsole:off -- Installed before the SDK loads, outside an Effect runtime. stderr must match Node's default unhandled-rejection print.
import * as NodeModule from "node:module";

// Cursor can leave its shell-spawn rejection unobserved; isolate that failure
// without changing other unhandled rejections or patching child_process.spawn.
const CURSOR_SHELL_SPAWN_MARKERS = [
  "dump_zsh_state",
  "dump_bash_state",
  "__CURSOR_SANDBOX_ENV_RESTORE",
] as const;

export function isCursorShellSpawnFailure(reason: unknown): boolean {
  if (typeof reason !== "object" || reason === null) {
    return false;
  }
  const syscall = Reflect.get(reason, "syscall");
  const code = Reflect.get(reason, "code");
  const spawnargs = Reflect.get(reason, "spawnargs");
  if (typeof syscall !== "string" || !syscall.startsWith("spawn") || typeof code !== "string") {
    return false;
  }
  if (!Array.isArray(spawnargs)) {
    return false;
  }
  return spawnargs.some(
    (arg) =>
      typeof arg === "string" && CURSOR_SHELL_SPAWN_MARKERS.some((marker) => arg.includes(marker)),
  );
}

let cursorShellSpawnGuardInstalled = false;

function installCursorShellSpawnGuard(): void {
  if (cursorShellSpawnGuardInstalled) {
    return;
  }
  cursorShellSpawnGuardInstalled = true;

  process.on("unhandledRejection", (reason) => {
    if (isCursorShellSpawnFailure(reason)) {
      console.error("Cursor shell spawn failed. The server will keep running.", reason);
      return;
    }
    // Another handler registered besides this one owns the decision.
    if (process.listenerCount("unhandledRejection") > 1) {
      return;
    }
    console.error(reason);
    process.exit(1);
  });
}

// Arm before the SDK loads. Its shell tools spawn from this process.
installCursorShellSpawnGuard();

// Cursor's Webpack chunks and local helpers must stay beside the SDK entry.
// createRequire also loads that disk-backed package from a Node SEA executable.
const requireCursorSdk = NodeModule.createRequire(import.meta.url);
export const {
  Agent,
  AuthenticationError,
  ConfigurationError,
  createAgentPlatform,
  Cursor,
  CursorSdkError,
  InMemoryCredentialStore,
  JsonlLocalAgentStore,
} = requireCursorSdk("@cursor/sdk") as typeof import("@cursor/sdk");
export const { SqliteLocalAgentStore } = requireCursorSdk(
  "@cursor/sdk/sqlite",
) as typeof import("@cursor/sdk/sqlite");
