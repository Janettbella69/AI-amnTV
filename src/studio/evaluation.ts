import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import YAML from 'yaml';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { probeMedia } from '../media/ffmpeg.js';
import {
  referencedAssets,
  validateAssetsLocked,
  validateScript,
  validateStoryboard,
} from '../pipeline/validation.js';
import { ProjectStore, writeYaml } from '../store.js';

export const EvaluationScopeSchema = z.enum(['story', 'dailies', 'final']);
export const EvaluationDimensionIdSchema = z.enum([
  'narrative',
  'character',
  'storyboard',
  'visual',
  'audio',
  'continuity',
  'platform',
  'delivery',
]);
const ManualRatingSchema = z.object({
  dimension: EvaluationDimensionIdSchema,
  score: z.number().min(0).max(100),
  note: z.string().trim().max(2_000).default(''),
});
export const CreateEvaluationSchema = z.object({
  scope: EvaluationScopeSchema,
  title: z.string().trim().min(1).max(120).optional(),
  manualRatings: z.array(ManualRatingSchema).max(8).default([]),
});

const EvaluationCheckSchema = z.object({
  id: z.string(),
  label: z.string(),
  status: z.enum(['pass', 'warn', 'fail']),
  score: z.number().min(0),
  maxScore: z.number().positive(),
  evidence: z.string(),
  evidenceKind: z.enum(['direct', 'proxy', 'missing']),
});
const EvaluationDimensionSchema = z.object({
  id: EvaluationDimensionIdSchema,
  label: z.string(),
  weight: z.number().positive(),
  score: z.number().min(0).max(100),
  automaticScore: z.number().min(0).max(100),
  manualScore: z.number().min(0).max(100).optional(),
  manualNote: z.string().optional(),
  source: z.enum(['automatic', 'hybrid']),
  confidence: z.number().min(0).max(1),
  summary: z.string(),
  checks: z.array(EvaluationCheckSchema),
});
const EvaluationReportSchema = z.object({
  id: z.string().uuid(),
  version: z.literal(1),
  seriesId: z.string(),
  episodeId: z.string(),
  scope: EvaluationScopeSchema,
  title: z.string(),
  inputHash: z.string(),
  overallScore: z.number().min(0).max(100),
  evidenceCoverage: z.number().min(0).max(100),
  humanCoverage: z.number().min(0).max(100),
  verdict: z.enum(['pass', 'revise', 'needs_human_review']),
  dimensions: z.array(EvaluationDimensionSchema),
  createdAt: z.string().datetime(),
});
export type EvaluationReport = z.infer<typeof EvaluationReportSchema>;
type EvaluationDimensionId = z.infer<typeof EvaluationDimensionIdSchema>;
type ManualRating = z.infer<typeof ManualRatingSchema>;
type EvaluationCheck = z.infer<typeof EvaluationCheckSchema>;

const BenchmarkCriteriaSchema = z.object({
  identity: z.number().min(0).max(100).optional(),
  composition: z.number().min(0).max(100).optional(),
  cameraLanguage: z.number().min(0).max(100).optional(),
  motion: z.number().min(0).max(100).optional(),
  artifacts: z.number().min(0).max(100).optional(),
  voicePerformance: z.number().min(0).max(100).optional(),
});
export const CreateBenchmarkSchema = z.object({
  title: z.string().trim().min(1).max(120).default('供应商产物对比'),
  ratings: z
    .array(
      z.object({
        candidateId: z.string().min(1),
        criteria: BenchmarkCriteriaSchema,
        note: z.string().trim().max(2_000).default(''),
      }),
    )
    .min(2)
    .max(12),
});
const BenchmarkCandidateSchema = z.object({
  id: z.string(),
  source: z.enum(['libtv', 'pipeline']),
  kind: z.enum(['image', 'video']),
  label: z.string(),
  file: z.string(),
  url: z.string().optional(),
  provider: z.string(),
  model: z.string().optional(),
  costCny: z.number().nonnegative().optional(),
  costKnown: z.boolean(),
});
const BenchmarkItemSchema = z.object({
  candidate: BenchmarkCandidateSchema,
  criteria: BenchmarkCriteriaSchema,
  score: z.number().min(0).max(100),
  rank: z.number().int().positive(),
  note: z.string(),
  technical: z.object({
    bytes: z.number().int().positive(),
    width: z.number().int().nonnegative(),
    height: z.number().int().nonnegative(),
    durationSec: z.number().nonnegative().optional(),
    fps: z.number().nonnegative().optional(),
    hasAudio: z.boolean().optional(),
  }),
});
const BenchmarkReportSchema = z.object({
  id: z.string().uuid(),
  version: z.literal(1),
  seriesId: z.string(),
  episodeId: z.string(),
  title: z.string(),
  rubric: z.literal('amnTV-perceptual-v1'),
  items: z.array(BenchmarkItemSchema).min(2),
  createdAt: z.string().datetime(),
});
export type BenchmarkCandidate = z.infer<typeof BenchmarkCandidateSchema>;
export type BenchmarkReport = z.infer<typeof BenchmarkReportSchema>;

