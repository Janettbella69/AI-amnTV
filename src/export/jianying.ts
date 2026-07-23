import fs from 'node:fs';
import path from 'node:path';
import type { Cut, Script } from '../domain.js';

const micros = (seconds: number) => Math.round(seconds * 1_000_000);

function stableId(prefix: string, index: number): string {
  return `${prefix}-${String(index + 1).padStart(4, '0')}`;
}

/**
 * Export a best-effort Jianying/CapCut desktop draft bundle.
 *
 * The desktop draft schema changes between releases, so the bundle also includes
 * timeline.json as a stable, lossless interchange manifest. README explicitly
 * labels the native draft JSON as unverified until tested against a target build.
 */
export function exportJianyingDraft(
  outputDir: string,
  cuts: Cut[],
  script: Script,
  compositedCutFiles: string[],
  subtitleFile: string,
): string {
  fs.mkdirSync(outputDir, { recursive: true });
  let cursor = 0;
  const videos = compositedCutFiles.map((file, index) => ({
    id: stableId('video', index),
    path: path.resolve(file),
    type: 'video',
    duration: micros(cuts[index]?.durationSec ?? 0),
  }));
  const segments = cuts.map((cut, index) => {
    const start = cursor;
    cursor += cut.durationSec;
    return {
      id: stableId('segment', index),
      material_id: videos[index]!.id,
      source_timerange: { start: 0, duration: micros(cut.durationSec) },
      target_timerange: { start: micros(start), duration: micros(cut.durationSec) },
      speed: 1,
      volume: 1,
      clip: { alpha: 1, flip: { horizontal: false, vertical: false } },
    };
  });
  const content = {
    id: `ai-amntv-${script.episodeId}`,
    name: script.title,
    duration: micros(cursor),
    fps: 24,
    canvas_config: { width: 1080, height: 1920, ratio: '9:16' },
    materials: { videos, audios: [], texts: [] },
    tracks: [{ id: 'video-track-1', type: 'video', segments }],
  };
  const timeline = {
    format: 'ai-amntv-timeline/v1',
    episodeId: script.episodeId,
    title: script.title,
    durationSec: cursor,
    subtitleFile: path.resolve(subtitleFile),
    cuts: cuts.map((cut, index) => ({
      cutId: cut.id,
      startSec: cuts
        .slice(0, index)
        .reduce((sum, previous) => sum + previous.durationSec, 0),
      durationSec: cut.durationSec,
      videoFile: path.resolve(compositedCutFiles[index]!),
      dialogueIds: cut.dialogueIds,
    })),
  };
  fs.writeFileSync(
    path.join(outputDir, 'draft_content.json'),
    JSON.stringify(content, null, 2),
  );
  fs.writeFileSync(
    path.join(outputDir, 'draft_meta_info.json'),
    JSON.stringify(
      {
        draft_name: script.title,
        tm_draft_create: Math.floor(Date.now() / 1000),
        tm_draft_modified: Math.floor(Date.now() / 1000),
        draft_fold_path: path.resolve(outputDir),
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(path.join(outputDir, 'timeline.json'), JSON.stringify(timeline, null, 2));
  fs.writeFileSync(
    path.join(outputDir, 'README.txt'),
    [
      'AI-amnTV 剪映草稿导出',
      '',
      'draft_content.json / draft_meta_info.json 为实验性桌面草稿结构，需在目标剪映版本实测。',
      'timeline.json 是稳定的无损时间线清单；即使剪映升级，也可据此重建草稿。',
      '所有媒体使用绝对路径，移动项目目录后需要重新导出。',
    ].join('\n'),
  );
  return outputDir;
}
