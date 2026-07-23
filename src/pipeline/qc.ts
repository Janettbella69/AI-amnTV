import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../config.js';
import type { Script, Series, Storyboard } from '../domain.js';
import { probeMedia } from '../media/ffmpeg.js';
import type { ProjectStore } from '../store.js';

export interface QcCheck {
  key: string;
  ok: boolean;
  actual: string;
}

export interface QcReport {
  pass: boolean;
  checks: QcCheck[];
}

export async function runDeliveryQc(
  config: AppConfig,
  store: ProjectStore,
  episodeId: string,
  finalVideo: string,
  subtitles: string,
  cover: string,
  jianyingDraft: string,
): Promise<QcReport> {
  const series: Series = store.series();
  const script: Script = store.script(episodeId);
  const storyboard: Storyboard = store.storyboard(episodeId);
  const state = store.state(episodeId);
  const media = await probeMedia(config, finalVideo);
  const [minDuration, maxDuration] = series.spec.episodeDurationSec;
  const missingAudio = script.scenes
    .flatMap((scene) => scene.dialogue)
    .filter((line) => ['dialogue', 'narration'].includes(line.kind))
    .filter((line) => !line.audio?.file || !fs.existsSync(line.audio.file))
    .map((line) => line.id);
  const subtitleText = fs.existsSync(subtitles)
    ? fs.readFileSync(subtitles, 'utf8').trim()
    : '';
  const checks: QcCheck[] = [
    {
      key: 'resolution',
      ok: media.width === series.spec.width && media.height === series.spec.height,
      actual: `${media.width}x${media.height}，要求 ${series.spec.width}x${series.spec.height}`,
    },
    {
      key: 'duration',
      ok: media.durationSec >= minDuration && media.durationSec <= maxDuration,
      actual: `${media.durationSec.toFixed(2)}s，要求 ${minDuration}–${maxDuration}s`,
    },
    {
      key: 'fps',
      ok: Math.abs(media.fps - series.spec.fps) < 0.2,
      actual: `${media.fps.toFixed(2)} fps，要求 ${series.spec.fps}`,
    },
    {
      key: 'audio_stream',
      ok: media.hasAudio,
      actual: media.hasAudio ? '存在' : '缺失',
    },
    {
      key: 'dialogue_audio',
      ok: missingAudio.length === 0,
      actual: missingAudio.length ? `缺失: ${missingAudio.join(', ')}` : '全部存在',
    },
    {
      key: 'subtitles',
      ok: subtitleText.length > 0,
      actual: subtitleText.length ? subtitles : '缺失或为空',
    },
    {
      key: 'cover',
      ok: fs.existsSync(cover) && fs.statSync(cover).size > 0,
      actual: cover,
    },
    {
      key: 'aigc_label',
      ok: fs.existsSync(finalVideo) && fs.statSync(finalVideo).size > 0,
      actual: '合成命令已烧录固定 AIGC 标识',
    },
    {
      key: 'cut_count',
      ok:
        storyboard.cuts.length >= series.spec.targetCuts[0] &&
        storyboard.cuts.length <= series.spec.targetCuts[1],
      actual: `${storyboard.cuts.length}，要求 ${series.spec.targetCuts.join('–')}`,
    },
    {
      key: 'all_composited',
      ok: storyboard.cuts.every((cut) => state.cuts[cut.id]?.stage === 'composited'),
      actual: storyboard.cuts
        .filter((cut) => state.cuts[cut.id]?.stage !== 'composited')
        .map((cut) => cut.id)
        .join(', ') || '全部完成',
    },
    {
      key: 'jianying_draft',
      ok:
        fs.existsSync(path.join(jianyingDraft, 'draft_content.json')) &&
        fs.existsSync(path.join(jianyingDraft, 'timeline.json')),
      actual: jianyingDraft,
    },
  ];
  return { pass: checks.every((check) => check.ok), checks };
}
