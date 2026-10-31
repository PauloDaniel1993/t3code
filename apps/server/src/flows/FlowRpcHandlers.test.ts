import { expect, it } from "@effect/vitest";
import {
  AuthFilesystemWriteScope,
  AuthOrchestrationOperateScope,
  FlowError,
  FlowId,
  FlowRpcs,
  FlowRunId,
  FlowStepRunId,
  ProjectId,
  RpcScopeAuthorization,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcTest from "effect/rpc/RpcTest";
import * as Authorization from "../auth/RpcAuthorization.ts";
import * as FlowService from "./FlowService.ts";
import { makeFlowRpcHandlers } from "./FlowRpcHandlers.ts";

it.effect.each([false, true])(
  "guards all flow mutations before invoking services (authorized: %s)",
  (authorized) =>
    Effect.gen(function* () {
      const group = RpcGroup.make(...FlowRpcs).middleware(RpcScopeAuthorization);
      let calls = 0;
      const handled = () =>
        Effect.sync(() => {
          calls++;
        }).pipe(Effect.andThen(Effect.fail(new FlowError({ message: "entered" }))));
      const service = Layer.mock(FlowService.FlowService)({
        save: handled,
        rename: handled,
        delete: handled,
        start: handled,
        stop: handled,
        resume: handled,
        retryStep: handled,
        answerApproval: handled,
      });
      const handlers = yield* makeFlowRpcHandlers.pipe(Effect.provide(service));
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayer(handlers),
            Authorization.layer(
              authorized ? [AuthFilesystemWriteScope, AuthOrchestrationOperateScope] : [],
            ),
          ),
        ),
      );
      const projectId = ProjectId.make("p");
      const flowId = FlowId.make("flow");
      const flowRunId = FlowRunId.make("run");
      const stepRunId = FlowStepRunId.make("step");
      const results = yield* Effect.all([
        client["flow.save"]({
          projectId,
          flowId,
          definition: { version: 1, title: "Flow", steps: [], edges: [] },
          baseRevision: null,
        }).pipe(Effect.flip),
        client["flow.rename"]({ projectId, flowId, newFlowId: FlowId.make("renamed") }).pipe(
          Effect.flip,
        ),
        client["flow.delete"]({ projectId, flowId }).pipe(Effect.flip),
        client["flow.start"]({ projectId, flowId, inputs: {} }).pipe(Effect.flip),
        client["flow.stop"]({ flowRunId }).pipe(Effect.flip),
        client["flow.resume"]({ flowRunId }).pipe(Effect.flip),
        client["flow.retryStep"]({ stepRunId }).pipe(Effect.flip),
        client["flow.answerApproval"]({ stepRunId, decision: "approve" }).pipe(Effect.flip),
      ]);
      expect(
        results.every(
          (error) => error._tag === (authorized ? "FlowError" : "EnvironmentAuthorizationError"),
        ),
      ).toBe(true);
      expect(calls).toBe(authorized ? 8 : 0);
    }).pipe(Effect.scoped),
);
