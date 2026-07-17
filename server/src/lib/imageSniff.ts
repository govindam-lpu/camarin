/**
 * Content-based image type detection via magic bytes.
 *
 * Extensions and Content-Type headers are attacker-controlled; the first bytes of the
 * file are not. A renamed `.txt -> .jpg` passes a MIME whitelist but fails here.
 * Deliberately zero-dependency (~20 lines) instead of pulling in `file-type`.
 */

export const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

export interface SniffedImage {
  ext: 'jpg' | 'png' | 'webp';
  mime: (typeof ALLOWED_MIME_TYPES)[number];
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function sniffImage(buf: Buffer): SniffedImage | null {
  // JPEG: FF D8 FF
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { ext: 'jpg', mime: 'image/jpeg' };
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return { ext: 'png', mime: 'image/png' };
  }
  // WEBP: "RIFF" <4-byte size> "WEBP"
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { ext: 'webp', mime: 'image/webp' };
  }
  return null;
}
