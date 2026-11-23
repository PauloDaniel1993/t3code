import { describe, expect, it } from "@effect/vitest";
import {
  AuthFilesystemWriteScope,
  EnvironmentId,
  ProjectId,
  ProjectReadFileError,
  ProjectReadFileInput,
  ProjectReadFileResult,
  ThreadId,
  type AuthSessionState,
  type ProjectListEntriesResult,
  type ScopedProjectRef,
  WS_METHODS,
} from "@t3tools/contracts";
import { vi } from "vite-plus/test";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Stream from "effect/Stream";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import { AVAILABLE_CONNECTION_STATE, BearerConnectionTarget } from "../connection/model.ts";

import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import type { EnvironmentProject, EnvironmentThread } from "./models.ts";
import { createProjectEnvironmentAtoms } from "./projectCommands.ts";
import type { EnvironmentRpcInput } from "../rpc/client.ts";
import { v2Project, v2Projection } from "./orchestrationV2TestFixtures.ts";

const decodeReadFileInput = Schema.decodeUnknownSync(ProjectReadFileInput);
const decodeReadFileResult = Schema.decodeUnknownSync(ProjectReadFileResult);
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
  const readResponse = {
    wait: Effect.void as Effect.Effect<void, ProjectReadFileError>,
    missing: false,
  };
  const entryResponse: ProjectListEntriesResult = listing ?? {
    entries: [{ path: "api/folder.ts", kind: "directory" }],
    truncated: false,
    folders: [
      { folderPath: "/repo", label: "app", status: "ok" },
      { folderPath: "/api", label: "api", status: "ok" },
    ],
  };
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: new BearerConnectionTarget({
      environmentId: ENVIRONMENT_ID,
      label: "Test",
      connectionId: "test",
    }),
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
              return decodeReadFileResult(
                readResponse.missing
                  ? {
                      relativePath,
                      byteLength: 0,
                      contents: "",
                      truncated: false,
                      exists: false,
                    }
                  : { relativePath, byteLength, contents: "old", truncated: false },
              );
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
                entries: input.paths.map(() =>
                  readResponse.missing
                    ? null
                    : { kind: "file" as const, byteLength: file.byteLength },
                ),
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
        SecureRandom.SecureRandom,
        SecureRandom.make((size) => new Uint8Array(size)),
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
  const openScratch = Effect.exit(
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
  it.effect("retires a saved overlay after an equal read succeeds, preserving newer drafts", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const target = { environmentId: ENVIRONMENT_ID, cwd: "/repo", relativePath: "foo" };
      const query = h.commands.readFile({
        environmentId: ENVIRONMENT_ID,
        input: { cwd: target.cwd, relativePath: target.relativePath },
      });
      h.registry.mount(query);
      const read = () => AtomRegistry.getResult(h.registry, query, { suspendOnWaiting: true });
      const original = yield* read();
      const overlay = h.commands.optimisticFile(target);
      h.registry.mount(overlay);
      const saved = { ...original, contents: "saved" };
      h.registry.set(overlay, { data: saved, saved: true, confirmingQuery: query });
      h.readResponse.wait = Effect.fail(
        new ProjectReadFileError({
          cwd: "/repo",
          relativePath: "foo",
          failure: "operation_failed",
        }),
      );
      h.registry.refresh(query);
      yield* Effect.exit(read());
      expect(h.registry.get(overlay)?.data.contents).toBe("saved");

      h.readResponse.wait = Effect.void;
      h.registry.refresh(query);
      const refreshed = yield* read();
      // The production query shares equal file values across this failed confirmation.
      expect(refreshed).toBe(original);
      expect(h.registry.get(overlay)).toBeNull();

      h.registry.set(overlay, { data: { ...saved, contents: "newer draft" }, saved: false });
      h.registry.refresh(query);
      yield* read();
      expect(h.registry.get(overlay)?.data.contents).toBe("newer draft");
    }),
  );

  it.effect.each([true, false])(
    "keeps a saved overlay when an older read uses different allowMissing options (confirmation: %s)",
    (allowMissing) =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const target = { environmentId: ENVIRONMENT_ID, cwd: "/repo", relativePath: "foo" };
        const query = h.commands.readFile({
          environmentId: ENVIRONMENT_ID,
          input: {
            cwd: target.cwd,
            relativePath: target.relativePath,
            ...(allowMissing ? { allowMissing: true } : {}),
          },
        });
        const otherQuery = h.commands.readFile({
          environmentId: ENVIRONMENT_ID,
          input: {
            cwd: target.cwd,
            relativePath: target.relativePath,
            ...(!allowMissing ? { allowMissing: true } : {}),
          },
        });
        const read = (atom: typeof query) =>
          AtomRegistry.getResult(h.registry, atom, { suspendOnWaiting: true });
        h.registry.mount(query);
        const original = yield* read(query);
        const overlay = h.commands.optimisticFile(target);
        h.registry.mount(overlay);
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        h.readResponse.wait = Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
        );
        h.registry.mount(otherQuery);
        const olderRead = yield* read(otherQuery).pipe(Effect.forkChild);
        yield* Deferred.await(started);
        h.registry.set(overlay, {
          data: { ...original, contents: "saved" },
          saved: true,
          confirmingQuery: query,
        });
        h.readResponse.wait = Effect.fail(
          new ProjectReadFileError({
            cwd: target.cwd,
            relativePath: target.relativePath,
            failure: "operation_failed",
          }),
        );
        h.registry.refresh(query);
        yield* Effect.exit(read(query));
        expect(h.registry.get(overlay)?.data.contents).toBe("saved");

        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(olderRead);
        expect(h.registry.get(overlay)?.data.contents).toBe("saved");
        expect(Option.getOrNull(AsyncResult.value(h.registry.get(query)))).toBe(original);

        h.readResponse.wait = Effect.void;
        h.registry.refresh(query);
        expect(yield* read(query)).toBe(original);
        expect(h.registry.get(overlay)).toBeNull();
      }),
  );

  it.effect("preserves optional read results without seeding metadata for an absent file", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      h.readResponse.missing = true;
      const input = { cwd: "/repo", relativePath: "foo", allowMissing: true };
      expect.soft(decodeReadFileInput(input)).toEqual(input);
      const result = yield* AtomRegistry.getResult(
        h.registry,
        h.commands.readFile({ environmentId: ENVIRONMENT_ID, input }),
        { suspendOnWaiting: true },
      );
      expect.soft(result).toEqual({
        relativePath: "foo",
        byteLength: 0,
        contents: "",
        truncated: false,
        exists: false,
      });
      const metadata = h.commands.fileMetadata({
        environmentId: ENVIRONMENT_ID,
        input: { path: "/repo/foo" },
      });
      expect(
        yield* AtomRegistry.getResult(h.registry, metadata, { suspendOnWaiting: true }),
      ).toBeNull();
      expect(h.metadataRequests).toEqual([["/repo/foo"]]);
    }),
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
      const write = yield* Effect.exit(
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
    }),
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
      const result = yield* Effect.exit(
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
    }),
  );
});

