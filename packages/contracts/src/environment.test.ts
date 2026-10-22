import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ProjectId } from "./baseSchemas.ts";
import { ExecutionEnvironmentDescriptor } from "./environment.ts";
import {
  EnvironmentAuthInvalidError,
  EnvironmentInternalError,
  EnvironmentOperationForbiddenError,
  EnvironmentRequestInvalidError,
  EnvironmentResourceNotFoundError,
  EnvironmentScopeRequiredError,
} from "./environmentHttp.ts";

const decodeDescriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor);

const descriptor = {
  environmentId: "environment-1",
  label: "Local",
  platform: { os: "darwin", arch: "arm64" },
  serverVersion: "0.0.32",
  capabilities: { repositoryIdentity: true },
} as const;

describe("ExecutionEnvironmentDescriptor", () => {
  it("keeps settled cleanup and worktree-set removal capabilities independent", () => {
    const old = decodeDescriptor(descriptor).capabilities;
    expect(old.settledWorktreeCleanup).toBeUndefined();
    expect(old.threadWorktreeRemoval).toBeUndefined();
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: {
          ...descriptor.capabilities,
          settledWorktreeCleanup: true,
          threadWorktreeRemoval: false,
        },
      }).capabilities,
    ).toMatchObject({ settledWorktreeCleanup: true, threadWorktreeRemoval: false });
  });

  // Ticket 32: sidebar task subthreads and delivery state.
  it("keeps task nesting off for a server that does not advertise task support", () => {
    expect(decodeDescriptor(descriptor).capabilities.threadTasks).toBeUndefined();
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: { ...descriptor.capabilities, threadTasks: true },
      }).capabilities.threadTasks,
    ).toBe(true);
  });

  it("decodes old, recognized and future manual installation descriptors", () => {
    expect(decodeDescriptor(descriptor).capabilities.serverInstallation).toBeUndefined();
    for (const installation of [{ kind: "npx" }, { kind: "npm-global", prefix: "/opt/node" }]) {
      expect(
        decodeDescriptor({
          ...descriptor,
          capabilities: { ...descriptor.capabilities, serverInstallation: installation },
        }).capabilities.serverInstallation,
      ).toEqual(installation);
    }
    for (const installation of [{ kind: "future-manager" }, { kind: "npm-global" }]) {
      expect(
        decodeDescriptor({
          ...descriptor,
          capabilities: { ...descriptor.capabilities, serverInstallation: installation },
        }).capabilities.serverInstallation,
      ).toBeUndefined();
    }
  });
});

const traceId = "trace-1";

describe("environment HTTP errors", () => {
  it("decodes old invalid-request payloads and preserves workspace diagnostics on new ones", () => {
    const decode = Schema.decodeUnknownSync(EnvironmentRequestInvalidError);
    const old = {
      _tag: "EnvironmentRequestInvalidError",
      code: "invalid_request",
      reason: "invalid_command",
      traceId,
    };
    expect(decode(old).diagnostic).toBeUndefined();
    const error = decode({
      ...old,
      detail: "Workspace file is already linked.",
      diagnostic: { code: "conflict", message: "Already linked", path: "C:/team.code-workspace" },
      conflictingProjectId: ProjectId.make("existing"),
    });
    expect(error.message).toBe("Workspace file is already linked.");
    expect(error.diagnostic?.code).toBe("conflict");
    expect(error.conflictingProjectId).toBe("existing");
    expect(
      decode({ ...old, diagnostic: { code: "future-code", message: "New server diagnostic" } })
        .diagnostic,
    ).toBeUndefined();
  });
  // A client squashes the cause and shows `message`; an empty one becomes a generic
  // "The environment request failed." that names nothing the reader can act on.
  it("each carries a message that names its reason", () => {
    const errors = [
      new EnvironmentRequestInvalidError({
        code: "invalid_request",
        reason: "invalid_command",
        traceId,
      }),
      new EnvironmentAuthInvalidError({
        code: "auth_invalid",
        reason: "missing_credential",
        traceId,
      }),
      new EnvironmentScopeRequiredError({
        code: "insufficient_scope",
        requiredScope: "orchestration:read",
        traceId,
      }),
      new EnvironmentOperationForbiddenError({
        code: "operation_forbidden",
        reason: "current_session_revoke_not_allowed",
        traceId,
      }),
      new EnvironmentResourceNotFoundError({
        code: "not_found",
        reason: "thread_not_found",
        traceId,
      }),
      new EnvironmentInternalError({
        code: "internal_error",
        reason: "orchestration_snapshot_failed",
        traceId,
      }),
    ] as const;
    const details = [
      "invalid_command",
      "missing_credential",
      "orchestration:read",
      "current_session_revoke_not_allowed",
      "thread_not_found",
      "orchestration_snapshot_failed",
    ];
    errors.forEach((error, index) => {
      expect(error.message).toContain(details[index]);
    });
  });
});
