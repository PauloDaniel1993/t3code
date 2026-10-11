import {
  createVcsActionManager,
  createVcsEnvironmentAtoms,
  createWorkspaceVcsAtoms,
} from "@t3tools/client-runtime/state/vcs";

import { connectionAtomRuntime } from "../connection/runtime";

export const vcsEnvironment = createVcsEnvironmentAtoms(connectionAtomRuntime);
export const vcsActionManager = createVcsActionManager(connectionAtomRuntime);
export const workspaceVcs = createWorkspaceVcsAtoms(connectionAtomRuntime);
