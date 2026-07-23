import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { AppConfig } from '../config.js';

const exec = promisify(execFile);

export async function runBinary(
  binary: string,
  args: string[],
  maxBuffer = 16 * 1024 * 1024,
): Promise<{ stdout: string; stderr: string }> {
  const result = await exec(binary, args, { maxBuffer });
  return { stdout: result.stdout, stderr: result.stderr };
}

export async function assertMediaTools(config: AppConfig): Promise<void> {
  await runBinary(config.ffmpeg, ['-version']);
  await runBinary(config.ffprobe, ['-version']);
}

export interface MediaProbe {
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
}

export async function probeMedia(config: AppConfig, file: string): Promise<MediaProbe> {
  const { stdout } = await runBinary(config.ffprobe, [
    '-v',
    'error',
    '-show_entries',
    'stream=codec_type,width,height,r_frame_rate',
    '-show_entries',
    'format=duration',
    '-of',
    'json',
    file,
  ]);
  const value = JSON.parse(stdout) as {
    streams?: Array<{
      codec_type?: string;
      width?: number;
      height?: number;
      r_frame_rate?: string;
    }>;
    format?: { duration?: string };
  };
  const video = value.streams?.find((stream) => stream.codec_type === 'video');
  const ratio = video?.r_frame_rate?.split('/').map(Number) ?? [0, 1];
  return {
    durationSec: Number(value.format?.duration ?? 0),
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    fps: (ratio[0] ?? 0) / Math.max(1, ratio[1] ?? 1),
    hasAudio: Boolean(value.streams?.some((stream) => stream.codec_type === 'audio')),
  };
}

export async function extractCover(
  config: AppConfig,
  input: string,
  output: string,
): Promise<void> {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  await runBinary(config.ffmpeg, [
    '-y',
    '-ss',
    '0.2',
    '-i',
    input,
    '-frames:v',
    '1',
    '-q:v',
    '2',
    output,
  ]);
}