const labels: Record<EvaluationDimensionId, string> = {
  narrative: '剧本与情绪',
  character: '人物与声音身份',
  storyboard: '分镜与镜头语言',
  visual: '画面与动作',
  audio: '配音与声音',
  continuity: '跨镜连续性',
  platform: '竖屏发行适配',
  delivery: '成片与交付 QC',
};

const scopes: Record<
  z.infer<typeof EvaluationScopeSchema>,
  Array<[EvaluationDimensionId, number]>
> = {
  story: [
    ['narrative', 30],
    ['character', 20],
    ['storyboard', 30],
    ['platform', 20],
  ],
  dailies: [
    ['narrative', 12],
    ['character', 14],
    ['storyboard', 18],
    ['visual', 22],
    ['audio', 17],
    ['continuity', 17],
  ],
  final: [
    ['narrative', 8],
    ['character', 9],
    ['storyboard', 13],
    ['visual', 17],
    ['audio', 14],
    ['continuity', 14],
    ['platform', 10],
    ['delivery', 15],
  ],
};

function clamp(value: number, minimum = 0, maximum = 100): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function check(
  id: string,
  label: string,
  score: number,
  maxScore: number,
  evidence: string,
  evidenceKind: EvaluationCheck['evidenceKind'] = 'direct',
): EvaluationCheck {
  const normalized = clamp(score, 0, maxScore);
  const ratio = normalized / maxScore;
  return {
    id,
    label,
    status: ratio >= 0.85 ? 'pass' : ratio >= 0.55 ? 'warn' : 'fail',
    score: normalized,
    maxScore,
    evidence,
    evidenceKind,
  };
}

function ratioScore(actual: number, total: number, maximum: number): number {
  return total > 0 ? (actual / total) * maximum : 0;
}

function requiredFrameCount(mode: string): number {
  return mode === 'first_last' || mode === 'multi_frame' ? 2 : 1;
}

function currentHash(store: ProjectStore, episodeId: string): string {
  const state = store.state(episodeId);
  return createHash('sha256')
    .update(
      JSON.stringify({
        series: store.series(),
        script: store.script(episodeId),
        storyboard: store.storyboard(episodeId),
        characters: store.characters(),
        locations: store.locations(),
        gates: state.gates,
        cuts: state.cuts,
        delivery: state.delivery,
      }),
    )
    .digest('hex');
}

function narrativeChecks(store: ProjectStore, episodeId: string): EvaluationCheck[] {
  const script = store.script(episodeId);
  const validation = validateScript(script);
  const active = script.scenes.filter((scene) => scene.status === 'active');
  const emotionBeats = active.filter((scene) => scene.emotionBeat.trim()).length;
  const concise = active
    .flatMap((scene) => scene.dialogue)
    .filter((line) => ['dialogue', 'narration'].includes(line.kind))
    .filter((line) => [...line.text.replace(/\s|\p{P}/gu, '')].length <= 15);
  const allLines = active
    .flatMap((scene) => scene.dialogue)
    .filter((line) => ['dialogue', 'narration'].includes(line.kind));
  return [
    check(
      'script_contract',
      '结构化剧本契约',
      validation.ok ? 25 : 0,
      25,
      validation.ok ? '台词 ID、场号和长度校验通过' : validation.errors.join('；'),
    ),
    check(
      'emotion_contract',
      '情绪承诺与回收',
      script.emotionContract.promise.trim() && script.emotionContract.payoff.trim()
        ? 20
        : 0,
      20,
      `${script.emotionContract.promise || '缺少承诺'} → ${script.emotionContract.payoff || '缺少回收'}`,
      'proxy',
    ),
    check(
      'scene_arc',
      '场景数量与情绪节拍',
      ratioScore(emotionBeats, Math.max(3, active.length), 20),
      20,
      `${active.length} 个有效场，${emotionBeats} 个有情绪节拍`,
      'proxy',
    ),
    check(
      'opening_event',
      '开场事件可读性',
      active[0]?.synopsis.trim() && active[0]?.emotionBeat.trim() ? 15 : 0,
      15,
      active[0]
        ? `${active[0].synopsis} / ${active[0].emotionBeat}`
        : '缺少有效开场场景',
      'proxy',
    ),
    check(
      'ending_hook',
      '结尾问题与情绪落点',
      active.at(-1)?.synopsis.trim() && active.at(-1)?.emotionBeat.trim() ? 10 : 0,
      10,
      active.at(-1)
        ? `${active.at(-1)!.synopsis} / ${active.at(-1)!.emotionBeat}`
        : '缺少有效结尾场景',
      'proxy',
    ),
    check(
      'dialogue_breath',
      '短剧台词可表演长度',
      ratioScore(concise.length, allLines.length, 10),
      10,
      `${concise.length}/${allLines.length} 句不超过 15 个可见字`,
      'proxy',
    ),
  ];
}

