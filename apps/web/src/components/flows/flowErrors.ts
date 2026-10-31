import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { toastManager } from "../ui/toast";
export function reportFlowFailure(result: AtomCommandResult<unknown, unknown>, title: string) {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return null;
  const error = squashAtomCommandFailure(result);
  const message = error instanceof Error ? error.message : String(error);
  toastManager.add({ type: "error", title, description: message });
  return message;
}
