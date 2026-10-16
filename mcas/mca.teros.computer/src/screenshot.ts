import { mkdir, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { ComputerError } from './errors';

export interface EncodedShot {
  data: Buffer;
  mime: 'image/jpeg';
  width: number;
  height: number;
  /** Screen pixels per image pixel: screen_x = image_x * scale. */
  scale: number;
}

/**
 * Downscale and JPEG-encode a full-screen PNG. 1024 px wide at q≈60 keeps a
 * 1280×800 desktop around 40-90 KB and ~900 image tokens: plenty for reading
 * a page, cheap enough to send on every look.
 */
export async function encodeShot(png: Buffer, width = 1024, quality = 60): Promise<EncodedShot> {
  const meta = await sharp(png).metadata();
  const srcW = meta.width ?? width;
  const targetW = Math.min(width, srcW);
  const { data, info } = await sharp(png)
    .resize({ width: targetW })
    .jpeg({ quality, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });
  return { data, mime: 'image/jpeg', width: info.width, height: info.height, scale: srcW / info.width };
}

/**
 * Make the image reachable by the LLM image pipeline. Preferred path: upload
 * to the backend's media store with this container's callback token — the
 * returned http URL works whatever the deployment layout. Without a backend
 * (local runs), fall back to a file under /workspace.
 */
export async function publishShot(shot: EncodedShot): Promise<string> {
  const base = process.env.MCA_CALLBACK_BASE_URL;
  const token = process.env.MCA_CALLBACK_TOKEN;
  const filename = `computer-${Date.now()}.jpg`;
  if (base && token) {
    const res = await fetch(`${base}/api/media/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ data: shot.data.toString('base64'), mimeType: shot.mime, filename }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await res.json().catch(() => null)) as { success?: boolean; url?: string } | null;
    if (!res.ok || !body?.url) {
      throw new ComputerError('screenshot_failed', `media upload failed (HTTP ${res.status})`);
    }
    return body.url;
  }
  await mkdir('/workspace/.computer', { recursive: true });
  const path = `/workspace/.computer/${filename}`;
  await writeFile(path, shot.data);
  return path;
}
