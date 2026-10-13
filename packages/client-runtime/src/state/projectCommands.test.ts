import { describe, expect, it } from "@effect/vitest";
import {
  AuthFilesystemWriteScope,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type AuthSessionState,
  type ProjectListEntriesResult,
  type ScopedProjectRef,
  WS_METHODS,
} from "@t3tools/contracts";
import { vi } from "vite-plus/test";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Stream from "effect/Stream";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import { AVAILABLE_CONNECTION_STATE } from "../connection/model.ts";

import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import type { EnvironmentProject, EnvironmentThread } from "./models.ts";
import { createProjectEnvironmentAtoms } from "./projectCommands.ts";
import type { EnvironmentRpcInput } from "../rpc/client.ts";
import { v2Project, v2Projection } from "./orchestrationV2TestFixtures.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }),
}));
const sessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState>>(AsyncResult.initial()),
);
const PROJECT_ID = ProjectId.make("scratch");
const PROJECT = {
  id: PROJECT_ID,
  environmentId: ENVIRONMENT_ID,
  workspaceRoot: "/scratch",
} as EnvironmentProject;
const FILE_PROJECT_ID = v2Project.id;
const FILE_THREAD_ID = ThreadId.make("file-thread");
const OTHER_FILE_THREAD_ID = ThreadId.make("other-file-thread");
const FILE_FOLDERS = [
  { path: "/repo", name: "app", label: "app", checkoutRoot: "/repo", checkoutPrefix: "" },
  { path: "/api", name: "api", label: "api", checkoutRoot: "/api", checkoutPrefix: "" },
];
const FILE_PROJECT: EnvironmentProject = {
  ...v2Project,
  environmentId: ENVIRONMENT_ID,
  workspaceRoot: "/repo",
  folders: FILE_FOLDERS,
};
const fileThread = (id: ThreadId, name: string): EnvironmentThread => ({
  environmentId: ENVIRONMENT_ID,
  projection: {
    ...v2Projection,
    thread: {
      ...v2Projection.thread,
      id,
      worktreePath: "/sets/" + name + "/app",
      workspaceFolders: FILE_FOLDERS,
      worktrees: [
        { repositoryRoot: "/repo", path: "/sets/" + name + "/app", branch: "feature" },
        { repositoryRoot: "/api", path: "/sets/" + name + "/api", branch: "feature" },
      ],
    },
  },
});