function characterChecks(store: ProjectStore, episodeId: string): EvaluationCheck[] {
  const script = store.script(episodeId);
  const storyboard = store.storyboard(episodeId);
  const referenced = referencedAssets(script, storyboard);
  const characters = referenced.characterIds.flatMap((id) => {
    const value = store.character(id);
    return value ? [value] : [];
  });
  const locations = referenced.locationIds.flatMap((id) => {
    const value = store.location(id);
    return value ? [value] : [];
  });
  const lockedCharacters = characters.filter((item) => item.status === 'locked');
  const lockedLocations = locations.filter((item) => item.status === 'locked');
  const uniqueVoices = new Set(characters.map((item) => item.voice.voiceId)).size;
  const uniquePersonalities = new Set(
    characters.map((item) => item.personality.trim()).filter(Boolean),
  ).size;
  const outfitReferences = characters.filter((item) =>
    Object.values(item.outfits).some(
      (outfit) => outfit.referenceImage && fs.existsSync(outfit.referenceImage),
    ),
  ).length;
  return [
    check(
      'character_coverage',
      '引用人物档案完整',
      ratioScore(characters.length, referenced.characterIds.length, 20),
      20,
      `${characters.length}/${referenced.characterIds.length} 个人物有档案`,
    ),
    check(
      'visual_lock',
      '人物与场景锁定',
      ratioScore(
        lockedCharacters.length + lockedLocations.length,
        characters.length + locations.length,
        25,
      ),
      25,
      `人物 ${lockedCharacters.length}/${characters.length}，场景 ${lockedLocations.length}/${locations.length}`,
    ),
    check(
      'voice_identity',
      '主要角色音色可区分',
      ratioScore(uniqueVoices, characters.length, 20),
      20,
      `${uniqueVoices}/${characters.length} 个不同 voiceId`,
      'proxy',
    ),
    check(
      'personality_identity',
      '人物人格文本可区分',
      ratioScore(uniquePersonalities, characters.length, 20),
      20,
      `${uniquePersonalities}/${characters.length} 份不同人物定义`,
      'proxy',
    ),
    check(
      'outfit_reference',
      '服装参考可追溯',
      ratioScore(outfitReferences, characters.length, 15),
      15,
      `${outfitReferences}/${characters.length} 个人物服装有本地参考`,
    ),
  ];
}

function storyboardChecks(store: ProjectStore, episodeId: string): EvaluationCheck[] {
  const series = store.series();
  const script = store.script(episodeId);
  const storyboard = store.storyboard(episodeId);
  const validation = validateStoryboard(series, script, storyboard);
  const shotSizes = new Set(storyboard.cuts.map((cut) => cut.shotSize));
  const durations = new Set(storyboard.cuts.map((cut) => cut.durationSec.toFixed(2)));
  const moving = storyboard.cuts.filter((cut) => cut.camera.move !== 'STATIC').length;
  const movingRatio = moving / Math.max(1, storyboard.cuts.length);
  const keyCuts = storyboard.cuts.filter((cut) => cut.importance === 'key').length;
  const closeReactionProxy = storyboard.cuts.filter(
    (cut) =>
      ['CU', 'ECU'].includes(cut.shotSize) &&
      cut.characters.length > 0 &&
      cut.action.trim().length > 0,
  ).length;
  return [
    check(
      'storyboard_contract',
      '镜头表生产契约',
      validation.ok ? 30 : 0,
      30,
      validation.ok ? '镜头数、时长和台词覆盖通过' : validation.errors.join('；'),
    ),
    check(
      'shot_variety',
      '景别具有变化',
      clamp((shotSizes.size / 4) * 15, 0, 15),
      15,
      `${shotSizes.size} 种景别：${[...shotSizes].join('、')}`,
      'proxy',
    ),
    check(
      'camera_motivation',
      '运镜密度不过载',
      movingRatio >= 0.15 && movingRatio <= 0.65 ? 15 : 7,
      15,
      `${moving}/${storyboard.cuts.length} 卡使用运动镜头`,
      'proxy',
    ),
    check(
      'pacing_variation',
      '镜头时长有节奏变化',
      durations.size >= 3 ? 15 : durations.size === 2 ? 10 : 4,
      15,
      `${durations.size} 种镜头时长`,
      'proxy',
    ),
    check(
      'key_moments',
      '关键情绪卡已标注',
      keyCuts >= Math.max(2, Math.floor(storyboard.cuts.length * 0.12)) ? 10 : 4,
      10,
      `${keyCuts}/${storyboard.cuts.length} 张关键卡`,
      'proxy',
    ),
    check(
      'reaction_coverage',
      '近景反应镜头代理检查',
      ratioScore(
        Math.min(closeReactionProxy, Math.ceil(storyboard.cuts.length * 0.25)),
        Math.max(1, Math.ceil(storyboard.cuts.length * 0.25)),
        15,
      ),
      15,
      `${closeReactionProxy} 张近景/特写人物动作卡`,
      'proxy',
    ),
  ];
}