describe("scoped file metadata", () => {
  it.effect("does not seed metadata for an absent file in a secondary worktree", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      h.readResponse.missing = true;
      const input = {
        scope: { projectId: FILE_PROJECT_ID, threadId: FILE_THREAD_ID },
        path: "api/foo",
        allowMissing: true,
      };
      expect(decodeReadFileInput(input)).toEqual(input);
      expect(
        yield* AtomRegistry.getResult(
          h.registry,
          h.commands.readFile({ environmentId: ENVIRONMENT_ID, input }),
          { suspendOnWaiting: true },
        ),
      ).toMatchObject({ relativePath: "api/foo", exists: false });
      expect(
        yield* AtomRegistry.getResult(
          h.registry,
          h.commands.fileMetadata({
            environmentId: ENVIRONMENT_ID,
            input: { path: "/sets/a/api/foo" },
          }),
          { suspendOnWaiting: true },
        ),
      ).toBeNull();
      expect(h.metadataRequests).toEqual([["/sets/a/api/foo"]]);
    }).pipe(Effect.scoped),
  );

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

  it.effect("keeps scoped queries and optimistic save confirmation bound to one workspace", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const scope = { projectId: FILE_PROJECT_ID, threadId: FILE_THREAD_ID };
      const input = { scope, path: "api/foo" };
      const query = (bindingKey: string) =>
        h.commands.readFile({ environmentId: ENVIRONMENT_ID, input, bindingKey });
      const firstQuery = query("first");
      h.registry.mount(firstQuery);
      const read = (atom: typeof firstQuery) =>
        AtomRegistry.getResult(h.registry, atom, { suspendOnWaiting: true });
      const original = yield* read(firstQuery);
      expect(original.byteLength).toBe(5);
      const overlay = h.commands.optimisticFile({
        environmentId: ENVIRONMENT_ID,
        cwd: JSON.stringify([scope.projectId, scope.threadId, null]),
        relativePath: input.path,
      });
      h.registry.mount(overlay);
      h.registry.set(overlay, {
        data: { ...original, contents: "saved" },
        saved: true,
        confirmingQuery: firstQuery,
      });

      h.file.byteLength = 10;
      expect((yield* read(query("second"))).byteLength).toBe(10);
      expect(h.registry.get(overlay)?.data.contents).toBe("saved");
      expect((yield* read(firstQuery)).byteLength).toBe(5);

      h.registry.refresh(firstQuery);
      expect((yield* read(firstQuery)).byteLength).toBe(10);
      expect(h.registry.get(overlay)).toBeNull();
    }).pipe(Effect.scoped),
  );

  it.effect.each(["searchEntries", "listEntries"] as const)(
    "seeds %s kinds at the frozen secondary worktree path",
    (query) =>
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
        const written = yield* h.commands.writeFile.run(h.registry, {
          environmentId: ENVIRONMENT_ID,
          input: { scope, path: "api/./foo", contents: "new" },
        });
        expect(written).toMatchObject({ relativePath: "api/foo" });
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
    }),
  );
});
