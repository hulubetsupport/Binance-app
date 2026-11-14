import crypto from 'node:crypto';
import type { Database } from './db.ts';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB

const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export function detectImageMimeFromBytes(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return 'image/png';
  }
  // WEBP: RIFF....WEBP
  if (
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

export async function savePrivateImage(
  db: Database,
  params: {
    ownerUserId: number | null;
    purpose: string;
    buffer: Buffer;
    declaredMime?: string;
  }
): Promise<{ fileId: string; mimeType: string; sizeBytes: number }> {
  if (!Buffer.isBuffer(params.buffer) || params.buffer.length === 0) {
    throw new Error('Uploaded file is empty');
  }
  if (params.buffer.length > MAX_IMAGE_BYTES) {
    throw new Error('File exceeds 5MB limit');
  }

  const detectedMime = detectImageMimeFromBytes(params.buffer);
  if (!detectedMime || !ALLOWED_MIME_TYPES.has(detectedMime)) {
    throw new Error('Invalid image type: only JPEG, PNG, and WEBP images are allowed');
  }
  if (params.declaredMime && ALLOWED_MIME_TYPES.has(params.declaredMime) && params.declaredMime !== detectedMime) {
    // Use detected magic-byte MIME strictly
  }

  const fileId = `pf_${crypto.randomUUID().replace(/-/g, '')}`;
  const base64 = params.buffer.toString('base64');

  await db.query(
    `INSERT INTO private_files (id, owner_user_id, purpose, mime_type, size_bytes, data_base64)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [fileId, params.ownerUserId, params.purpose, detectedMime, params.buffer.length, base64]
  );

  return { fileId, mimeType: detectedMime, sizeBytes: params.buffer.length };
}

export function parseDataUrlImage(dataUrl: string): Buffer {
  const trimmed = dataUrl.trim();
  const match = /^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=]+)$/i.exec(trimmed);
  if (!match) {
    throw new Error('Invalid image data URL (expected PNG/JPEG/WEBP base64)');
  }
  const buf = Buffer.from(match[2], 'base64');
  if (buf.length > MAX_IMAGE_BYTES) {
    throw new Error('Image exceeds 5MB size limit');
  }
  return buf;
}

export async function getPrivateImage(
  db: Database,
  fileId: string
): Promise<{ id: string; owner_user_id: number | null; purpose: string; mime_type: string; buffer: Buffer } | null> {
  const res = await db.query<{
    id: string;
    owner_user_id: number | null;
    purpose: string;
    mime_type: string;
    data_base64: string;
  }>(`SELECT id, owner_user_id, purpose, mime_type, data_base64 FROM private_files WHERE id = $1`, [fileId]);

  if (res.rows.length === 0) return null;
  const row = res.rows[0];
  return {
    id: row.id,
    owner_user_id: row.owner_user_id,
    purpose: row.purpose,
    mime_type: row.mime_type,
    buffer: Buffer.from(row.data_base64, 'base64'),
  };
}
