// Attaching by PASTE or DROP, on exactly the same terms as the paperclip.
//
// Until now the only way to attach was a native file dialog, so a screenshot had to be saved to disk
// first. That is the wrong shape for the work this app is used for, which is mostly looking at
// screenshots of GTM and GA4.
//
// The rule here is that there must be ONE attachment path, not three. A pasted image, a dropped file
// and a picked file end up as the same ChatAttachmentView, under the same size caps, with the same
// chip in the composer and the same honest fallback text for providers that cannot see images. This
// module holds the parts that decide that, so the renderer can reject something instantly instead of
// sending megabytes to the main process only to be told no.

/** Image types the clipboard realistically produces, matching what the file picker accepts. */
export const PASTE_IMAGE_MIMES: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

/** The same ceiling the file picker enforces, so behaviour cannot drift between the two routes. */
export const MAX_PASTE_IMAGE_BYTES = 5 * 1024 * 1024;
/** Everything else (pdf, docx, xlsx, ...) shares the picker's larger file ceiling. */
export const MAX_DROP_FILE_BYTES = 15 * 1024 * 1024;

/** Extensions the picker accepts. A drop of anything else is refused with the same message. */
export const DROPPABLE_EXTS = [
  'pdf', 'docx', 'doc', 'xlsx', 'csv', 'tsv', 'txt', 'md', 'json', 'log', 'html', 'xml', 'yml', 'yaml',
  'png', 'jpg', 'jpeg', 'webp', 'gif',
];

export type AttachCheck = { ok: true; name: string } | { ok: false; error: string };

const mb = (n: number): string => `${Math.round((n / (1024 * 1024)) * 10) / 10} MB`;

/**
 * A filename for a clipboard image, which arrives with none.
 *
 * Dated rather than random, so several pastes in one session are still tellable apart in the
 * composer chip and in the chat history, and so the name means something later.
 */
export function pastedImageName(mimeType: string, at: string, seq = 0): string {
  const ext = PASTE_IMAGE_MIMES[String(mimeType ?? '').toLowerCase()] ?? '.png';
  const day = String(at ?? '').slice(0, 10) || 'image';
  return seq > 0 ? `pasted-image-${day}-${seq + 1}${ext}` : `pasted-image-${day}${ext}`;
}

/** Can this clipboard image be attached? Rejections carry the same wording as the picker's. */
export function checkPastedImage(mimeType: string, bytes: number, at: string, seq = 0): AttachCheck {
  const mime = String(mimeType ?? '').toLowerCase();
  if (!PASTE_IMAGE_MIMES[mime]) {
    return { ok: false, error: `Pasted content of type "${mime || 'unknown'}" cannot be attached. Copy an image (png, jpg, webp or gif) instead.` };
  }
  if (!bytes || bytes <= 0) return { ok: false, error: 'That paste contained no image data.' };
  if (bytes > MAX_PASTE_IMAGE_BYTES) {
    return { ok: false, error: `That image is too large (${mb(bytes)}; the limit is 5 MB). Crop or resize it first.` };
  }
  return { ok: true, name: pastedImageName(mime, at, seq) };
}

/** Can this dropped file be attached? Mirrors the picker's filters and ceilings. */
export function checkDroppedFile(name: string, bytes: number): AttachCheck {
  const clean = String(name ?? '').trim();
  if (!clean) return { ok: false, error: 'That file has no name, so it cannot be attached.' };
  const ext = clean.includes('.') ? clean.split('.').pop()!.toLowerCase() : '';
  if (!DROPPABLE_EXTS.includes(ext)) {
    return { ok: false, error: `"${clean}" is not a supported file type. Supported: ${DROPPABLE_EXTS.join(', ')}.` };
  }
  const isImage = ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext);
  const cap = isImage ? MAX_PASTE_IMAGE_BYTES : MAX_DROP_FILE_BYTES;
  if (bytes > cap) {
    return { ok: false, error: `"${clean}" is too large (${mb(bytes)}; the limit is ${isImage ? '5 MB for images' : '15 MB'}).` };
  }
  return { ok: true, name: clean };
}

/** Only ONE attachment rides along at a time, so a multi-file drop says so instead of silently
 *  taking the first and discarding the rest. */
export function multiDropNote(count: number): string | null {
  return count > 1 ? `${count} files were dropped. Only the first is attached; send it, then drop the next.` : null;
}