function sakkanScores(store: ProjectStore, episodeId: string): number[] {
  const storyboard = store.storyboard(episodeId);
  return storyboard.cuts.flatMap((cut) => {
    const root = store.paths.cut(episodeId, cut.id).meta;
    if (!fs.existsSync(root)) return [];
    return fs
      .readdirSync(root)
      .filter((name) => name.endsWith('-sakkan.yaml'))
      .flatMap((name) => {
        try {
          const value = YAML.parse(fs.readFileSync(path.join(root, name), 'utf8')) as {
            identityScore?: unknown;
          };
          return typeof value.identityScore === 'number'
            ? [clamp(value.identityScore, 0, 1)]
            : [];
        } catch {
          return [];
        }
      });
  });
}

function visualChecks(store: ProjectStore, episodeId: string): EvaluationCheck[] {
  const storyboard = store.storyboard(episodeId);
  const state = store.state(episodeId);
  const requiredFrames = storyboard.cuts.reduce(
    (sum, cut) => sum + requiredFrameCount(cut.genMode),
    0,
  );
  const selectedFrames = storyboard.cuts.reduce(
    (sum, cut) => sum + (state.cuts[cut.id]?.selectedKeyframes.length ?? 0),
    0,
  );
  const selectedVideos = storyboard.cuts.filter(
    (cut) => state.cuts[cut.id]?.selectedVideo,
  ).length;
  const failed = storyboard.cuts.filter(
    (cut) => state.cuts[cut.id]?.stage === 'failed',
  ).length;
  const retakes = storyboard.cuts.reduce(
    (sum, cut) => sum + (state.cuts[cut.id]?.retakeCount ?? 0),
    0,
  );
  const identity = sakkanScores(store, episodeId);
  const identityAverage =
    identity.reduce((sum, value) => sum + value, 0) / Math.max(1, identity.length);
  return [
    check(
      'keyframe_coverage',
      '关键帧圈选覆盖',
      ratioScore(selectedFrames, requiredFrames, 25),
      25,
      `${selectedFrames}/${requiredFrames} 张必需帧已圈选`,
      selectedFrames ? 'direct' : 'missing',
    ),
    check(
      'video_coverage',
      '镜头视频覆盖',
      ratioScore(selectedVideos, storyboard.cuts.length, 25),
      25,
      `${selectedVideos}/${storyboard.cuts.length} 卡有圈选视频`,
      selectedVideos ? 'direct' : 'missing',
    ),
    check(
      'identity_reports',
      '作监身份一致性',
      identity.length ? identityAverage * 25 : 0,
      25,
      identity.length
        ? `${identity.length} 份报告，平均 ${(identityAverage * 100).toFixed(1)}`
        : '尚无真实作监身份报告；dry-run 不伪造感知评分',
      identity.length ? 'direct' : 'missing',
    ),
    check(
      'failed_cuts',
      '无失败镜头',
      ratioScore(storyboard.cuts.length - failed, storyboard.cuts.length, 15),
      15,
      `${failed} 张失败卡`,
    ),
    check(
      'retake_load',
      '局部重做负担',
      retakes <= storyboard.cuts.length * 0.2 ? 10 : retakes <= storyboard.cuts.length * 0.5 ? 6 : 2,
      10,
      `${retakes} 次局部重做`,
      'proxy',
    ),
  ];
}

function audioChecks(store: ProjectStore, episodeId: string): EvaluationCheck[] {
  const script = store.script(episodeId);
  const characters = store.characters();
  const dialogue = script.scenes
    .flatMap((scene) => scene.dialogue)
    .filter((line) => ['dialogue', 'narration'].includes(line.kind));
  const audio = dialogue.filter(
    (line) => line.audio?.file && fs.existsSync(line.audio.file),
  );
  const durationReady = audio.filter(
    (line) => (line.audio?.durationSec ?? 0) > 0,
  ).length;
  const referenced = new Set(
    dialogue.flatMap((line) => (line.speakerId ? [line.speakerId] : [])),
  );
  const speakingCharacters = characters.filter((item) => referenced.has(item.id));
  const voices = new Set(speakingCharacters.map((item) => item.voice.voiceId));
  const samples = speakingCharacters.filter((item) =>
    fs.existsSync(
      path.join(store.paths.characterRoot(item.id), 'candidates', 'voice-sample.mp3'),
    ),
  );
  const nonStub = audio.filter((line) => line.audio?.provider !== 'stub-tts').length;
  return [
    check(
      'dialogue_audio',
      '对白音频覆盖',
      ratioScore(audio.length, dialogue.length, 35),
      35,
      `${audio.length}/${dialogue.length} 句有本地音频`,
      audio.length ? 'direct' : 'missing',
    ),
    check(
      'duration_feedback',
      '实际时长回填',
      ratioScore(durationReady, dialogue.length, 20),
      20,
      `${durationReady}/${dialogue.length} 句有实际时长`,
      durationReady ? 'direct' : 'missing',
    ),
    check(
      'voice_separation',
      '说话角色音色区分',
      ratioScore(voices.size, speakingCharacters.length, 20),
      20,
      `${voices.size}/${speakingCharacters.length} 个不同 voiceId`,
      'proxy',
    ),
    check(
      'voice_samples',
      '角色试听样片',
      ratioScore(samples.length, speakingCharacters.length, 15),
      15,
      `${samples.length}/${speakingCharacters.length} 个说话角色有试听`,
      samples.length ? 'direct' : 'missing',
    ),
    check(
      'real_voice_evidence',
      '非占位 TTS 证据',
      ratioScore(nonStub, dialogue.length, 10),
      10,
      `${nonStub}/${dialogue.length} 句来自非 stub provider`,
      nonStub ? 'direct' : 'missing',
    ),
  ];
}

