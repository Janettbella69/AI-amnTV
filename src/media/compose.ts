import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import type { AppConfig } from '../config.js';
import type { Cut, Dialogue, Script } from '../domain.js';
import { probeMedia, runBinary } from './ffmpeg.js';

function quoteConcat(file: string): string {
  return `file '${path.resolve(file).replaceAll("'", "'\\''")}'`;
}

function atempoChain(ratio: number): string {
  const stages: number[] = [];
  let remainder = ratio;
  while (remainder > 2) {
    stages.push(2);
    remainder /= 2;
  }
  while (remainder < 0.5) {
    stages.push(0.5);
    remainder /= 0.5;
  }
  stages.push(remainder);
  return stages.map((value) => `atempo=${value.toFixed(6)}`).join(',');
}

async function concatAudio(
  config: AppConfig,
  audioFiles: string[],
  output: string,
): Promise<void> {
  const list = `${output}.concat.txt`;
  fs.writeFileSync(list, audioFiles.map(quoteConcat).join('\n'), 'utf8');
  try {
    await runBinary(config.ffmpeg, [
      '-y',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      list,
      '-c:a',
      'aac',
      '-b:a',
      '160k',
      output,
    ]);
  } finally {
    fs.rmSync(list, { force: true });
  }
}

export async function composeCut(
  config: AppConfig,
  clip: string,
  audioFiles: string[],
  durationSec: number,
  output: string,
): Promise<void> {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  if (audioFiles.length === 0) {
    await runBinary(config.ffmpeg, [
      '-y',
      '-i',
      clip,
      '-f',
      'lavfi',
      '-i',
      'anullsrc=r=44100:cl=stereo',
      '-t',
      durationSec.toFixed(3),
      '-map',
      '0:v:0',
      '-map',
      '1:a:0',
      '-vf',
      'scale=540:960:force_original_aspect_ratio=increase,crop=540:960,format=yuv420p',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '22',
      '-c:a',
      'aac',
      '-shortest',
      output,
    ]);
    return;
  }

  const joined = `${output}.joined.m4a`;
  await concatAudio(config, audioFiles, joined);
  const audioDuration = (await probeMedia(config, joined)).durationSec;
  const audioFilter =
    audioDuration > durationSec + 0.05
      ? atempoChain(audioDuration / durationSec)
      : `apad=whole_dur=${durationSec.toFixed(3)}`;
  try {
    await runBinary(config.ffmpeg, [
      '-y',
      '-i',
      clip,
      '-i',
      joined,
      '-t',
      durationSec.toFixed(3),
      '-filter_complex',
      `[0:v]scale=540:960:force_original_aspect_ratio=increase,crop=540:960,format=yuv420p[v];[1:a]${audioFilter}[a]`,
      '-map',
      '[v]',
      '-map',
      '[a]',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '22',
      '-c:a',
      'aac',
      '-shortest',
      output,
    ]);
  } finally {
    fs.rmSync(joined, { force: true });
  }
}

export async function concatCuts(
  config: AppConfig,
  cutFiles: string[],
  output: string,
): Promise<void> {
  if (!cutFiles.length) throw new Error('没有可合成的卡');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const list = `${output}.concat.txt`;
  fs.writeFileSync(list, cutFiles.map(quoteConcat).join('\n'), 'utf8');
  try {
    await runBinary(config.ffmpeg, [
      '-y',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      list,
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '22',
      '-c:a',
      'aac',
      '-ar',
      '44100',
      output,
    ]);
  } finally {
    fs.rmSync(list, { force: true });
  }
}

function timestamp(seconds: number): string {
  const safe = Math.max(0, seconds);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const whole = Math.floor(safe % 60);
  const milliseconds = Math.round((safe - Math.floor(safe)) * 1000);
  const two = (value: number) => String(value).padStart(2, '0');
  return `${two(hours)}:${two(minutes)}:${two(whole)},${String(milliseconds).padStart(3, '0')}`;
}

function dialogueById(script: Script): Map<string, Dialogue> {
  return new Map(
    script.scenes.flatMap((scene) =>
      scene.dialogue.map((line) => [line.id, line] as const),
    ),
  );
}

