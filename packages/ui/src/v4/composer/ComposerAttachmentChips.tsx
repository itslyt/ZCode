/**
 * composer 附件 chip 渲染：主输入框与行内编辑框共用同一条渲染路径。
 *
 * 输入是 `useComposerAttachments` 的 scope 快照（上传中/失败/就绪三态都在里面），
 * 所以上传进度、失败重试、删除、图片/视频/PDF 预览都由本组件统一提供，
 * 调用方只负责把 `onRemove` / `onRetry` 接到自己那个 scope 的控制器上。
 */
import { useMemo, useState } from "react";
import {
  TID_V4_ATTACHMENT,
  TID_V4_ATTACHMENT_UPLOAD_PROGRESS,
  TID_V4_ATTACHMENT_UPLOAD_RETRY,
  testId,
} from "@zcode/shared";
import { ClipboardPenLineIcon, RotateCcwIcon, XIcon } from "lucide-react";
import {
  Attachment,
  Attachments,
  AttachmentInfo,
  AttachmentPreview,
} from "@/components/ai-elements/attachments.js";
import { Button } from "@/components/ui/button.js";
import { ImagePreviewDialog } from "@/components/ai-elements/image-preview-dialog.js";
import {
  ChatMediaAttachmentPreviewDialog,
  type ChatMediaAttachmentPreviewTarget,
} from "@/ChatMediaAttachmentPreviewDialog.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { FileDisplayIcon, resolveFileDisplayDescriptor } from "@/lib/fileDisplay.js";
import {
  isImageChatComposerAttachment,
  isMediaChatComposerAttachment,
  isPdfChatComposerAttachment,
  isVideoChatComposerAttachment,
  type ChatComposerAttachment,
} from "@/lib/chatAttachments.js";
import type { ComposerAttachmentUploadItem } from "@/store/composerAttachmentUploadStore.js";

function getComposerAttachmentTypeLabel(filename: string, mimeType: string): string {
  const leaf = filename.split(/[\\/]/u).at(-1) ?? filename;
  const dotIndex = leaf.lastIndexOf(".");
  if (dotIndex > 0 && dotIndex < leaf.length - 1) {
    return leaf.slice(dotIndex + 1).toUpperCase();
  }
  return (mimeType.split("/").at(-1) ?? mimeType).toUpperCase();
}

function formatAttachmentLineCount(attachment: ChatComposerAttachment, locale: string): string {
  const formatter = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  return formatter.format(typeof attachment.lineCount === "number" ? attachment.lineCount : 0);
}

