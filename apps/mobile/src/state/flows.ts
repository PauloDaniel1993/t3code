import { createFlowEnvironmentAtoms } from "@t3tools/client-runtime/flows";
import { connectionAtomRuntime } from "../connection/runtime";

export const flowEnvironment = createFlowEnvironmentAtoms(connectionAtomRuntime);
