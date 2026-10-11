import { createEnvironmentProjectAtoms } from "@t3tools/client-runtime/state/projects";
import { createProjectEnvironmentAtoms } from "@t3tools/client-runtime/state/projects";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentSnapshotAtom } from "./shell";
import { WS_METHODS } from "@t3tools/contracts";
import { createWorkspaceFileQuery } from "./workspace-file-bindings";

const legacy = createProjectEnvironmentAtoms(connectionAtomRuntime);
const searchEntries = createWorkspaceFileQuery({
  tag: WS_METHODS.projectsSearchEntries,
  label: "mobile:scoped-file-search",
  staleTimeMs: 15_000,
});
const listEntries = createWorkspaceFileQuery({
  tag: WS_METHODS.projectsListEntries,
  label: "mobile:scoped-file-list",
  staleTimeMs: 30_000,
});
const readFile = createWorkspaceFileQuery({
  tag: WS_METHODS.projectsReadFile,
  label: "mobile:scoped-file-read",
  staleTimeMs: 30_000,
});
export const projectEnvironment = {
  ...legacy,
  searchEntries: (target: Parameters<typeof legacy.searchEntries>[0]) =>
    "scope" in target.input
      ? searchEntries(target, target.input.scope)
      : legacy.searchEntries(target),
  listEntries: (target: Parameters<typeof legacy.listEntries>[0]) =>
    "scope" in target.input ? listEntries(target, target.input.scope) : legacy.listEntries(target),
  readFile: (target: Parameters<typeof legacy.readFile>[0]) =>
    "scope" in target.input ? readFile(target, target.input.scope) : legacy.readFile(target),
};
export const environmentProjects = createEnvironmentProjectAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  snapshotAtom: environmentSnapshotAtom,
});
