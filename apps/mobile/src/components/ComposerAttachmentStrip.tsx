import type { UploadChatDocumentAttachment, UploadChatFileAttachment } from "@t3tools/contracts";
import { SymbolView } from "../components/AppSymbol";
import { Image, Pressable, ScrollView, Text, View } from "react-native";
import { useThemeColor } from "../lib/useThemeColor";

import type { DraftComposerImageAttachment } from "../lib/composerImages";

export type ComposerAttachmentStripAttachment =
  | DraftComposerImageAttachment
  | ((UploadChatDocumentAttachment | UploadChatFileAttachment) & { readonly id: string });

export interface ComposerAttachmentStripProps {
  /** Draft attachments to display. */
  readonly attachments: ReadonlyArray<ComposerAttachmentStripAttachment>;
  /** Called when the user taps an attachment's remove button. */
  readonly onRemove: (attachmentId: string) => void;
  /** Called when the user taps on an image thumbnail to preview it. */
  readonly onPressImage?: (previewUri: string) => void;
  /** Image thumbnail size in points.  Defaults to 72. */
  readonly imageSize?: number;
  /** Border radius of each image thumbnail.  Defaults to 16. */
  readonly imageBorderRadius?: number;
  /** Whether the remove button should sit in its own gutter instead of overlapping the image. */
  readonly removeButtonPlacement?: "overlay" | "gutter";
}

function formatAttachmentSize(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${Math.round(sizeBytes / 1024)} KiB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function attachmentTypeLabel(attachment: ComposerAttachmentStripAttachment): string {
  if (attachment.type === "document") return "PDF";
  const finalDot = attachment.name.lastIndexOf(".");
  if (finalDot <= 0 || finalDot === attachment.name.length - 1) return "FILE";
  return attachment.name.slice(finalDot + 1).toUpperCase();
}

/**
 * A horizontally-scrollable strip of attachment previews with remove buttons.
 * Used by both the thread composer and the new-task draft screen.
 */
export function ComposerAttachmentStrip(props: ComposerAttachmentStripProps) {
  const subtleBg = useThemeColor("--color-subtle");
  const borderColor = useThemeColor("--color-border");
  const foregroundColor = useThemeColor("--color-foreground");
  const mutedColor = useThemeColor("--color-foreground-muted");
  const iconColor = useThemeColor("--color-icon-muted");
  const size = props.imageSize ?? 72;
  const radius = props.imageBorderRadius ?? 16;
  const removeButtonPlacement = props.removeButtonPlacement ?? "overlay";
  const removeButtonGutter = removeButtonPlacement === "gutter" ? 10 : 0;

  if (props.attachments.length === 0) {
    return null;
  }

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="always"
      className="grow-0"
    >
      <View className="flex-row gap-2.5">
        {props.attachments.map((attachment) => (
          <View
            key={attachment.id}
            className="relative"
            style={{
              paddingTop: removeButtonGutter,
              paddingRight: removeButtonGutter,
            }}
          >
            {attachment.type === "image" ? (
              <Pressable
                onPress={
                  props.onPressImage ? () => props.onPressImage!(attachment.previewUri) : undefined
                }
              >
                <Image
                  source={{ uri: attachment.previewUri }}
                  style={{
                    width: size,
                    height: size,
                    borderRadius: radius,
                    backgroundColor: subtleBg,
                  }}
                  resizeMode="cover"
                />
              </Pressable>
            ) : (
              <View
                accessible
                accessibilityLabel={`${attachment.name}, ${attachmentTypeLabel(attachment)}, ${formatAttachmentSize(attachment.sizeBytes)}`}
                className="flex-row items-center gap-2 border px-2.5"
                style={{
                  width: Math.max(160, size * 2.25),
                  height: size,
                  borderRadius: radius,
                  backgroundColor: subtleBg,
                  borderColor,
                }}
              >
                <View className="size-8 items-center justify-center rounded-lg">
                  <SymbolView name="doc.text" size={17} tintColor={iconColor} type="monochrome" />
                </View>
                <View className="min-w-0 flex-1">
                  <Text
                    className="font-t3-medium text-xs"
                    numberOfLines={1}
                    style={{ color: foregroundColor }}
                  >
                    {attachment.name}
                  </Text>
                  <Text className="mt-0.5 text-[10px]" style={{ color: mutedColor }}>
                    {attachmentTypeLabel(attachment)} · {formatAttachmentSize(attachment.sizeBytes)}
                  </Text>
                </View>
              </View>
            )}
            <Pressable
              className="absolute h-[22px] w-[22px] items-center justify-center rounded-[11px] bg-black/55"
              style={{
                top: removeButtonPlacement === "gutter" ? 0 : 4,
                right: removeButtonPlacement === "gutter" ? 0 : 4,
              }}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel={`Remove ${attachment.name}`}
              onPress={() => props.onRemove(attachment.id)}
            >
              <SymbolView
                name="xmark"
                size={9}
                tintColor="#ffffff"
                type="monochrome"
                weight="bold"
              />
            </Pressable>
          </View>
        ))}
      </View>
    </ScrollView>
  );
}
