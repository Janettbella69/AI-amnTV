import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../config.js';
import { StubVideoProvider } from './stub.js';
import type {
  GenerationResult,
  TtsProvider,
  TtsRequest,
  VideoProvider,
  VideoRequest,
} from './types.js';

interface MiniMaxBaseResponse {
  base_resp?: { status_code?: number; status_msg?: string };
}

async function checkedJson<T extends MiniMaxBaseResponse>(
  response: Response,
  operation: string,
): Promise<T> {
  const text = await response.text();
  if (!response.ok) throw new Error(`${operation} HTTP ${response.status}: ${text}`);
  const value = JSON.parse(text) as T;
  if (value.base_resp?.status_code && value.base_resp.status_code !== 0) {
    throw new Error(`${operation}: ${value.base_resp.status_msg ?? value.base_resp.status_code}`);
  }
  return value;
}

export class MiniMaxTtsProvider implements TtsProvider {
  readonly name = 'minimax-tts';
  readonly model: string;

  constructor(private readonly config: AppConfig) {
    this.model = config.minimaxTtsModel;
  }

  status() {
    return this.config.minimaxApiKey
      ? { ready: true, message: `MiniMax ${this.model}` }
      : { ready: false, message: '缺少 MINIMAX_API_KEY' };
  }

  async synthesize(request: TtsRequest): Promise<GenerationResult> {
    const key = this.config.minimaxApiKey;
    if (!key) throw new Error('MiniMax TTS 未配置：缺少 MINIMAX_API_KEY');
    const response = await fetch(`${this.config.minimaxApiBase}/v1/t2a_v2`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        text: request.text,
        stream: false,
        voice_setting: {
          voice_id: request.voiceId,
          speed: 1,
          vol: 1,
          pitch: 0,
          ...(request.emotion ? { emotion: request.emotion } : {}),
          ...request.params,
        },
        audio_setting: {
          sample_rate: 32000,
          bitrate: 128000,
          format: 'mp3',
          channel: 1,
        },
        subtitle_enable: false,
      }),
    });
    const value = await checkedJson<
      MiniMaxBaseResponse & {
        data?: { audio?: string; status?: number };
        trace_id?: string;
        extra_info?: { audio_length?: number; usage_characters?: number };
      }
    >(response, 'MiniMax TTS');
    if (!value.data?.audio) throw new Error('MiniMax TTS 返回中没有 audio');
    fs.mkdirSync(path.dirname(request.outputFile), { recursive: true });
    fs.writeFileSync(request.outputFile, Buffer.from(value.data.audio, 'hex'));
    return {
      file: request.outputFile,
      provider: this.name,
      model: this.model,
      metadata: {
        traceId: value.trace_id,
        audioLengthMs: value.extra_info?.audio_length,
        usageCharacters: value.extra_info?.usage_characters,
      },
    };
  }
}

function readFrameUrls(file: string | undefined): Record<string, string> {
  if (!file || !fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string>;
}

function frameUrl(manifest: Record<string, string>, file: string): string | undefined {
  return manifest[file] ?? manifest[path.resolve(file)] ?? manifest[path.basename(file)];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class MiniMaxVideoProvider implements VideoProvider {
  readonly name = 'minimax-video';
  readonly model: string;
  readonly promptLimit = 2_000;

  constructor(private readonly config: AppConfig) {
    this.model = config.minimaxVideoModel;
  }

  status() {
    if (!this.config.minimaxApiKey) {
      return { ready: false, message: '缺少 MINIMAX_API_KEY' };
    }
    if (!this.config.frameUrlManifest || !fs.existsSync(this.config.frameUrlManifest)) {
      return {
        ready: false,
        message: '缺少 AMNTV_FRAME_URL_MANIFEST；云视频接口需要可公开读取的 HTTPS 参考帧 URL',
      };
    }
    return { ready: true, message: `MiniMax ${this.model}` };
  }

  supports() {
    return true;
  }

  async generate(request: VideoRequest): Promise<GenerationResult> {
    if (request.mode === 'still_pan') {
      return new StubVideoProvider(this.config).generate(request);
    }
    const status = this.status();
    if (!status.ready) throw new Error(status.message);
    const key = this.config.minimaxApiKey!;
    const manifest = readFrameUrls(this.config.frameUrlManifest);
    const first = request.frames[0] ? frameUrl(manifest, request.frames[0]) : undefined;
    const last = request.frames[1] ? frameUrl(manifest, request.frames[1]) : undefined;
    if (!first) throw new Error(`参考帧没有公开 URL 映射: ${request.frames[0] ?? '缺失'}`);
    const duration = request.durationSec <= 6 ? 6 : 10;
    const payload: Record<string, unknown> = {
      prompt: request.prompt.slice(0, this.promptLimit),
      first_frame_image: first,
      model: this.model,
      duration,
      resolution: '1080P',
    };
    if (
      (request.mode === 'first_last' || request.mode === 'multi_frame') &&
      last
    ) {
      payload.last_frame_image = last;
    }

    const created = await checkedJson<
      MiniMaxBaseResponse & { task_id?: string }
    >(
      await fetch(`${this.config.minimaxApiBase}/v1/video_generation`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      }),
      'MiniMax 视频任务创建',
    );
    if (!created.task_id) throw new Error('MiniMax 视频任务未返回 task_id');
    request.onSubmitted?.(created.task_id);

    const startedAt = Date.now();
    let fileId: string | undefined;
    while (Date.now() - startedAt < 30 * 60_000) {
      await delay(10_000);
      const queryUrl = new URL(`${this.config.minimaxApiBase}/v1/query/video_generation`);
      queryUrl.searchParams.set('task_id', created.task_id);
      const state = await checkedJson<
        MiniMaxBaseResponse & {
          status?: 'Preparing' | 'Queueing' | 'Processing' | 'Success' | 'Fail';
          file_id?: string;
          error_message?: string;
        }
      >(
        await fetch(queryUrl, {
          headers: { Authorization: `Bearer ${key}` },
        }),
        'MiniMax 视频任务查询',
      );
      if (state.status === 'Fail') {
        throw new Error(`MiniMax 视频生成失败: ${state.error_message ?? '未知原因'}`);
      }
      if (state.status === 'Success') {
        fileId = state.file_id;
        break;
      }
    }
    if (!fileId) throw new Error('MiniMax 视频任务轮询超时（30 分钟）');

    const retrieveUrl = new URL(`${this.config.minimaxApiBase}/v1/files/retrieve`);
    retrieveUrl.searchParams.set('file_id', fileId);
    const file = await checkedJson<
      MiniMaxBaseResponse & {
        file?: { download_url?: string; filename?: string; bytes?: number };
      }
    >(
      await fetch(retrieveUrl, {
        headers: { Authorization: `Bearer ${key}` },
      }),
      'MiniMax 视频文件检索',
    );
    if (!file.file?.download_url) throw new Error('MiniMax 文件检索未返回 download_url');
    const download = await fetch(file.file.download_url);
    if (!download.ok) throw new Error(`MiniMax 视频下载 HTTP ${download.status}`);
    fs.mkdirSync(path.dirname(request.outputFile), { recursive: true });
    fs.writeFileSync(request.outputFile, Buffer.from(await download.arrayBuffer()));
    return {
      file: request.outputFile,
      provider: this.name,
      model: this.model,
      metadata: {
        taskId: created.task_id,
        fileId,
        sourceDurationSec: duration,
        ...(request.mode === 'multi_frame'
          ? { modeDegradedTo: 'first_last', reason: '当前 MiniMax 适配器只消费首尾帧' }
          : {}),
        bytes: file.file.bytes,
      },
    };
  }
}
