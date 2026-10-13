import { createEnvironmentProjectAtoms } from "@t3tools/client-runtime/state/projects";
import { createProjectEnvironmentAtoms } from "@t3tools/client-runtime/state/projects";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentSnapshotAtom } from "./shell";
import { Atom } from "effect/reactivity";
import { switchWorkspaceFileQuery, workspaceFileBindingAtom } from "./workspace-file-bindings";
import { serverEnvironment } from "./server";
import { environmentThreadDetails } from "./threads";

export const environmentProjects = createEnvironmentProjectAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  snapshotAtom: environmentSnapshotAtom,
  serverConfigValueAtom: serverEnvironment.configValueAtom,
});
const unscoped = createProjectEnvironmentAtoms(connectionAtomRuntime, {
  projectAtom: environmentProjects.projectAtom,
  threadAtom: environmentThreadDetails.threadAtom,
});
const searchEntries = Atom.family((key: string) => {
  const target = JSON.parse(key) as Parameters<typeof unscoped.searchEntries>[0];
  return switchWorkspaceFileQuery(
    workspaceFileBindingAtom(
      target.environmentId,
      "scope" in target.input ? target.input.scope : null,
    ),
    (bindingKey) => unscoped.searchEntries({ ...target, bindingKey }),
  ).pipe(Atom.setIdleTTL(5 * 60_000));
});
const listEntries = Atom.family((key: string) => {
  const target = JSON.parse(key) as Parameters<typeof unscoped.listEntries>[0];
  return switchWorkspaceFileQuery(
    workspaceFileBindingAtom(
      target.environmentId,
      "scope" in target.input ? target.input.scope : null,
    ),
    (bindingKey) => unscoped.listEntries({ ...target, bindingKey }),
  ).pipe(Atom.setIdleTTL(5 * 60_000));
});
const readFile = Atom.family((key: string) => {
  const target = JSON.parse(key) as Parameters<typeof unscoped.readFile>[0];
  return switchWorkspaceFileQuery(
    workspaceFileBindingAtom(
      target.environmentId,
      "scope" in target.input ? target.input.scope : null,
    ),
    (bindingKey) => unscoped.readFile({ ...target, bindingKey }),
  ).pipe(Atom.setIdleTTL(5 * 60_000));
});
export const projectEnvironment = {
  ...unscoped,
  searchEntries: (target: Parameters<typeof unscoped.searchEntries>[0]) =>
    "scope" in target.input
      ? searchEntries(JSON.stringify(target))
      : unscoped.searchEntries(target),
  listEntries: (target: Parameters<typeof unscoped.listEntries>[0]) =>
    "scope" in target.input ? listEntries(JSON.stringify(target)) : unscoped.listEntries(target),
  readFile: (target: Parameters<typeof unscoped.readFile>[0]) =>
    "scope" in target.input ? readFile(JSON.stringify(target)) : unscoped.readFile(target),
};
