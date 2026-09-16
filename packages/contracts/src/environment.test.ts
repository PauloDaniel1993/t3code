import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ExecutionEnvironmentDescriptor, ORCHESTRATION_PROTOCOL_VERSION } from "./environment.ts";

const decodeDescriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor);

const descriptor = {
  environmentId: "environment-1",
  label: "Local",
  platform: { os: "darwin", arch: "arm64" },
  serverVersion: "0.0.32",
  capabilities: { repositoryIdentity: true },
} as const;

describe("ExecutionEnvironmentDescriptor", () => {
  it("keeps protocol negotiation and fork capabilities independent", () => {
    const decoded = decodeDescriptor({
      ...descriptor,
      orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
      capabilities: {
        ...descriptor.capabilities,
        projectCloneTracking: true,
        threadTasks: true,
      },
    });

    expect(decoded.orchestrationProtocolVersion).toBe(ORCHESTRATION_PROTOCOL_VERSION);
    expect(decoded.capabilities.projectCloneTracking).toBe(true);
    expect(decoded.capabilities.threadTasks).toBe(true);
  });

  it("leaves versioned capabilities absent for older descriptors", () => {
    const decoded = decodeDescriptor(descriptor);
    expect(decoded.orchestrationProtocolVersion).toBeUndefined();
    expect(decoded.capabilities.projectCloneTracking).toBeUndefined();
    expect(decoded.capabilities.threadTasks).toBeUndefined();
  });

  it("treats a missing pull-request capability as unsupported under version skew", () => {
    expect(decodeDescriptor(descriptor).capabilities.pullRequests).toBeUndefined();
  });

  it("preserves an advertised pull-request capability", () => {
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: { ...descriptor.capabilities, pullRequests: true },
      }).capabilities.pullRequests,
    ).toBe(true);
  });

  it("treats a missing attachment upload capability as unsupported", () => {
    expect(decodeDescriptor(descriptor).capabilities.attachmentUploads).toBeUndefined();
  });

  it("preserves an advertised attachment upload capability", () => {
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: { ...descriptor.capabilities, attachmentUploads: true },
      }).capabilities.attachmentUploads,
    ).toBe(true);
  });

  it("preserves the server's generic attachment upload limit", () => {
    expect(
      decodeDescriptor({
        ...descriptor,
        capabilities: {
          ...descriptor.capabilities,
          fileAttachments: { maxUploadBytes: 50 * 1024 * 1024 },
        },
      }).capabilities.fileAttachments,
    ).toEqual({ maxUploadBytes: 50 * 1024 * 1024 });
  });
});