const makeHarness = Effect.fn("TestProjectCommands.makeHarness")(function* (
  listing?: ProjectListEntriesResult,
) {
  const metadataRequests: string[][] = [];
  const file = { byteLength: 5 };
  const readResponse = { wait: Effect.void as Effect.Effect<void> };
  const entryResponse: ProjectListEntriesResult = listing ?? {
    entries: [{ path: "api/folder.ts", kind: "directory" }],
    truncated: false,
    folders: [
      { folderPath: "/repo", label: "app", status: "ok" },
      { folderPath: "/api", label: "api", status: "ok" },
    ],
  };
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: { environmentId: ENVIRONMENT_ID },
    session: yield* SubscriptionRef.make(
      Option.some({
        client: {
          [WS_METHODS.projectsEnsureScratch]: () => Effect.succeed({ projectId: PROJECT_ID }),
          [WS_METHODS.projectsSearchEntries]: () =>
            readResponse.wait.pipe(Effect.as(entryResponse)),
          [WS_METHODS.projectsListEntries]: () => readResponse.wait.pipe(Effect.as(entryResponse)),
          [WS_METHODS.projectsReadFile]: (
            input: EnvironmentRpcInput<typeof WS_METHODS.projectsReadFile>,
          ) =>
            Effect.gen(function* () {
              const byteLength = file.byteLength;
              yield* readResponse.wait;
              const relativePath = "scope" in input ? input.path.replace("/./", "/") : "foo";
              return { relativePath, byteLength, contents: "old", truncated: false };
            }),
          [WS_METHODS.projectsWriteFile]: (
            input: EnvironmentRpcInput<typeof WS_METHODS.projectsWriteFile>,
          ) =>
            Effect.sync(() => {
              file.byteLength = 10;
              return { relativePath: "scope" in input ? input.path.replace("/./", "/") : "foo" };
            }),
          [WS_METHODS.filesystemGetMetadata]: (input: { paths: string[] }) =>
            Effect.sync(() => {
              metadataRequests.push(input.paths);
              return {
                entries: input.paths.map(() => ({
                  kind: "file" as const,
                  byteLength: file.byteLength,
                })),
              };
            }),
        },
      } as unknown as RpcSession),
    ),
    state: yield* SubscriptionRef.make({
      ...AVAILABLE_CONNECTION_STATE,
      phase: "connected" as const,
    }),
  } as EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  const runtime = Atom.runtime(
    Layer.mergeAll(
      Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, {
        run: (_environmentId, effect) =>
          Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        followStream: (_environmentId, stream) =>
          Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      } as EnvironmentRegistry.EnvironmentRegistry["Service"]),
      Layer.succeed(
        Crypto.Crypto,
        Crypto.make({
          randomBytes: (size) => new Uint8Array(size),
          digest: (_algorithm, data) => Effect.succeed(data),
        }),
      ),
    ),
  );
  const storedProject = Atom.make<EnvironmentProject | null>(null);
  const fileProjectAtom = Atom.make<EnvironmentProject | null>(FILE_PROJECT);
  const fileThreadAtom = Atom.make<EnvironmentThread | null>(fileThread(FILE_THREAD_ID, "a"));
  const otherFileThreadAtom = Atom.make<EnvironmentThread | null>(
    fileThread(OTHER_FILE_THREAD_ID, "b"),
  );
  const commands = createProjectEnvironmentAtoms(runtime, {
    projectAtom: (ref: ScopedProjectRef) =>
      ref.environmentId === ENVIRONMENT_ID && ref.projectId === PROJECT_ID
        ? storedProject
        : ref.environmentId === ENVIRONMENT_ID && ref.projectId === FILE_PROJECT_ID
          ? fileProjectAtom
          : Atom.make(null),
    threadAtom: (ref) =>
      ref.environmentId !== ENVIRONMENT_ID
        ? Atom.make(null)
        : ref.threadId === FILE_THREAD_ID
          ? fileThreadAtom
          : ref.threadId === OTHER_FILE_THREAD_ID
            ? otherFileThreadAtom
            : Atom.make(null),
  });
  const registry = AtomRegistry.make();
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  registry.set(
    sessions(ENVIRONMENT_ID),
    AsyncResult.success({
      authenticated: true,
      auth: {
        policy: "remote-reachable" as const,
        bootstrapMethods: [],
        sessionMethods: [],
        sessionCookieName: "test",
      },
      scopes: [AuthFilesystemWriteScope],
      permissions: [AuthFilesystemWriteScope],
    }),
  );
  const openScratch = Effect.promise(() =>
    commands.openScratch.run(registry, { environmentId: ENVIRONMENT_ID, input: {} }),
  );
  return {
    registry,
    storedProject,
    openScratch,
    commands,
    metadataRequests,
    readResponse,
    file,
    fileProjectAtom,
    fileThreadAtom,
    entryResponse,
  };
});