function continuityChecks(store: ProjectStore, episodeId: string): EvaluationCheck[] {
  const script = store.script(episodeId);
  const storyboard = store.storyboard(episodeId);
  const state = store.state(episodeId);
  const assetValidation = validateAssetsLocked(store, script, storyboard);
  const frameFiles = storyboard.cuts.flatMap(
    (cut) => state.cuts[cut.id]?.selectedKeyframes ?? [],
  );
  const existingFrames = frameFiles.filter((file) => fs.existsSync(file)).length;
  const stale = storyboard.cuts.filter(
    (cut) => (state.cuts[cut.id]?.staleReasons.length ?? 0) > 0,
  ).length;
  const linked = storyboard.cuts.filter((cut) => cut.tailLink).length;
  const outfitRefs = storyboard.cuts
    .flatMap((cut) => cut.characters)
    .filter((appearance) => {
      const character = store.character(appearance.characterId);
      const outfit = character?.outfits[appearance.outfitId];
      return Boolean(outfit?.referenceImage && fs.existsSync(outfit.referenceImage));
    });
  const appearances = storyboard.cuts.flatMap((cut) => cut.characters);
  return [
    check(
      'asset_lock',
      '角色与场景事实源锁定',
      assetValidation.ok ? 25 : 0,
      25,
      assetValidation.ok ? '引用资产全部锁定' : assetValidation.errors.join('；'),
    ),
    check(
      'selected_frame_files',
      '圈选帧文件完整',
      ratioScore(existingFrames, frameFiles.length, 20),
      20,
      `${existingFrames}/${frameFiles.length} 个圈选帧文件存在`,
      frameFiles.length ? 'direct' : 'missing',
    ),
    check(
      'outfit_trace',
      '镜头服装引用可追溯',
      ratioScore(outfitRefs.length, appearances.length, 20),
      20,
      `${outfitRefs.length}/${appearances.length} 个镜头人物服装有参考`,
    ),
    check(
      'tail_links',
      '连续镜头尾帧链接',
      linked > 0 ? 15 : 5,
      15,
      `${linked} 张卡声明 tailLink`,
      'proxy',
    ),
    check(
      'stale_state',
      '无过期下游状态',
      ratioScore(storyboard.cuts.length - stale, storyboard.cuts.length, 20),
      20,
      `${stale} 张卡包含 stale reason`,
    ),
  ];
}

function platformChecks(store: ProjectStore, episodeId: string): EvaluationCheck[] {
  const series = store.series();
  const storyboard = store.storyboard(episodeId);
  const duration = storyboard.cuts.reduce((sum, cut) => sum + cut.durationSec, 0);
  const opening = storyboard.cuts.slice(0, 3).reduce(
    (sum, cut) => sum + cut.durationSec,
    0,
  );
  return [
    check(
      'portrait_spec',
      '竖屏母版规格',
      series.spec.width === 1080 && series.spec.height === 1920 ? 30 : 0,
      30,
      `${series.spec.width}×${series.spec.height}`,
    ),
    check(
      'platform_duration',
      '单集不超过 3 分钟',
      duration <= 180 ? 25 : 0,
      25,
      `${duration.toFixed(1)} 秒`,
    ),
    check(
      'recommended_duration',
      '推荐短剧节奏区间',
      duration >= 55 && duration <= 120 ? 20 : 8,
      20,
      `${duration.toFixed(1)} 秒；当前生产目标 60–120 秒`,
      'proxy',
    ),
    check(
      'opening_density',
      '前三卡首屏密度',
      opening <= 15 ? 15 : opening <= 22 ? 9 : 3,
      15,
      `前三卡共 ${opening.toFixed(1)} 秒`,
      'proxy',
    ),
    check(
      'cut_target',
      '镜头数适配',
      storyboard.cuts.length >= series.spec.targetCuts[0] &&
        storyboard.cuts.length <= series.spec.targetCuts[1]
        ? 10
        : 0,
      10,
      `${storyboard.cuts.length} 卡`,
    ),
  ];
}

