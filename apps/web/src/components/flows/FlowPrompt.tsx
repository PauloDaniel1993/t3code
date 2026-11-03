import { randomUUID } from "../../lib/utils";
import { useContext, useEffect, useRef, useState, type ContextType } from "react";
import { useAtomValue } from "@effect/atom-react";
import { Paperclip, X } from "lucide-react";
import {
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES,
} from "@t3tools/contracts";
import { imageMimeType } from "@t3tools/shared/image";
import {
  runAttachmentUploadCycle,
  deletePendingAttachmentUpload,
} from "@t3tools/client-runtime/state/attachments";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useAssetUrls, resolveAssetUrl } from "../../assets/assetUrls";
import { useStableCallback } from "../../hooks/useStableCallback";
import { isHeicImageFile, prepareImageForAttachment } from "../../lib/imageCompression";
import { uploadBytes } from "../../lib/attachmentByteUpload";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { attachmentEnvironment } from "../../state/attachments";
import { flowEnvironment } from "../../state/flows";
import { environmentProjects } from "../../state/projects";
import { readPreparedConnection } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { ExpandedImageDialog } from "../chat/ExpandedImageDialog";
import type { ExpandedImagePreview } from "../chat/ExpandedImagePreview";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { FlowModelContext } from "./FlowModelPicker";

interface Props {
  prompt: string;
  images: ReadonlyArray<string>;
  onPrompt: (prompt: string) => void;
  onImages: (update: (images: ReadonlyArray<string>) => ReadonlyArray<string>) => void;
}

interface ImageJob {
  readonly name: string;
  readonly url: string;
  abort?: (() => void) | undefined;
  attachmentId?: string | undefined;
}