describe("writeFile metadata", () => {
  it.effect("reuses a current file read without another metadata request", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* AtomRegistry.getResult(
        h.registry,
        h.commands.readFile({
          environmentId: ENVIRONMENT_ID,
          input: { cwd: "/repo", relativePath: "foo" },
        }),
        { suspendOnWaiting: true },
      );
      const metadata = h.commands.fileMetadata({
        environmentId: ENVIRONMENT_ID,
        input: { path: "/repo/foo" },
      });
      expect(
        yield* AtomRegistry.getResult(h.registry, metadata, { suspendOnWaiting: true }),
      ).toEqual({ kind: "file", byteLength: 5 });
      expect(h.metadataRequests).toHaveLength(0);
    }).pipe(Effect.scoped),
  );

  it.effect("does not restore old metadata from a read completed after a write", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const threadId = ThreadId.make("stale-read-thread");
      h.registry.mount(h.commands.fileMetadataThread({ environmentId: ENVIRONMENT_ID, threadId }));
      const metadata = h.commands.fileMetadata({
        environmentId: ENVIRONMENT_ID,
        input: { path: "/repo/foo", threadId },
      });
      h.registry.mount(metadata);
      const readMetadata = () =>
        AtomRegistry.getResult(h.registry, metadata, { suspendOnWaiting: true });
      yield* readMetadata();
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      h.readResponse.wait = Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
      );
      const fileRead = yield* AtomRegistry.getResult(
        h.registry,
        h.commands.readFile({
          environmentId: ENVIRONMENT_ID,
          input: { cwd: "/repo", relativePath: "foo" },
        }),
        { suspendOnWaiting: true },
      ).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      const write = yield* Effect.promise(() =>
        h.commands.writeFile.run(h.registry, {
          environmentId: ENVIRONMENT_ID,
          input: { cwd: "/repo", relativePath: "foo", contents: "new" },
        }),
      );
      expect(write._tag).toBe("Success");
      expect(yield* readMetadata()).toEqual({ kind: "file", byteLength: 10 });
      yield* Deferred.succeed(release, undefined);
      expect((yield* Fiber.join(fileRead)).byteLength).toBe(5);
      h.registry.refresh(metadata);
      expect(yield* readMetadata()).toEqual({ kind: "file", byteLength: 10 });
      expect(h.metadataRequests).toHaveLength(2);
    }).pipe(Effect.scoped),
  );

  it.effect("refreshes retained canonical and original paths after an aliased write", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const threadId = ThreadId.make("write-metadata-thread");
      h.registry.mount(h.commands.fileMetadataThread({ environmentId: ENVIRONMENT_ID, threadId }));
      const atoms = ["/repo/foo", "/repo/./foo"].map((path) =>
        h.commands.fileMetadata({ environmentId: ENVIRONMENT_ID, input: { path, threadId } }),
      );
      for (const atom of atoms) h.registry.mount(atom);
      const read = () =>
        Effect.forEach(
          atoms,
          (atom) => AtomRegistry.getResult(h.registry, atom, { suspendOnWaiting: true }),
          { concurrency: "unbounded" },
        );
      expect(yield* read()).toEqual([
        { kind: "file", byteLength: 5 },
        { kind: "file", byteLength: 5 },
      ]);
      const result = yield* Effect.promise(() =>
        h.commands.writeFile.run(h.registry, {
          environmentId: ENVIRONMENT_ID,
          input: { cwd: "/repo", relativePath: "./foo", contents: "new" },
        }),
      );
      expect(result).toMatchObject({ _tag: "Success", value: { relativePath: "foo" } });
      expect(yield* read()).toEqual([
        { kind: "file", byteLength: 10 },
        { kind: "file", byteLength: 10 },
      ]);
      expect(h.metadataRequests.flat()).toEqual([
        "/repo/foo",
        "/repo/./foo",
        "/repo/foo",
        "/repo/./foo",
      ]);
    }).pipe(Effect.scoped),
  );
});