function deliveryChecks(store: ProjectStore, episodeId: string): EvaluationCheck[] {
  const state = store.state(episodeId);
  const delivery = state.delivery;
  const qcFile = path.join(store.paths.finalDir(episodeId), 'qc-report.yaml');
  let qc: { pass?: boolean; checks?: Array<{ ok?: boolean }> } | undefined;
  if (fs.existsSync(qcFile)) {
    try {
      qc = YAML.parse(fs.readFileSync(qcFile, 'utf8')) as typeof qc;
    } catch {
      qc = undefined;
    }
  }
  const passedChecks = qc?.checks?.filter((item) => item.ok).length ?? 0;
  const totalChecks = qc?.checks?.length ?? 0;
  return [
    check(
      'delivery_manifest',
      '交付清单存在',
      delivery ? 20 : 0,
      20,
      delivery ? delivery.finalVideo : '尚未合成最终交付',
      delivery ? 'direct' : 'missing',
    ),
    check(
      'automatic_qc',
      '自动 QC',
      ratioScore(passedChecks, totalChecks, 35),
      35,
      totalChecks ? `${passedChecks}/${totalChecks} 项通过` : '尚无 QC 报告',
      totalChecks ? 'direct' : 'missing',
    ),
    check(
      'final_media',
      '最终视频与字幕/封面',
      delivery &&
        fs.existsSync(delivery.finalVideo) &&
        fs.existsSync(delivery.subtitles) &&
        fs.existsSync(delivery.cover)
        ? 20
        : 0,
      20,
      delivery ? delivery.finalVideo : '缺少交付文件',
      delivery ? 'direct' : 'missing',
    ),
    check(
      'aigc_label',
      'AIGC 标识',
      delivery?.aigcLabel === 'burned' ? 10 : 0,
      10,
      delivery?.aigcLabel ?? '未记录',
      delivery ? 'direct' : 'missing',
    ),
    check(
      'picture_lock',
      '人工成片批准',
      state.gates.final ? 15 : 0,
      15,
      state.gates.final ? state.gates.final.at : '尚未 picture lock',
      state.gates.final ? 'direct' : 'missing',
    ),
  ];
}

function checksFor(
  dimension: EvaluationDimensionId,
  store: ProjectStore,
  episodeId: string,
): EvaluationCheck[] {
  if (dimension === 'narrative') return narrativeChecks(store, episodeId);
  if (dimension === 'character') return characterChecks(store, episodeId);
  if (dimension === 'storyboard') return storyboardChecks(store, episodeId);
  if (dimension === 'visual') return visualChecks(store, episodeId);
  if (dimension === 'audio') return audioChecks(store, episodeId);
  if (dimension === 'continuity') return continuityChecks(store, episodeId);
  if (dimension === 'platform') return platformChecks(store, episodeId);
  return deliveryChecks(store, episodeId);
}

function summarize(checks: EvaluationCheck[]): string {
  const failed = checks.filter((item) => item.status === 'fail');
  const warnings = checks.filter((item) => item.status === 'warn');
  if (failed.length) return `需修订：${failed.map((item) => item.label).join('、')}`;
  if (warnings.length) return `需人工确认：${warnings.map((item) => item.label).join('、')}`;
  return '自动结构证据全部通过；感知质量仍需人工看片/试听';
}

function dimension(
  id: EvaluationDimensionId,
  weight: number,
  checks: EvaluationCheck[],
  manual: ManualRating | undefined,
) {
  const automaticScore = Math.round(
    (checks.reduce((sum, item) => sum + item.score, 0) /
      Math.max(1, checks.reduce((sum, item) => sum + item.maxScore, 0))) *
      100,
  );
  const score = manual
    ? Math.round(automaticScore * 0.45 + manual.score * 0.55)
    : automaticScore;
  return EvaluationDimensionSchema.parse({
    id,
    label: labels[id],
    weight,
    score,
    automaticScore,
    ...(manual
      ? {
          manualScore: manual.score,
          manualNote: manual.note,
          source: 'hybrid',
          confidence: 0.82,
        }
      : { source: 'automatic', confidence: 0.56 }),
    summary: summarize(checks),
    checks,
  });
}

function reportView(store: ProjectStore, report: EvaluationReport) {
  return {
    ...report,
    stale: report.inputHash !== currentHash(store, report.episodeId),
  };
}