export function writeSrt(
  cuts: Cut[],
  script: Script,
  output: string,
): string {
  const lookup = dialogueById(script);
  const entries: string[] = [];
  let timeline = 0;
  let index = 1;
  for (const cut of cuts) {
    const lines = cut.dialogueIds
      .map((id) => lookup.get(id))
      .filter(
        (line): line is Dialogue =>
          Boolean(line && ['dialogue', 'narration'].includes(line.kind)),
      );
    if (lines.length) {
      const weights = lines.map((line) => line.audio?.durationSec ?? 1);
      const totalWeight = weights.reduce((sum, value) => sum + value, 0);
      let cursor = timeline;
      lines.forEach((line, lineIndex) => {
        const isLast = lineIndex === lines.length - 1;
        const share = isLast
          ? timeline + cut.durationSec - cursor
          : (cut.durationSec * (weights[lineIndex] ?? 1)) / totalWeight;
        const end = Math.max(cursor + 0.25, cursor + share - 0.04);
        const speaker = line.kind === 'narration' ? '旁白：' : '';
        entries.push(
          `${index++}\n${timestamp(cursor)} --> ${timestamp(end)}\n${speaker}${line.text}\n`,
        );
        cursor += share;
      });
    }
    timeline += cut.durationSec;
  }
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${entries.join('\n')}\n`, 'utf8');
  return output;
}

interface SubtitleCue {
  startSec: number;
  endSec: number;
  text: string;
}

function parseSrtTimestamp(value: string): number {
  const match = value.trim().match(/^(\d+):(\d{2}):(\d{2}),(\d{3})$/);
  if (!match) throw new Error(`无法解析 SRT 时间码: ${value}`);
  return (
    Number(match[1]) * 3600 +
    Number(match[2]) * 60 +
    Number(match[3]) +
    Number(match[4]) / 1000
  );
}

function parseSrt(file: string): SubtitleCue[] {
  return fs
    .readFileSync(file, 'utf8')
    .trim()
    .split(/\r?\n\r?\n/)
    .filter(Boolean)
    .map((block) => {
      const lines = block.split(/\r?\n/);
      const timing = lines[1]?.match(/^(.+?)\s+-->\s+(.+)$/);
      if (!timing) throw new Error(`无法解析 SRT 区块: ${block}`);
      return {
        startSec: parseSrtTimestamp(timing[1]!),
        endSec: parseSrtTimestamp(timing[2]!),
        text: lines.slice(2).join(' ').trim(),
      };
    });
}

function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

async function renderSubtitlePng(text: string, output: string): Promise<void> {
  const svg = `<svg width="980" height="128" xmlns="http://www.w3.org/2000/svg">
  <rect x="10" y="8" width="960" height="108" rx="20" fill="black" fill-opacity=".58"/>
  <text x="490" y="78" text-anchor="middle" fill="white" font-size="48" font-weight="650"
    font-family="PingFang SC, Noto Sans CJK SC, Microsoft YaHei, sans-serif"
    stroke="black" stroke-opacity=".65" stroke-width="2" paint-order="stroke">${xml(text)}</text>
</svg>`;
  await sharp(Buffer.from(svg)).png().toFile(output);
}

async function renderAigcLabel(output: string): Promise<void> {
  const svg = `<svg width="260" height="64" xmlns="http://www.w3.org/2000/svg">
  <rect width="260" height="64" rx="14" fill="black" fill-opacity=".45"/>
  <text x="130" y="42" text-anchor="middle" fill="white" fill-opacity=".82" font-size="26"
    font-family="PingFang SC, Noto Sans CJK SC, Microsoft YaHei, sans-serif">AIGC 生成内容</text>
</svg>`;
  await sharp(Buffer.from(svg)).png().toFile(output);
}

export async function burnDelivery(
  config: AppConfig,
  input: string,
  subtitles: string,
  output: string,
  fps: number,
): Promise<void> {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const overlayDir = `${output}.overlays`;
  fs.mkdirSync(overlayDir, { recursive: true });
  try {
    const cues = parseSrt(subtitles);
    const cueFiles: string[] = [];
    for (const [index, cue] of cues.entries()) {
      const file = path.join(overlayDir, `subtitle-${String(index + 1).padStart(3, '0')}.png`);
      await renderSubtitlePng(cue.text, file);
      cueFiles.push(file);
    }
    const aigcFile = path.join(overlayDir, 'aigc.png');
    await renderAigcLabel(aigcFile);
    const durationSec = (await probeMedia(config, input)).durationSec;
    const inputArgs = [...cueFiles, aigcFile].flatMap((file) => [
      '-loop',
      '1',
      '-i',
      file,
    ]);
    const filters = [
      '[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,format=yuv420p[v0]',
    ];
    let previous = 'v0';
    cues.forEach((cue, index) => {
      const next = `v${index + 1}`;
      filters.push(
        `[${previous}][${index + 1}:v]overlay=x=(W-w)/2:y=H-h-105:enable='between(t,${cue.startSec.toFixed(3)},${cue.endSec.toFixed(3)})':eof_action=pass[${next}]`,
      );
      previous = next;
    });
    const aigcInput = cueFiles.length + 1;
    filters.push(
      `[${previous}][${aigcInput}:v]overlay=x=W-w-36:y=36:eof_action=pass,format=yuv420p[outv]`,
    );
    await runBinary(config.ffmpeg, [
      '-y',
      '-i',
      input,
      ...inputArgs,
      '-filter_complex',
      filters.join(';'),
      '-map',
      '[outv]',
      '-map',
      '0:a?',
      '-t',
      durationSec.toFixed(3),
      '-r',
      String(fps),
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '21',
      '-c:a',
      'aac',
      '-b:a',
      '160k',
      '-movflags',
      '+faststart',
      output,
    ]);
  } finally {
    fs.rmSync(overlayDir, { recursive: true, force: true });
  }
}