// Outside the component: React Compiler cannot lower try/finally or a throw inside try.
async function uploadPromptImage(input: {
  readonly source: File;
  readonly environmentId: NonNullable<ContextType<typeof FlowModelContext>>["environmentId"];
  readonly job: ImageJob;
  readonly live: () => boolean;
  readonly importUploaded: (attachmentId: string) => Promise<string>;
}): Promise<{ readonly path: string } | { readonly error: string } | null> {
  const { source, environmentId, job, live } = input;
  try {
    const prepared = await prepareImageForAttachment(source, PROVIDER_SEND_TURN_MAX_IMAGE_BYTES);
    if (!live()) return null;
    if (!prepared.ok)
      return {
        error:
          prepared.reason === "too-large"
            ? "Image exceeds the attachment size limit."
            : "Could not read this image.",
      };
    const file = prepared.file;
    const inferredMimeType = imageMimeType({ name: file.name, mimeType: file.type });
    const mimeType = PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES.find(
      (type) => type === inferredMimeType,
    );
    if (!mimeType) return { error: "Unsupported image type." };
    const uploaded = await runAttachmentUploadCycle({
      registry: appAtomRegistry,
      createUploadUrl: attachmentEnvironment.createUploadUrl,
      remove: attachmentEnvironment.remove,
      environmentId,
      upload: { name: file.name, mimeType, sizeBytes: file.size },
      resolveUploadUrl: (relativeUrl) => {
        const connection = readPreparedConnection(environmentId);
        return connection ? resolveAssetUrl(connection.httpBaseUrl, relativeUrl) : null;
      },
      transport: (url) => uploadBytes({ url, file, mimeType, onProgress: () => {} }),
      onMinted: (attachmentId) => {
        job.attachmentId = attachmentId;
        return live() ? "continue" : "cancel";
      },
      onTransferStart: (abort) => {
        job.abort = abort;
        if (!live()) abort();
      },
    });
    if (!live() || uploaded.status === "cancelled") return null;
    if (uploaded.status === "failed") throw uploaded.error;
    return { path: await input.importUploaded(uploaded.attachmentId) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export function FlowPrompt(props: Props) {
  const context = useContext(FlowModelContext);
  return context ? (
    <ImagePrompt {...props} {...context} />
  ) : (
    <Textarea
      size="sm"
      aria-label="Prompt"
      value={props.prompt}
      onChange={(event) => props.onPrompt(event.target.value)}
    />
  );
}

function ImagePrompt({
  prompt,
  images,
  onPrompt,
  onImages,
  environmentId,
  projectId,
}: Props & NonNullable<ContextType<typeof FlowModelContext>>) {
  const project = useAtomValue(environmentProjects.projectAtom({ environmentId, projectId }));
  const canImport = useAtomValue(flowEnvironment.importImage.permissionAtom(environmentId));
  const canUpload = useAtomValue(
    attachmentEnvironment.createUploadUrl.permissionAtom(environmentId),
  );
  const allowed = canImport && canUpload;
  const importImage = useAtomCommand(flowEnvironment.importImage, { reportFailure: false });
  const picker = useRef<HTMLInputElement>(null);
  const active = useRef(true);
  const [jobs] = useState(() => new Map<string, ImageJob>());
  const [pending, setPending] = useState<
    ReadonlyArray<{ id: string; name: string; url: string; file: File }>
  >([]);
  const [preview, setPreview] = useState<ExpandedImagePreview | null>(null);
  const urls = useAssetUrls(
    environmentId,
    project
      ? images.map((path) => ({
          _tag: "workspace-scope-file" as const,
          scope: { projectId, folderPath: project.workspaceRoot },
          path,
        }))
      : [],
  );
  const updateImages = useStableCallback(onImages);
  const release = useStableCallback((id: string) => {
    const job = jobs.get(id);
    if (!job) return;
    jobs.delete(id);
    job.abort?.();
    URL.revokeObjectURL(job.url);
    if (job.attachmentId)
      deletePendingAttachmentUpload({
        registry: appAtomRegistry,
        remove: attachmentEnvironment.remove,
        environmentId,
        attachmentId: job.attachmentId,
      });
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Cancel uploads and release owned object URLs when the step editor unmounts.
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      for (const id of jobs.keys()) release(id);
    };
  }, [jobs, release]);

  const importUploaded = async (attachmentId: string) => {
    const result = await importImage({ environmentId, input: { projectId, attachmentId } });
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    return result.value.path;
  };

  const add = async (files: ReadonlyArray<File>) => {
    if (!allowed) return;
    for (const source of files) {
      if (!active.current) return;
      if (
        !imageMimeType({ name: source.name, mimeType: source.type }) &&
        !isHeicImageFile(source)
      ) {
        toastManager.add({
          type: "error",
          title: "Unsupported image type",
          description: source.name,
        });
        continue;
      }
      const id = randomUUID();
      const job: ImageJob = { name: source.name, url: URL.createObjectURL(source) };
      jobs.set(id, job);
      setPending((previous) => [...previous, { id, name: job.name, url: job.url, file: source }]);
      const outcome = await uploadPromptImage({
        source,
        environmentId,
        job,
        live: () => jobs.has(id),
        importUploaded,
      });
      if (outcome && jobs.has(id)) {
        if ("path" in outcome) updateImages((current) => [...new Set([...current, outcome.path])]);
        else
          toastManager.add({
            type: "error",
            title: `Could not attach ${source.name}`,
            description: outcome.error,
          });
      }
      release(id);
      setPending((previous) => previous.filter((entry) => entry.id !== id));
    }
  };
  const previews = images.map((name, index) => ({ name, src: urls[index] ?? null }));
  const tiles = [
    ...previews.map((image) => ({ ...image, id: image.name, uploading: false, heic: false })),
    ...pending.map((job) => ({
      ...job,
      src: job.url,
      uploading: true,
      heic: isHeicImageFile(job.file),
    })),
  ];
  return (
    <>
      <Textarea
        size="sm"
        aria-label="Prompt"
        value={prompt}
        onChange={(event) => onPrompt(event.target.value)}
        onPaste={(event) => {
          const files = Array.from(event.clipboardData.files);
          if (files.length && allowed) {
            event.preventDefault();
            void add(files);
          }
        }}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes("Files") && allowed) event.preventDefault();
        }}
        onDrop={(event) => {
          if (event.dataTransfer.files.length) {
            event.preventDefault();
            void add(Array.from(event.dataTransfer.files));
          }
        }}
      />
      {tiles.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {tiles.map((image) => (
            <div
              key={image.id}
              className="relative h-16 w-16 overflow-hidden rounded-lg border border-border/80 bg-background"
            >
              <button
                type="button"
                className="h-full w-full cursor-zoom-in"
                aria-label={`Preview ${image.name}`}
                disabled={!image.src}
                onClick={() =>
                  setPreview(
                    image.uploading
                      ? { images: [{ name: image.name, src: image.src }], index: 0 }
                      : { images: previews, index: images.indexOf(image.name) },
                  )
                }
              >
                {image.src && !image.heic ? (
                  <img src={image.src} alt={image.name} className="h-full w-full object-cover" />
                ) : (
                  <span className="text-3xs">{image.name}</span>
                )}
              </button>
              {image.uploading && (
                <span className="pointer-events-none absolute inset-x-0 bottom-0 bg-background/85 text-center text-3xs">
                  Uploading…
                </span>
              )}
              <span className="absolute right-1 top-1">
                <Button
                  variant="media-close"
                  size="icon-xs"
                  aria-label={`Remove ${image.name}`}
                  disabled={!canImport}
                  onClick={() => {
                    if (image.uploading) {
                      release(image.id);
                      setPending((previous) => previous.filter((entry) => entry.id !== image.id));
                    } else updateImages((current) => current.filter((path) => path !== image.name));
                  }}
                >
                  <X />
                </Button>
              </span>
            </div>
          ))}
        </div>
      )}
      <div>
        <Button
          size="xs"
          variant="ghost"
          disabled={!allowed}
          onClick={() => picker.current?.click()}
        >
          <Paperclip /> Attach images
        </Button>
      </div>
      <input
        ref={picker}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp,image/heic,image/heif,.heic,.heif"
        multiple
        hidden
        onChange={(event) => {
          void add(Array.from(event.target.files ?? []));
          event.target.value = "";
        }}
      />
      {preview && <ExpandedImageDialog preview={preview} onClose={() => setPreview(null)} />}
    </>
  );
}