export function runEvaluation(
  store: ProjectStore,
  episodeId: string,
  input: unknown,
) {
  const body = CreateEvaluationSchema.parse(input);
  const manual = new Map(
    body.manualRatings.map((rating) => [rating.dimension, rating]),
  );
  const dimensions = scopes[body.scope].map(([id, weight]) =>
    dimension(id, weight, checksFor(id, store, episodeId), manual.get(id)),
  );
  const weightTotal = dimensions.reduce((sum, item) => sum + item.weight, 0);
  const overallScore = Math.round(
    dimensions.reduce((sum, item) => sum + item.score * item.weight, 0) /
      weightTotal,
  );
  const evidenceCoverage = Math.round(
    (dimensions.reduce(
      (dimensionSum, item) =>
        dimensionSum +
        item.weight *
          (item.checks.reduce(
            (sum, itemCheck) =>
              sum +
              itemCheck.maxScore *
                (itemCheck.evidenceKind === 'direct'
                  ? 1
                  : itemCheck.evidenceKind === 'proxy'
                    ? 0.5
                    : 0),
            0,
          ) /
            item.checks.reduce((sum, itemCheck) => sum + itemCheck.maxScore, 0)),
      0,
    ) /
      weightTotal) *
      100,
  );
  const humanCoverage = Math.round(
    (dimensions
      .filter((item) => item.manualScore !== undefined)
      .reduce((sum, item) => sum + item.weight, 0) /
      weightTotal) *
      100,
  );
  const verdict =
    overallScore < 70
      ? 'revise'
      : humanCoverage < 50 || evidenceCoverage < 60
        ? 'needs_human_review'
        : 'pass';
  const report = EvaluationReportSchema.parse({
    id: randomUUID(),
    version: 1,
    seriesId: store.seriesId,
    episodeId,
    scope: body.scope,
    title:
      body.title ??
      {
        story: '剧本与分镜检查点',
        dailies: '样片与连续性评测',
        final: '成片综合评测',
      }[body.scope],
    inputHash: currentHash(store, episodeId),
    overallScore,
    evidenceCoverage,
    humanCoverage,
    verdict,
    dimensions,
    createdAt: new Date().toISOString(),
  });
  writeYaml(store.paths.evaluationFile(episodeId, report.id), report);
  return reportView(store, report);
}

