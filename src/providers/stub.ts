import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../config.js';
import { runBinary } from '../media/ffmpeg.js';
import type {
  GenerationResult,
  ImageProvider,
  ImageRequest,
  TtsProvider,
  TtsRequest,
  VideoProvider,
  VideoRequest,
} from './types.js';

function hashNumber(value: string): number {
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function color(value: string): string {
  return (hashNumber(value) & 0xffffff).toString(16).padStart(6, '0');
}

export class StubImageProvider implements ImageProvider {
  readonly name = 'stub-image';
  readonly model = 'ffmpeg-color-card';
  readonly promptLimit = 20_000;

  constructor(private readonly config: AppConfig) {}

  status() {
    return { ready: true, message: 'dry-run 本地占位图' };
  }

  async generate(request: ImageRequest): Promise<GenerationResult> {
    fs.mkdirSync(path.dirname(request.outputFile), { recursive: true });
    const base = color(`${request.prompt}:${request.seed}`);
    const accent = color(`${request.seed}:${request.prompt}:accent`);
    await runBinary(this.config.ffmpeg, [
      '-y',
      '-f',
      'lavfi',
      '-i',
      `color=c=0x${base}:s=${request.width}x${request.height}`,
      '-vf',
      `drawbox=x=iw*0.08:y=ih*0.08:w=iw*0.84:h=ih*0.84:color=0x${accent}@0.35:t=fill,drawbox=x=iw*0.12:y=ih*0.66:w=iw*0.76:h=ih*0.18:color=black@0.22:t=fill`,
      '-frames:v',
      '1',
      request.outputFile,
    ]);
    return {
      file: request.outputFile,
      provider: this.name,
      model: this.model,
      amountCny: 0,
      metadata: { dryRun: true, seed: request.seed },
    };
  }
}

export class StubVideoProvider implements VideoProvider {
  readonly name = 'stub-video';
  readonly model = 'ffmpeg-still-pan';
  readonly promptLimit = 20_000;

  constructor(private readonly config: AppConfig) {}

  status() {
    return { ready: true, message: 'dry-run 本地静帧运镜' };
  }

  supports() {
    return true;
  }

  async generate(request: VideoRequest): Promise<GenerationResult> {
    const first = request.frames[0];
    if (!first) throw new Error('stub video 需要至少一张参考帧');
    fs.mkdirSync(path.dirname(request.outputFile), { recursive: true });
    request.onSubmitted?.(`stub-${Date.now()}`);
    const frames = Math.max(1, Math.round(request.durationSec * 24));
    const direction = request.mode === 'first_last' ? 'zoomout' : 'zoomin';
    const zoom =
      direction === 'zoomin'
        ? "min(zoom+0.0008,1.08)"
        : "if(eq(on,1),1.08,max(1.0,zoom-0.0008))";
    await runBinary(this.config.ffmpeg, [
      '-y',
      '-loop',
      '1',
      '-i',
      first,
      '-vf',
      `scale=600:1067:force_original_aspect_ratio=increase,crop=540:960,zoompan=z='${zoom}':d=${frames}:s=540x960:fps=24,format=yuv420p`,
      '-frames:v',
      String(frames),
      '-an',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '23',
      request.outputFile,
    ]);
    return {
      file: request.outputFile,
      provider: this.name,
      model: this.model,
      amountCny: 0,
      metadata: { dryRun: true, requestedMode: request.mode },
    };
  }
}

export class StubTtsProvider implements TtsProvider {
  readonly name = 'stub-tts';
  readonly model = 'ffmpeg-tone';

  constructor(private readonly config: AppConfig) {}

  status() {
    return { ready: true, message: 'dry-run 可听提示音，非真实语音' };
  }

  async synthesize(request: TtsRequest): Promise<GenerationResult> {
    fs.mkdirSync(path.dirname(request.outputFile), { recursive: true });
    const visible = request.text.replace(/\s|\p{P}/gu, '').length;
    const duration = Math.max(0.8, visible / 4);
    const frequency = 180 + (hashNumber(request.voiceId) % 220);
    await runBinary(this.config.ffmpeg, [
      '-y',
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=${frequency}:sample_rate=44100:duration=${duration.toFixed(3)}`,
      '-af',
      'volume=0.08',
      '-c:a',
      'libmp3lame',
      '-q:a',
      '5',
      request.outputFile,
    ]);
    return {
      file: request.outputFile,
      provider: this.name,
      model: this.model,
      amountCny: 0,
      metadata: { dryRun: true, durationSec: duration, frequency },
    };
  }
}
