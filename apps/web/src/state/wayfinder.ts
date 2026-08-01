import { createWayfinderEnvironmentAtoms } from "@t3tools/client-runtime/state/wayfinder";

import { connectionAtomRuntime } from "../connection/runtime";

export const wayfinderEnvironment = createWayfinderEnvironmentAtoms(connectionAtomRuntime);
