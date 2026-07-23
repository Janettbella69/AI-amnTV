import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../config.js';

const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024;
const RESULT_HOST = 'libtv-res.liblib.art';

export interface LibTvRemoteMessage {
  id?: string;
  seq?: number;
  role?: string;
  content?: unknown;
  [key: string]: unknown;
}

export interface LibTvCreatedSession {
  projectUuid: string;
  sessionId: string;
}

export interface InspectedMedia {
  bytes: number;
  mimeType: string;
  extension: string;
}

type Fetcher = typeof fetch;

function mediaSignature(file: string): InspectedMedia {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error('参考素材必须是普通文件');
  if (stat.size <= 0) throw new Error('参考素材为空');
  if (stat.size > MAX_UPLOAD_BYTES) {
    throw new Error('参考素材超过 200MB，不能上传到 LibTV');
  }
  const descriptor = fs.openSync(file, 'r');
  const header = Buffer.alloc(Math.min(16, stat.size));
  try {
    fs.readSync(descriptor, header, 0, header.length, 0);
  } finally {
    fs.closeSync(descriptor);
  }
  const ascii = header.toString('ascii');
  if (
    header.length >= 8 &&
    header.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    )
  ) {
    return { bytes: stat.size, mimeType: 'image/png', extension: '.png' };
  }
  if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8) {
    return { bytes: stat.size, mimeType: 'image/jpeg', extension: '.jpg' };
  }
  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') {
    return { bytes: stat.size, mimeType: 'image/webp', extension: '.webp' };
  }
  if (ascii.slice(4, 8) === 'ftyp') {
    return { bytes: stat.size, mimeType: 'video/mp4', extension: '.mp4' };
  }
  if (
    header.length >= 4 &&
    header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
  ) {
    return { bytes: stat.size, mimeType: 'video/webm', extension: '.webm' };
  }
  throw new Error(
    `无法确认参考素材类型：${path.basename(file)}；仅支持 PNG、JPEG、WebP、MP4、WebM`,
  );
}

export function inspectLibTvUpload(file: string): InspectedMedia {
  return mediaSignature(file);
}

export function assertLibTvResultUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== RESULT_HOST ||
    url.username ||
    url.password ||
    url.port
  ) {
    throw new Error(`拒绝非 LibTV 结果地址：${url.origin}`);
  }
  return url;
}

async function responseJson(
  response: Response,
  operation: string,
): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${operation} HTTP ${response.status}: ${text.slice(0, 1_000)}`);
  }
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${operation} 返回格式错误`);
  }
  return parsed as Record<string, unknown>;
}

function responseData(
  value: Record<string, unknown>,
  operation: string,
): Record<string, unknown> {
  const data = value.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`${operation} 未返回 data`);
  }
  return data as Record<string, unknown>;
}

export class LibTvClient {
  constructor(
    private readonly config: AppConfig,
    private readonly fetcher: Fetcher = fetch,
  ) {}

  status(): { ready: boolean; message: string } {
    return this.config.libtvAccessKey
      ? { ready: true, message: 'LibTV OpenAPI 已配置' }
      : { ready: false, message: '缺少 LIBTV_ACCESS_KEY' };
  }

  private key(): string {
    if (!this.config.libtvAccessKey) {
      throw new Error('LibTV 未配置：缺少 LIBTV_ACCESS_KEY');
    }
    return this.config.libtvAccessKey;
  }

  private endpoint(apiPath: string): string {
    const base = new URL(this.config.libtvApiBase);
    if (
      base.protocol !== 'https:' ||
      base.hostname !== 'im.liblib.tv' ||
      base.username ||
      base.password ||
      base.port
    ) {
      throw new Error('LibTV API 地址未通过安全校验');
    }
    return new URL(apiPath, `${base.origin}/`).toString();
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.key()}`,
      'Content-Type': 'application/json',
    };
  }

  async createSession(
    message: string,
    sessionId?: string,
  ): Promise<LibTvCreatedSession> {
    const body = {
      ...(sessionId ? { sessionId } : {}),
      ...(message ? { message } : {}),
    };
    const response = await this.fetcher(this.endpoint('/openapi/session'), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const data = responseData(
      await responseJson(response, 'LibTV 创建会话'),
      'LibTV 创建会话',
    );
    const projectUuid = data.projectUuid;
    const createdSessionId = data.sessionId;
    if (typeof projectUuid !== 'string' || typeof createdSessionId !== 'string') {
      throw new Error('LibTV 创建会话未返回 projectUuid/sessionId');
    }
    return { projectUuid, sessionId: createdSessionId };
  }

  async querySession(
    sessionId: string,
    afterSeq = 0,
  ): Promise<LibTvRemoteMessage[]> {
    const target = new URL(
      this.endpoint(`/openapi/session/${encodeURIComponent(sessionId)}`),
    );
    if (afterSeq > 0) target.searchParams.set('afterSeq', String(afterSeq));
    const response = await this.fetcher(target, {
      headers: this.headers(),
      signal: AbortSignal.timeout(30_000),
    });
    const data = responseData(
      await responseJson(response, 'LibTV 查询会话'),
      'LibTV 查询会话',
    );
    return Array.isArray(data.messages)
      ? (data.messages as LibTvRemoteMessage[])
      : [];
  }

  async uploadFile(file: string): Promise<string> {
    const inspected = mediaSignature(file);
    const bytes = new Uint8Array(fs.readFileSync(file));
    const tryUpload = async (apiPath: string): Promise<Response> => {
      const form = new FormData();
      form.set(
        'file',
        new Blob([bytes], { type: inspected.mimeType }),
        path.basename(file),
      );
      return this.fetcher(this.endpoint(apiPath), {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.key()}` },
        body: form,
        signal: AbortSignal.timeout(120_000),
      });
    };
    let response = await tryUpload('/openapi/upload');
    if (response.status === 404) {
      response = await tryUpload('/openapi/file/upload');
    }
    const data = responseData(
      await responseJson(response, 'LibTV 上传素材'),
      'LibTV 上传素材',
    );
    if (typeof data.url !== 'string') {
      throw new Error('LibTV 上传素材未返回 URL');
    }
    assertLibTvResultUrl(data.url);
    return data.url;
  }

  async downloadResult(
    value: string,
  ): Promise<{ bytes: Buffer; mimeType: string; extension: string }> {
    const url = assertLibTvResultUrl(value);
    const response = await this.fetcher(url, {
      headers: { 'User-Agent': 'AI-amnTV/0.1' },
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) {
      throw new Error(`LibTV 结果下载 HTTP ${response.status}`);
    }
    const contentLength = Number(response.headers.get('content-length') ?? 0);
    if (contentLength > MAX_DOWNLOAD_BYTES) {
      throw new Error('LibTV 结果超过 500MB，拒绝下载');
    }
    const mimeType = (response.headers.get('content-type') ?? '')
      .split(';')[0]!
      .trim()
      .toLowerCase();
    if (!mimeType.startsWith('image/') && !mimeType.startsWith('video/')) {
      throw new Error(`LibTV 结果类型不受支持：${mimeType || '未知'}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_DOWNLOAD_BYTES) {
      throw new Error('LibTV 结果超过 500MB，拒绝写入');
    }
    const extension =
      mimeType === 'image/png'
        ? '.png'
        : mimeType === 'image/jpeg'
          ? '.jpg'
          : mimeType === 'image/webp'
            ? '.webp'
            : mimeType === 'video/webm'
              ? '.webm'
              : '.mp4';
    return { bytes, mimeType, extension };
  }
}
