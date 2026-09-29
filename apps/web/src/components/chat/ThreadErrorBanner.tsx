import type { OrchestrationV2ProviderFailureClass } from "@t3tools/contracts";
import { memo } from "react";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { CircleAlertIcon, XIcon } from "lucide-react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** `occurrence` tells apart two failures on one thread that carry the same text. */
export function getThreadErrorBannerKey(
  threadKey: string,
  error: string | null,
  occurrence = "",
): string | null {
  return error === null ? null : `${threadKey}\u0000${occurrence}\u0000${error}`;
}

export function shouldShowThreadErrorBanner(
  threadKey: string,
  error: string | null,
  isDismissed: boolean,
): boolean {
  return getThreadErrorBannerKey(threadKey, error) !== null && !isDismissed;
}

// Session-scoped (module-level so it survives ChatView remounts, e.g. route
// changes between threads). Mirrors the branch-mismatch banner: a dismissal
// is remembered per thread key, occurrence and message, so navigating away to
// a thread with no error cannot resurrect the banner, while a different error,
// or the same text failing again, on the same thread still appears. Each new
// occurrence adds a key, so the set keeps only the newest
// MAX_DISMISSED_THREAD_ERROR_KEYS and forgets the oldest dismissal first.
export const MAX_DISMISSED_THREAD_ERROR_KEYS = 200;
const sessionDismissedThreadErrorBannerKeys = new Set<string>();

export function dismissThreadErrorBannerForSession(bannerKey: string | null): void {
  if (bannerKey === null) return;
  sessionDismissedThreadErrorBannerKeys.delete(bannerKey);
  sessionDismissedThreadErrorBannerKeys.add(bannerKey);
  for (const oldest of sessionDismissedThreadErrorBannerKeys) {
    if (sessionDismissedThreadErrorBannerKeys.size <= MAX_DISMISSED_THREAD_ERROR_KEYS) break;
    sessionDismissedThreadErrorBannerKeys.delete(oldest);
  }
}

export function isThreadErrorBannerDismissedForSession(bannerKey: string | null): boolean {
  return bannerKey !== null && sessionDismissedThreadErrorBannerKeys.has(bannerKey);
}

export const ThreadErrorBanner = memo(function ThreadErrorBanner({
  error,
  onDismiss,
  errorClass,
}: {
  error: string | null;
  errorClass?: OrchestrationV2ProviderFailureClass | null;
  onDismiss?: () => void;
}) {
  if (!error) return null;
  const variant = errorClass === "usage_limit" ? "warning" : "error";
  return (
    <div className="pointer-events-auto mx-auto w-fit max-w-[min(48rem,calc(100%-2rem))] pt-3">
      <Alert variant={variant} surface="glass" controlAlignment="first-line" data-variant={variant}>
        <CircleAlertIcon />
        <AlertDescription>
          <Tooltip>
            <TooltipTrigger render={<div className="line-clamp-3" />}>{error}</TooltipTrigger>
            <TooltipPopup side="top" className="whitespace-pre-wrap">
              {error}
            </TooltipPopup>
          </Tooltip>
        </AlertDescription>
        {onDismiss && (
          <AlertAction>
            <Button variant="ghost" size="icon-xs" aria-label="Dismiss error" onClick={onDismiss}>
              <XIcon />
            </Button>
          </AlertAction>
        )}
      </Alert>
    </div>
  );
});