describe("scoped file metadata", () => {
  it.effect("does not seed a folder unless the response confirms its available identity", () =>
    Effect.gen(function* () {
      const responses: ReadonlyArray<ProjectListEntriesResult> = [
        {
          entries: [{ path: "api/folder.ts", kind: "directory" }],
          truncated: false,
        },
        {
          entries: [{ path: "api/folder.ts", kind: "directory" }],
          truncated: false,
          folders: [
            { folderPath: "/repo", label: "app", status: "ok" },
            { folderPath: "/api", label: "api", status: "unavailable" },
          ],
        },
        {
          entries: [{ path: "api/folder.ts", kind: "directory" }],
          truncated: false,
          folders: [
            { folderPath: "/repo", label: "app", status: "ok" },
            { folderPath: "/another-api", label: "api", status: "ok" },
          ],
        },
      ];
      for (const response of responses) {
        const h = yield* makeHarness(response);
        const result = yield* AtomRegistry.getResult(
          h.registry,
          h.commands.listEntries({
            environmentId: ENVIRONMENT_ID,
            input: {
              scope: { projectId: FILE_PROJECT_ID, threadId: FILE_THREAD_ID },
              directoryPath: "api",
            },
          }),
          { suspendOnWaiting: true },
        );
        expect(result).toEqual(response);
        expect(
          yield* AtomRegistry.getResult(
            h.registry,
            h.commands.fileMetadata({
              environmentId: ENVIRONMENT_ID,
              input: { path: "/sets/a/api/folder.ts" },
            }),
            { suspendOnWaiting: true },
          ),
        ).toEqual({ kind: "file", byteLength: 5 });
        expect(h.metadataRequests).toEqual([["/sets/a/api/folder.ts"]]);
      }
    }).pipe(Effect.scoped),
  );

  it.effect("selects a fresh scoped query when the caller's binding key changes", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const input = {
        scope: { projectId: FILE_PROJECT_ID, threadId: FILE_THREAD_ID },
        path: "api/foo",
      };
      const read = (bindingKey: string) =>
        AtomRegistry.getResult(
          h.registry,
          h.commands.readFile({ environmentId: ENVIRONMENT_ID, input, bindingKey }),
          { suspendOnWaiting: true },
        );
      expect((yield* read("first")).byteLength).toBe(5);
      h.file.byteLength = 10;
      expect((yield* read("second")).byteLength).toBe(10);
      expect((yield* read("first")).byteLength).toBe(5);
    }).pipe(Effect.scoped),
  );

  for (const query of ["searchEntries", "listEntries"] as const) {
    it.effect("seeds " + query + " kinds at the frozen secondary worktree path", () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const scope = { projectId: FILE_PROJECT_ID, threadId: FILE_THREAD_ID, folderPath: "/api" };
        const atom =
          query === "searchEntries"
            ? h.commands.searchEntries({
                environmentId: ENVIRONMENT_ID,
                input: { scope, query: "", limit: 10 },
              })
            : h.commands.listEntries({
                environmentId: ENVIRONMENT_ID,
                input: { scope, directoryPath: "api" },
              });
        yield* AtomRegistry.getResult(h.registry, atom, { suspendOnWaiting: true });
        const readMetadata = (path: string) =>
          AtomRegistry.getResult(
            h.registry,
            h.commands.fileMetadata({ environmentId: ENVIRONMENT_ID, input: { path } }),
            { suspendOnWaiting: true },
          );
        expect(yield* readMetadata("/sets/a/api/folder.ts")).toEqual({ kind: "directory" });
        expect(h.metadataRequests).toEqual([]);
        expect(yield* readMetadata("/api/folder.ts")).toEqual({ kind: "file", byteLength: 5 });
        expect(h.metadataRequests).toEqual([["/api/folder.ts"]]);
      }).pipe(Effect.scoped),
    );
  }

  it.effect("isolates identical canonical file paths in different thread worktrees", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      for (const [threadId, byteLength] of [
        [FILE_THREAD_ID, 5],
        [OTHER_FILE_THREAD_ID, 10],
      ] as const) {
        h.file.byteLength = byteLength;
        yield* AtomRegistry.getResult(
          h.registry,
          h.commands.readFile({
            environmentId: ENVIRONMENT_ID,
            input: { scope: { projectId: FILE_PROJECT_ID, threadId }, path: "api/foo" },
          }),
          { suspendOnWaiting: true },
        );
      }
      const metadata = yield* Effect.forEach(["/sets/a/api/foo", "/sets/b/api/foo"], (path) =>
        AtomRegistry.getResult(
          h.registry,
          h.commands.fileMetadata({ environmentId: ENVIRONMENT_ID, input: { path } }),
          { suspendOnWaiting: true },
        ),
      );
      expect(metadata).toEqual([
        { kind: "file", byteLength: 5 },
        { kind: "file", byteLength: 10 },
      ]);
      expect(h.metadataRequests).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps a one-folder scope's label-named subdirectory in the relative path", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      h.registry.set(h.fileProjectAtom, { ...FILE_PROJECT, folders: [FILE_FOLDERS[0]!] });
      yield* AtomRegistry.getResult(
        h.registry,
        h.commands.readFile({
          environmentId: ENVIRONMENT_ID,
          input: { scope: { projectId: FILE_PROJECT_ID }, path: "app/foo" },
        }),
        { suspendOnWaiting: true },
      );
      expect(
        yield* AtomRegistry.getResult(
          h.registry,
          h.commands.fileMetadata({
            environmentId: ENVIRONMENT_ID,
            input: { path: "/repo/app/foo" },
          }),
          { suspendOnWaiting: true },
        ),
      ).toEqual({ kind: "file", byteLength: 5 });
      expect(h.metadataRequests).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("does not seed a listing into a worktree binding changed during the request", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      h.readResponse.wait = Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
      );
      const reading = yield* AtomRegistry.getResult(
        h.registry,
        h.commands.listEntries({
          environmentId: ENVIRONMENT_ID,
          input: {
            scope: { projectId: FILE_PROJECT_ID, threadId: FILE_THREAD_ID },
            directoryPath: "api",
          },
        }),
        { suspendOnWaiting: true },
      ).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      h.registry.set(h.fileThreadAtom, fileThread(FILE_THREAD_ID, "new"));
      yield* Deferred.succeed(release, undefined);
      expect((yield* Fiber.join(reading)).entries[0]?.kind).toBe("directory");
      for (const path of ["/sets/a/api/folder.ts", "/sets/new/api/folder.ts"]) {
        expect(
          yield* AtomRegistry.getResult(
            h.registry,
            h.commands.fileMetadata({ environmentId: ENVIRONMENT_ID, input: { path } }),
            { suspendOnWaiting: true },
          ),
        ).toEqual({ kind: "file", byteLength: 5 });
      }
      expect(h.metadataRequests.flat()).toEqual([
        "/sets/a/api/folder.ts",
        "/sets/new/api/folder.ts",
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "refreshes scoped write aliases without restoring a stale read into retained metadata",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const scope = { projectId: FILE_PROJECT_ID, threadId: FILE_THREAD_ID, folderPath: "/api" };
        h.registry.mount(
          h.commands.fileMetadataThread({
            environmentId: ENVIRONMENT_ID,
            threadId: FILE_THREAD_ID,
          }),
        );
        const atoms = ["/sets/a/api/foo", "/sets/a/api/./foo"].map((path) =>
          h.commands.fileMetadata({
            environmentId: ENVIRONMENT_ID,
            input: { path, threadId: FILE_THREAD_ID },
          }),
        );
        for (const atom of atoms) h.registry.mount(atom);
        const readMetadata = () =>
          Effect.forEach(
            atoms,
            (atom) => AtomRegistry.getResult(h.registry, atom, { suspendOnWaiting: true }),
            { concurrency: "unbounded" },
          );
        expect(yield* readMetadata()).toEqual([
          { kind: "file", byteLength: 5 },
          { kind: "file", byteLength: 5 },
        ]);
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        h.readResponse.wait = Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
        );
        const reading = yield* AtomRegistry.getResult(
          h.registry,
          h.commands.readFile({ environmentId: ENVIRONMENT_ID, input: { scope, path: "api/foo" } }),
          { suspendOnWaiting: true },
        ).pipe(Effect.forkChild);
        yield* Deferred.await(started);
        const written = yield* Effect.promise(() =>
          h.commands.writeFile.run(h.registry, {
            environmentId: ENVIRONMENT_ID,
            input: { scope, path: "api/./foo", contents: "new" },
          }),
        );
        expect(written).toMatchObject({ _tag: "Success", value: { relativePath: "api/foo" } });
        expect(yield* readMetadata()).toEqual([
          { kind: "file", byteLength: 10 },
          { kind: "file", byteLength: 10 },
        ]);
        yield* Deferred.succeed(release, undefined);
        expect((yield* Fiber.join(reading)).byteLength).toBe(5);
        for (const atom of atoms) h.registry.refresh(atom);
        expect(yield* readMetadata()).toEqual([
          { kind: "file", byteLength: 10 },
          { kind: "file", byteLength: 10 },
        ]);
        expect(h.metadataRequests.flat()).toEqual([
          "/sets/a/api/foo",
          "/sets/a/api/./foo",
          "/sets/a/api/foo",
          "/sets/a/api/./foo",
        ]);
      }).pipe(Effect.scoped),
  );
});

describe("openScratch", () => {
  it.effect("resolves once the created project reaches the client store", () =>
    Effect.gen(function* () {
      const { registry, storedProject, openScratch } = yield* makeHarness();
      const opening = yield* Effect.forkChild(openScratch);
      yield* Effect.yieldNow;
      registry.set(storedProject, PROJECT);
      const result = yield* Fiber.join(opening);
      expect(result).toMatchObject({ _tag: "Success", value: PROJECT });
    }).pipe(Effect.scoped),
  );
});
