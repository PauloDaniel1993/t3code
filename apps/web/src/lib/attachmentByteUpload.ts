import { translatableError } from "@t3tools/client-runtime/errors";
import { msg } from "gt-react";

const UPLOAD_TIMEOUT_MS = 5 * 60_000;

export function uploadBytes(input: {
  readonly url: string;
  readonly file: File;
  readonly mimeType: string;
  readonly signal: AbortSignal;
  readonly onProgress: (progress: number) => void;
}): Promise<void> {
  const xhr = new XMLHttpRequest();
  const abort = () => xhr.abort();
  const done = new Promise<void>((resolve, reject) => {
    if (input.signal.aborted) {
      reject(translatableError(msg("Upload cancelled")));
      return;
    }
    xhr.open("POST", input.url, true);
    xhr.timeout = UPLOAD_TIMEOUT_MS;
    xhr.setRequestHeader("Content-Type", input.mimeType);
    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable && event.total > 0) {
        input.onProgress(event.loaded / event.total);
      }
    });
    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        reject(translatableError(msg("Upload rejected ({status})", { status: xhr.status })));
      }
    });
    xhr.addEventListener("error", () => reject(translatableError(msg("Upload failed"))));
    xhr.addEventListener("timeout", () => reject(translatableError(msg("Upload timed out"))));
    xhr.addEventListener("abort", () => reject(translatableError(msg("Upload cancelled"))));
    input.signal.addEventListener("abort", abort, { once: true });
    xhr.send(input.file);
  });
  return done.finally(() => input.signal.removeEventListener("abort", abort));
}