export function listEvaluations(store: ProjectStore, episodeId: string) {
  const root = store.paths.evaluationsDir(episodeId);
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.yaml'))
    .flatMap((entry) => {
      try {
        const report = EvaluationReportSchema.parse(
          YAML.parse(fs.readFileSync(path.join(root, entry.name), 'utf8')),
        );
        return report.seriesId === store.seriesId && report.episodeId === episodeId
          ? [reportView(store, report)]
          : [];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function mediaUrl(config: AppConfig, file: string): string | undefined {
  const root = path.resolve(config.projectsRoot);
  const resolved = path.resolve(file);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
  return `/media/${relative
    .split(path.sep)
    .map((part) => encodeURIComponent(part))
    .join('/')}`;
}

function candidateId(source: string, file: string): string {
  return createHash('sha256').update(`${source}\0${path.resolve(file)}`).digest('hex').slice(0, 24);
}

function generationInfo(
  store: ProjectStore,
  episodeId: string,
  file: string,
): { provider: string; model?: string; costCny?: number } | undefined {
  for (const cut of store.storyboard(episodeId).cuts) {
    const root = store.paths.cut(episodeId, cut.id).meta;
    if (!fs.existsSync(root)) continue;
    for (const name of fs.readdirSync(root)) {
      if (!name.endsWith('.yaml') || name.endsWith('-sakkan.yaml')) continue;
      try {
        const value = YAML.parse(fs.readFileSync(path.join(root, name), 'utf8')) as {
          outputFile?: unknown;
          provider?: unknown;
          model?: unknown;
          amountCny?: unknown;
        };
        if (
          typeof value.outputFile === 'string' &&
          path.resolve(value.outputFile) === path.resolve(file) &&
          typeof value.provider === 'string'
        ) {
          return {
            provider: value.provider,
            ...(typeof value.model === 'string' ? { model: value.model } : {}),
            ...(typeof value.amountCny === 'number'
              ? { costCny: value.amountCny }
              : {}),
          };
        }
      } catch {
        // Other metadata documents are not generation records.
      }
    }
  }
  return undefined;
}

export function listBenchmarkCandidates(
  config: AppConfig,
  store: ProjectStore,
  episodeId: string,
  libTvSessions: Array<{
    id: string;
    results: Array<{
      file: string;
      mimeType: string;
      url: string | undefined;
    }>;
  }>,
): BenchmarkCandidate[] {
  const state = store.state(episodeId);
  const values: BenchmarkCandidate[] = [];
  for (const cut of store.storyboard(episodeId).cuts) {
    const entry = state.cuts[cut.id];
    for (let index = 0; index < (entry?.selectedKeyframes.length ?? 0); index += 1) {
      const file = entry!.selectedKeyframes[index]!;
      if (!fs.existsSync(file)) continue;
      const info = generationInfo(store, episodeId, file);
      values.push(
        BenchmarkCandidateSchema.parse({
          id: candidateId('pipeline-keyframe', file),
          source: 'pipeline',
          kind: 'image',
          label: `${cut.id} · 已圈选关键帧 ${index + 1}`,
          file,
          url: mediaUrl(config, file),
          provider: info?.provider ?? 'pipeline',
          model: info?.model,
          costCny: info?.costCny,
          costKnown: info?.costCny !== undefined,
        }),
      );
    }
    if (entry?.selectedVideo && fs.existsSync(entry.selectedVideo)) {
      const info = generationInfo(store, episodeId, entry.selectedVideo);
      values.push(
        BenchmarkCandidateSchema.parse({
          id: candidateId('pipeline-video', entry.selectedVideo),
          source: 'pipeline',
          kind: 'video',
          label: `${cut.id} · 圈选视频`,
          file: entry.selectedVideo,
          url: mediaUrl(config, entry.selectedVideo),
          provider: info?.provider ?? 'pipeline',
          model: info?.model,
          costCny: info?.costCny,
          costKnown: info?.costCny !== undefined,
        }),
      );
    }
  }
  if (state.delivery?.finalVideo && fs.existsSync(state.delivery.finalVideo)) {
    values.push(
      BenchmarkCandidateSchema.parse({
        id: candidateId('pipeline-final', state.delivery.finalVideo),
        source: 'pipeline',
        kind: 'video',
        label: `${episodeId} · 最终成片`,
        file: state.delivery.finalVideo,
        url: mediaUrl(config, state.delivery.finalVideo),
        provider: 'AI-amnTV compose',
        costKnown: false,
      }),
    );
  }
  for (const session of libTvSessions) {
    session.results.forEach((result, index) => {
      if (!fs.existsSync(result.file)) return;
      const kind = result.mimeType.startsWith('video/') ? 'video' : 'image';
      values.push(
        BenchmarkCandidateSchema.parse({
          id: candidateId('libtv', result.file),
          source: 'libtv',
          kind,
          label: `LibTV ${session.id.slice(0, 8)} · 结果 ${index + 1}`,
          file: result.file,
          url: result.url ?? mediaUrl(config, result.file),
          provider: 'LibTV',
          costKnown: false,
        }),
      );
    });
  }
  return [...new Map(values.map((value) => [path.resolve(value.file), value])).values()];
}

const imageWeights = {
  identity: 30,
  composition: 25,
  cameraLanguage: 20,
  artifacts: 25,
} as const;
const videoWeights = {
  identity: 20,
  composition: 15,
  cameraLanguage: 20,
  motion: 20,
  artifacts: 15,
  voicePerformance: 10,
} as const;

async function technical(
  config: AppConfig,
  candidate: BenchmarkCandidate,
) {
  const stat = fs.statSync(candidate.file);
  if (candidate.kind === 'image') {
    const metadata = await sharp(candidate.file).metadata();
    return {
      bytes: stat.size,
      width: metadata.width ?? 0,
      height: metadata.height ?? 0,
    };
  }
  const media = await probeMedia(config, candidate.file);
  return {
    bytes: stat.size,
    width: media.width,
    height: media.height,
    durationSec: media.durationSec,
    fps: media.fps,
    hasAudio: media.hasAudio,
  };
}

export async function runBenchmark(
  config: AppConfig,
  store: ProjectStore,
  episodeId: string,
  candidates: BenchmarkCandidate[],
  input: unknown,
) {
  const body = CreateBenchmarkSchema.parse(input);
  const available = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const seen = new Set<string>();
  const unranked = [];
  for (const rating of body.ratings) {
    if (seen.has(rating.candidateId)) {
      throw new Error(`对比候选重复：${rating.candidateId}`);
    }
    seen.add(rating.candidateId);
    const candidate = available.get(rating.candidateId);
    if (!candidate) throw new Error(`评测候选不存在或已失效：${rating.candidateId}`);
    const weights = candidate.kind === 'image' ? imageWeights : videoWeights;
    const criteria = rating.criteria as Record<string, number | undefined>;
    for (const key of Object.keys(weights)) {
      if (criteria[key] === undefined) {
        throw new Error(`${candidate.label} 缺少人工评分项：${key}`);
      }
    }
    const weightTotal = Object.values(weights).reduce((sum, value) => sum + value, 0);
    const score = Math.round(
      Object.entries(weights).reduce(
        (sum, [key, weight]) => sum + (criteria[key] ?? 0) * weight,
        0,
      ) / weightTotal,
    );
    unranked.push({
      candidate,
      criteria: rating.criteria,
      score,
      note: rating.note,
      technical: await technical(config, candidate),
    });
  }
  const items = unranked
    .sort((a, b) => b.score - a.score)
    .map((item, index) => ({ ...item, rank: index + 1 }));
  const report = BenchmarkReportSchema.parse({
    id: randomUUID(),
    version: 1,
    seriesId: store.seriesId,
    episodeId,
    title: body.title,
    rubric: 'amnTV-perceptual-v1',
    items,
    createdAt: new Date().toISOString(),
  });
  writeYaml(store.paths.benchmarkFile(episodeId, report.id), report);
  return report;
}

export function listBenchmarks(store: ProjectStore, episodeId: string) {
  const root = store.paths.benchmarksDir(episodeId);
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.yaml'))
    .flatMap((entry) => {
      try {
        const report = BenchmarkReportSchema.parse(
          YAML.parse(fs.readFileSync(path.join(root, entry.name), 'utf8')),
        );
        return report.seriesId === store.seriesId && report.episodeId === episodeId
          ? [report]
          : [];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
