import type { FlowInput } from "@t3tools/contracts";
import { msg } from "gt-react";
import type { MessageResolver } from "~/i18n/messages";

export function flowInputTypeHint(field: FlowInput, resolve: MessageResolver) {
  return field.required
    ? resolve(msg("{type} · required"), { type: field.type })
    : resolve(msg("{type} · optional"), { type: field.type });
}
