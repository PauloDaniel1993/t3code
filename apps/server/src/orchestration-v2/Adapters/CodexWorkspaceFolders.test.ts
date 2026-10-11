import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CodexSettings,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
  type ModelSelection,
} from "@t3tools/contracts";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexReplay from "effect-codex-app-server/replay";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { buildWorkspaceFolderInventory } from "../../provider/WorkspaceFolderInventory.ts";
import { ProviderAdapterV2RuntimePolicy } from "../ProviderAdapter.ts";
import * as IdAllocator from "../IdAllocator.ts";
import { decideProviderSessionTransition } from "../ProviderSessionTransitionPolicy.ts";
import { buildCodexTurnStartParams, makeCodexAdapterV2 } from "./CodexAdapterV2.ts";
import { makeReplayServerConfig } from "./CodexAdapterV2.testkit.ts";

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-6.1-sol",
} satisfies ModelSelection;
const settings = Schema.decodeSync(CodexSettings)({});

const policy = ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "auto-accept-edits",
  interactionMode: "default",
  cwd: "/workspace/primary",
  additionalDirectories: ["/workspace/second", "/workspace/third"],
});

const build = (runtimePolicy: ProviderAdapterV2RuntimePolicy, hasT3Mcp = false) =>
  buildCodexTurnStartParams({
    nativeThreadId: "native-workspace-folders",
    codexInput: [{ type: "text", text: "work in the workspace" }],
    runtimePolicy,
    modelSelection,
    hasT3Mcp,
  });