export function ComposerAttachmentChips({
  attachments,
  onRemove,
  onRetry,
  rowTestId,
}: {
  attachments: readonly ComposerAttachmentUploadItem[];
  onRemove: (id: string) => void;
  onRetry: (id: string) => void;
  /** 归属标记：主输入框与编辑框各用一条，便于按入口区分（E2E / 手工验证）。 */
  rowTestId?: string;
}) {
  const { intl, locale } = useZCodeIntl();
  const [attachmentPreviewIndex, setAttachmentPreviewIndex] = useState(0);
  const [attachmentPreviewOpen, setAttachmentPreviewOpen] = useState(false);
  const [pdfAttachmentPreview, setPdfAttachmentPreview] =
    useState<ChatMediaAttachmentPreviewTarget | null>(null);
  const [pdfAttachmentPreviewOpen, setPdfAttachmentPreviewOpen] = useState(false);
  const attachmentPreviewTitle = intl.formatMessage({
    id: "chat.attachments.preview.open",
  });
  const videoAttachmentPreviewTitle = intl.formatMessage({
    id: "chat.attachments.preview.openVideo",
  });
  const orderedAttachments = useMemo(() => {
    // 媒体组（图片/视频）优先、文件在后；组内保持添加顺序。
    const media: ComposerAttachmentUploadItem[] = [];
    const files: ComposerAttachmentUploadItem[] = [];
    for (const attachment of attachments) {
      (isMediaChatComposerAttachment(attachment) ? media : files).push(attachment);
    }
    return [...media, ...files];
  }, [attachments]);
  const mediaPreviewItems = useMemo(
    () =>
      attachments.flatMap((attachment) =>
        attachment.objectUrl && isMediaChatComposerAttachment(attachment)
          ? [
              {
                alt: attachment.filename,
                filename: attachment.filename,
                mediaType: attachment.mimeType,
                src: attachment.objectUrl,
              },
            ]
          : [],
      ),
    [attachments],
  );

  if (attachments.length === 0) return null;

  return (
    <>
      <Attachments
        variant="inline"
        className="flex max-w-full flex-wrap gap-2"
        data-composer-file-attachments-row="true"
        data-testid={rowTestId}
      >
        {orderedAttachments.map((attachment) => {
          const isClipboardTextAttachment = attachment.sourceKind === "clipboard-text";
          const isMediaAttachment = isMediaChatComposerAttachment(attachment);
          const isVideoAttachment = isVideoChatComposerAttachment(attachment);
          const isPdfAttachment = isPdfChatComposerAttachment(attachment);
          const mediaType = attachment.objectUrl
            ? attachment.mimeType
            : attachment.mimeType.startsWith("image/")
              ? "application/octet-stream"
              : attachment.mimeType;
          const canPreviewImageAttachment =
            Boolean(attachment.objectUrl) && isImageChatComposerAttachment(attachment);
          const canPreviewVideoAttachment = Boolean(attachment.objectUrl) && isVideoAttachment;
          const canPreviewPdfAttachment = Boolean(attachment.objectUrl) && isPdfAttachment;
          const fileDisplayDescriptor = resolveFileDisplayDescriptor(
            attachment.localPath ?? attachment.filename,
          );
          const uploadStatusLabel =
            attachment.uploadStatus === "uploading"
              ? intl.formatMessage(
                  { id: "chat.attachments.upload.uploading" },
                  { progress: String(attachment.uploadProgress) },
                )
              : attachment.uploadStatus === "failed"
                ? intl.formatMessage(
                    { id: "chat.attachments.upload.failed" },
                    { message: attachment.uploadError ?? "unknown" },
                  )
                : intl.formatMessage({
                    id: `chat.attachments.upload.${attachment.uploadStatus}`,
                  });
          const showUploadStatus =
            !attachment.localZeroCopy &&
            (attachment.uploadStatus !== "ready" || attachment.showComplete);
          return (
            <Attachment
              key={attachment.id}
              variant={isMediaAttachment ? "grid" : "inline"}
              data-composer-attachment-kind={
                isVideoAttachment
                  ? "video"
                  : isMediaAttachment
                    ? "image"
                    : isPdfAttachment
                      ? "pdf"
                      : "file"
              }
              data-testid={testId(TID_V4_ATTACHMENT, attachment.id)}
              data-upload-status={attachment.uploadStatus}
              className={
                isMediaAttachment
                  ? "relative size-12 overflow-hidden rounded-lg bg-surface after:pointer-events-none after:absolute after:inset-0 after:rounded-lg after:border after:border-border after:content-['']"
                  : "h-12 w-fit max-w-full min-w-0 gap-2 rounded-lg border border-border bg-surface p-1.5 pr-6 [--attachment-bg:var(--color-surface)] hover:bg-surface-hover"
              }
              data={{
                id: attachment.id,
                type: "file",
                filename: attachment.filename,
                ...(isClipboardTextAttachment
                  ? {
                      description: intl.formatMessage(
                        {
                          id: "chat.attachments.clipboardText.description",
                        },
                        {
                          lineCount: formatAttachmentLineCount(attachment, locale),
                        },
                      ),
                      displayName: intl.formatMessage({
                        id: "chat.attachments.clipboardText",
                      }),
                      sourceKind: "clipboard-text" as const,
                    }
                  : {}),
                mediaType,
                url: attachment.objectUrl ?? "",
              }}
              onRemove={() => onRemove(attachment.id)}
              // 附件支持非图片格式，PDF 走独立 PdfViewer，
              // 其他文件展示类型图标和文件名，避免 doc 等普通文件被当成图片渲染失败。
              // 图片与视频统一按添加顺序进入发送前 gallery，
              // 保证同一组媒体可以连续导航。
              onOpen={
                canPreviewImageAttachment || canPreviewVideoAttachment
                  ? () => {
                      const previewIndex = mediaPreviewItems.findIndex(
                        (item) => item.src === attachment.objectUrl,
                      );
                      if (previewIndex < 0) return;
                      setAttachmentPreviewIndex(previewIndex);
                      setAttachmentPreviewOpen(true);
                    }
                  : canPreviewPdfAttachment
                    ? () => {
                        setPdfAttachmentPreview({
                          filename: attachment.filename,
                          mediaType: "application/pdf",
                          url: attachment.objectUrl,
                        });
                        setPdfAttachmentPreviewOpen(true);
                      }
                    : undefined
              }
              openLabel={
                canPreviewVideoAttachment
                  ? videoAttachmentPreviewTitle
                  : canPreviewImageAttachment
                    ? attachmentPreviewTitle
                    : canPreviewPdfAttachment
                      ? intl.formatMessage({ id: "chat.attachments.preview.openPdf" })
                      : undefined
              }
            >
              <div
                className={cn(
                  "relative shrink-0",
                  isMediaAttachment ? "size-full" : "size-9 rounded-md bg-background",
                )}
              >
                <AttachmentPreview
                  className={cn(isMediaAttachment ? "size-full rounded-none" : "size-9 rounded-md")}
                  fallbackIcon={
                    isClipboardTextAttachment ? (
                      <ClipboardPenLineIcon className="size-3.5 text-muted-foreground" />
                    ) : (
                      <FileDisplayIcon
                        src={fileDisplayDescriptor.fileIconSrc}
                        size={16}
                        className="size-4 shrink-0"
                      />
                    )
                  }
                />
                {showUploadStatus && isMediaAttachment ? (
                  <span
                    data-testid={testId(TID_V4_ATTACHMENT_UPLOAD_PROGRESS, attachment.id)}
                    role={attachment.uploadStatus === "failed" ? "alert" : "status"}
                    aria-label={uploadStatusLabel}
                    className="absolute inset-0 grid place-items-center rounded-lg bg-background/85 text-[7px] font-semibold text-foreground"
                  >
                    <svg
                      aria-hidden="true"
                      className="absolute inset-0 size-full -rotate-90 text-brand"
                      viewBox="0 0 24 24"
                    >
                      <circle
                        className="stroke-border"
                        cx="12"
                        cy="12"
                        fill="none"
                        pathLength="100"
                        r="9"
                        strokeWidth="2"
                      />
                      <circle
                        className={
                          attachment.uploadStatus === "failed"
                            ? "stroke-destructive"
                            : "stroke-current"
                        }
                        cx="12"
                        cy="12"
                        fill="none"
                        pathLength="100"
                        r="9"
                        strokeDasharray={`${attachment.uploadProgress} 100`}
                        strokeLinecap="round"
                        strokeWidth="2"
                      />
                    </svg>
                    <span className="relative">
                      {attachment.uploadStatus === "failed" ? "!" : `${attachment.uploadProgress}%`}
                    </span>
                  </span>
                ) : null}
              </div>
              {!isMediaAttachment ? (
                isClipboardTextAttachment ? (
                  <AttachmentInfo className="max-w-48 text-ui-base text-foreground" />
                ) : (
                  <div className="min-w-0 max-w-40 flex-1">
                    <span
                      className="block truncate text-ui-base font-medium text-foreground"
                      title={attachment.filename}
                    >
                      {attachment.filename}
                    </span>
                    <span className="block truncate text-ui-sm font-normal text-foreground-subtle">
                      {getComposerAttachmentTypeLabel(attachment.filename, attachment.mimeType)}
                    </span>
                  </div>
                )
              ) : null}
              {showUploadStatus && !isMediaAttachment ? (
                <span
                  data-testid={testId(TID_V4_ATTACHMENT_UPLOAD_PROGRESS, attachment.id)}
                  role={attachment.uploadStatus === "failed" ? "alert" : "status"}
                  title={uploadStatusLabel}
                  className={cn(
                    "max-w-28 truncate text-ui-sm font-normal text-foreground-subtle",
                    attachment.uploadStatus === "failed" && "text-destructive",
                  )}
                >
                  {attachment.uploadStatus === "uploading"
                    ? `${attachment.uploadProgress}%`
                    : uploadStatusLabel}
                </span>
              ) : null}
              {attachment.uploadStatus === "failed" ? (
                <button
                  type="button"
                  data-testid={testId(TID_V4_ATTACHMENT_UPLOAD_RETRY, attachment.id)}
                  aria-label={intl.formatMessage({
                    id: "chat.attachments.upload.retry",
                  })}
                  title={uploadStatusLabel}
                  className="grid size-5 shrink-0 place-items-center rounded-md text-destructive hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onRetry(attachment.id);
                  }}
                >
                  <RotateCcwIcon className="size-3" />
                </button>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                data-composer-attachment-remove={attachment.id}
                aria-label={intl.formatMessage({
                  id: "chat.attachments.remove",
                })}
                className="absolute right-0.5 top-0.5 z-20 size-3.5 rounded-full bg-primary p-0 text-primary-foreground opacity-0 transition-opacity hover:bg-primary/80 hover:text-primary-foreground group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onRemove(attachment.id);
                }}
              >
                <XIcon className="size-2.5" />
              </Button>
            </Attachment>
          );
        })}
      </Attachments>
      <ImagePreviewDialog
        initialIndex={attachmentPreviewIndex}
        items={mediaPreviewItems}
        onOpenChange={setAttachmentPreviewOpen}
        open={attachmentPreviewOpen}
      />
      <ChatMediaAttachmentPreviewDialog
        attachment={pdfAttachmentPreview}
        open={pdfAttachmentPreviewOpen}
        onOpenChange={(open) => {
          setPdfAttachmentPreviewOpen(open);
          if (!open) setPdfAttachmentPreview(null);
        }}
      />
    </>
  );
}