describe("Codex workspace folders", () => {
  it.effect("records the session scope so a model change reuses it and reopening clears it", () =>
    Effect.gen(function* () {
      const adapter = makeCodexAdapterV2({
        instanceId: modelSelection.instanceId,
        settings,
        environment: {},
        fileSystem: yield* FileSystem.FileSystem,
        idAllocator: yield* IdAllocator.IdAllocatorV2,
        serverConfig: yield* makeReplayServerConfig("workspace-folder-scope"),
        clientFactory: {
          open: () =>
            Layer.build(
              CodexReplay.layerReplay({
                provider: "codex",
                protocol: "codex.app-server",
                version: "0.161.0",
                scenario: "workspace-folder-scope",
                entries: [],
              }),
            ).pipe(
              Effect.flatMap((context) =>
                Effect.service(CodexClient.CodexAppServerClient).pipe(Effect.provide(context)),
              ),
              Effect.orDie,
            ),
        },
      });
      const open = (runtimePolicy: ProviderAdapterV2RuntimePolicy, suffix: string) =>
        adapter.openSession({
          threadId: ThreadId.make("thread:workspace-folder-scope"),
          providerSessionId: ProviderSessionId.make(
            `provider-session:workspace-folder-scope:${suffix}`,
          ),
          modelSelection,
          runtimePolicy,
        });
      const runtime = yield* open(policy, "initial");
      const session = runtime.providerSession;
      const current = {
        driver: session.driver,
        continuationIdentity: { driverKind: session.driver, continuationKey: "codex:scope-test" },
        modelSelection,
        runtimeMode: policy.runtimeMode,
        interactionMode: policy.interactionMode,
        workspace: session.cwd,
        additionalDirectories: session.additionalDirectories ?? [],
        capabilities: session.capabilities,
      };
      assert.deepEqual(
        decideProviderSessionTransition({
          current,
          target: {
            ...current,
            additionalDirectories: policy.additionalDirectories,
            modelSelection: { ...modelSelection, model: "another-model" },
            available: true,
          },
          selectionTransition: { type: "apply_on_next_turn" },
        }),
        { type: "switch_model_in_session" },
      );
      const cleared = yield* open({ ...policy, additionalDirectories: [] }, "cleared");
      assert.deepEqual(cleared.providerSession.additionalDirectories, []);
    }).pipe(Effect.provide(Layer.merge(NodeServices.layer, IdAllocator.layer))),
  );

  it.effect("grants ordered extra roots in both workspace-write modes", () =>
    Effect.gen(function* () {
      for (const runtimeMode of ["auto-accept-edits", "auto"] as const) {
        const params = yield* build({ ...policy, runtimeMode });
        assert.deepEqual(params.sandboxPolicy, {
          type: "workspaceWrite",
          writableRoots: policy.additionalDirectories,
        });
        assert.equal(params.cwd, policy.cwd);
        assert.equal(params.approvalPolicy, "on-request");
      }
    }),
  );

  it.effect("merges explicit roots without changing sandbox restrictions or mutating inputs", () =>
    Effect.gen(function* () {
      const sandboxPolicy = {
        type: "workspaceWrite",
        writableRoots: ["/attachments", "/workspace/second"],
        networkAccess: false,
        excludeSlashTmp: true,
        excludeTmpdirEnvVar: true,
      } as const;
      const params = yield* build({ ...policy, sandboxPolicy });
      assert.deepEqual(params.sandboxPolicy, {
        ...sandboxPolicy,
        writableRoots: ["/attachments", "/workspace/second", "/workspace/third"],
      });
      assert.deepEqual(sandboxPolicy.writableRoots, ["/attachments", "/workspace/second"]);
    }),
  );

  it.effect("replaces the scope and clears roots and inventory for a one-folder turn", () =>
    Effect.gen(function* () {
      const initial = yield* build(policy);
      const changed = yield* build({ ...policy, additionalDirectories: ["/worktrees/second"] });
      const cleared = yield* build({ ...policy, additionalDirectories: [] });
      assert.deepEqual(initial.sandboxPolicy, {
        type: "workspaceWrite",
        writableRoots: policy.additionalDirectories,
      });
      assert.deepEqual(changed.sandboxPolicy, {
        type: "workspaceWrite",
        writableRoots: ["/worktrees/second"],
      });
      assert.deepEqual(cleared.sandboxPolicy, { type: "workspaceWrite", writableRoots: [] });
      assert.isUndefined(cleared.additionalContext);
    }),
  );

  it.effect("keeps read-only, external and full-access policies unchanged", () =>
    Effect.gen(function* () {
      const approvalRequired = yield* build({ ...policy, runtimeMode: "approval-required" });
      assert.deepEqual(approvalRequired.sandboxPolicy, { type: "readOnly" });
      assert.equal(approvalRequired.approvalPolicy, "untrusted");
      for (const sandboxPolicy of [
        { type: "readOnly", networkAccess: false },
        { type: "externalSandbox", networkAccess: "restricted" },
        { type: "dangerFullAccess" },
        null,
      ] as const) {
        const params = yield* build({ ...policy, sandboxPolicy });
        assert.deepEqual(params.sandboxPolicy, sandboxPolicy);
      }
    }),
  );

  it.effect("does not expand write access in plan mode", () =>
    Effect.gen(function* () {
      const params = yield* build({ ...policy, interactionMode: "plan" });
      assert.deepEqual(params.sandboxPolicy, { type: "workspaceWrite" });
      assert.equal(params.collaborationMode?.mode, "plan");
      const sandboxPolicy = { type: "workspaceWrite", writableRoots: ["/attachments"] } as const;
      const explicit = yield* build({ ...policy, interactionMode: "plan", sandboxPolicy });
      assert.deepEqual(explicit.sandboxPolicy, sandboxPolicy);
    }),
  );

  it.effect("delivers the escaped inventory with and without T3 MCP", () =>
    Effect.gen(function* () {
      const scope = {
        ...policy,
        cwd: "C:\\work tree\\primary",
        additionalDirectories: ['D:\\folder\\<other> "quoted"'],
      };
      for (const hasT3Mcp of [false, true]) {
        const params = yield* build(scope, hasT3Mcp);
        assert.deepEqual(params.additionalContext?.workspace_folders, {
          kind: "application",
          value: buildWorkspaceFolderInventory(scope),
        });
        assert.equal(params.additionalContext?.t3_code_orchestration !== undefined, hasT3Mcp);
      }
      const plain = yield* build({ ...policy, additionalDirectories: [] }, true);
      assert.notProperty(plain.additionalContext, "workspace_folders");
      assert.isDefined(plain.additionalContext?.t3_code_orchestration);
    }),
  );
});
