import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import type { AppConfig } from '../config.js';
import {
  checkSakkan,
  drawStoryboard,
  reviewScript,
  tagBreakdown,
  writeScript,
} from '../agents/index.js';
import type {
  Character,
  Cut,
  EpisodeState,
  GenerationMeta,
  Location,
  ReadinessCheck,
  Script,
  Series,
  Storyboard,
} from '../domain.js';
import { exportJianyingDraft } from '../export/jianying.js';
import {
  burnDelivery,
  composeCut,
  concatCuts,
  writeSrt,
} from '../media/compose.js';
import { extractCover, probeMedia } from '../media/ffmpeg.js';
import { createProviders } from '../providers/index.js';
import { StubVideoProvider } from '../providers/stub.js';
import type { GenerationResult, Providers, VideoProvider } from '../providers/types.js';
import {
  openReview,
  writeChoiceReview,
  writeDocumentReview,
  type ReviewGroup,
} from '../review/html.js';
import { ProjectStore, writeYaml } from '../store.js';
import { exportQcReport, qcReportText } from './report.js';
import { assemblePrompt } from './prompt.js';
import { runDeliveryQc } from './qc.js';
import {
  assertValid,
  validateAssetsLocked,
  validateScript,
  validateStoryboard,
  videoReadiness,
} from './validation.js';

const log = (message: string) => console.log(`[AI-amnTV] ${message}`);
const now = () => new Date().toISOString();
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

function approval(note?: string) {
  return { at: now(), by: 'human' as const, ...(note ? { note } : {}) };
}

function requireGate(
  state: EpisodeState,
  gate: keyof EpisodeState['gates'],
  message: string,
): void {
  if (!state.gates[gate]) throw new Error(message);
}

function saveGenerationMeta(file: string, value: GenerationMeta): void {
  writeYaml(file, value);
}

function recordCost(
  store: ProjectStore,
  episodeId: string,
  kind: 'image' | 'video' | 'tts',
  result: GenerationResult,
  quantity: number,
  unit: string,
  cutId?: string,
): void {
  const state = store.state(episodeId);
  state.costLedger.push({
    at: now(),
    kind,
    provider: result.provider,
    ...(cutId ? { cutId } : {}),
    ...(result.amountCny !== undefined ? { amountCny: result.amountCny } : {}),
    unit,
    quantity,
  });
  store.saveState(state);
}

function sceneForCut(script: Script, cut: Cut) {
  const scene = script.scenes.find((item) => item.id === cut.sceneId);
  if (!scene) throw new Error(`${cut.id} 引用了不存在的场 ${cut.sceneId}`);
  return scene;
}

function parseNewCharacter(
  value: { id: string; name: string; age: string; personality: string },
): Character {
  return {
    id: value.id,
    name: value.name,
    age: value.age,
    personality: value.personality,
    relationships: {},
    turnaround: [],
    expressions: {},
    outfits: {
      'OF-01-a': { label: '默认服装（待编辑）', referenceImage: '' },
    },
    palette: {
      normal: ['#808080'],
      night: ['#404050'],
      evening: ['#806050'],
    },
    voice: {
      provider: 'minimax',
      voiceId: 'PLEASE_CONFIGURE',
      params: {},
    },
    status: 'draft',
  };
}

function parseNewLocation(value: {
  id: string;
  name: string;
  brief: string;
}): Location {
  return {
    id: value.id,
    name: value.name,
    referenceImages: [],
    variants: {},
    status: 'draft',
  };
}

export function initializeSeries(
  store: ProjectStore,
  options: { title: string; genre: string; logline: string },
): Series {
  if (store.hasSeries()) throw new Error(`系列已存在: ${store.paths.seriesFile}`);
  const series: Series = {
    id: store.seriesId,
    title: options.title,
    genre: options.genre,
    logline: options.logline,
    spec: {
      width: 1080,
      height: 1920,
      fps: 24,
      episodeDurationSec: [60, 120],
      targetCuts: [15, 25],
    },
    style: {
      prompt: 'anime, clean line art, cinematic cel shading, consistent character design',
      negativePrompt:
        'photorealistic, 3d render, text, logo, watermark, extra fingers, deformed face',
      referenceImages: [],
      imageModel: '配置 COMFYUI_WORKFLOW 或使用 AMNTV_DRY_RUN=1',
    },
  };
  store.saveSeries(series);
  log(`已创建系列 ${store.seriesId}: ${store.paths.seriesFile}`);
  return series;
}

export async function scriptStage(
  config: AppConfig,
  store: ProjectStore,
  episodeId: string,
  outline: string,
): Promise<void> {
  if (config.dryRun) {
    throw new Error('dry-run 的完整验收请使用 demo；真实大纲生成需要 ANTHROPIC_API_KEY');
  }
  const series = store.series();
  const knownAssets = {
    characters: store.characters().map((item) => ({ id: item.id, name: item.name })),
    locations: store.locations().map((item) => ({ id: item.id, name: item.name })),
  };
  const context = JSON.stringify(
    {
      series,
      episodeId,
      outline,
      knownAssets,
    },
    null,
    2,
  );
  let generated = await writeScript(config, context);
  let latestReview = await reviewScript(config, generated);
  for (let round = 0; round < 2 && latestReview.verdict === 'revise'; round += 1) {
    const blocking = latestReview.issues.filter((issue) => issue.severity !== 'C');
    if (!blocking.length) break;
    generated = await writeScript(config, context, JSON.stringify(blocking, null, 2));
    latestReview = await reviewScript(config, generated);
  }
  const script: Script = {
    episodeId,
    title: generated.title,
    emotionContract: generated.emotionContract,
    scenes: generated.scenes.map((scene) => ({ ...scene, revision: 1 })),
    manifests: [],
    status: 'draft',
  };
  assertValid(validateScript(script), '剧本');
  store.saveScript(script);
  writeYaml(path.join(store.paths.episodeRoot(episodeId), 'script-review.yaml'), latestReview);
  for (const item of generated.newCharacters) {
    if (!store.character(item.id)) store.saveCharacter(parseNewCharacter(item));
  }
  for (const item of generated.newLocations) {
    if (!store.location(item.id)) store.saveLocation(parseNewLocation(item));
  }
  const reviewFile = writeDocumentReview(
    path.join(store.paths.reviewDir(episodeId), 'gate-1-script.html'),
    `关卡① 剧本确认 · ${episodeId}`,
    `amntv approve script ${store.seriesId} ${episodeId}`,
    [
      { label: '剧本', content: YAML.stringify(script) },
      { label: '女频监督报告', content: YAML.stringify(latestReview) },
    ],
  );
  openReview(config, reviewFile);
  log(`剧本与监督报告已生成: ${reviewFile}`);
}

function deriveManifests(script: Script) {
  return script.scenes.map((scene) => {
    const characters = [
      ...new Set(
        scene.dialogue
          .map((line) => line.speakerId)
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    return {
      sceneId: scene.id,
      characters,
      locations: [scene.locationId],
      props: [],
      wardrobe: characters.map((characterId) => ({
        characterId,
        outfitId: 'OF-01-a',
      })),
      vfxNotes: [],
    };
  });
}

export async function approveScript(
  config: AppConfig,
  store: ProjectStore,
  episodeId: string,
): Promise<void> {
  const script = store.script(episodeId);
  assertValid(validateScript(script), '剧本');
  script.status = 'locked';
  script.lockedAt = now();
  store.saveScript(script);
  const state = store.state(episodeId);
  state.gates.script = approval('场号与台词 ID 自此锁定');
  store.saveState(state);
  const manifests =
    script.manifests.length > 0
      ? script.manifests
      : config.dryRun
        ? deriveManifests(script)
        : (await tagBreakdown(config, script)).manifests;
  script.manifests = manifests;
  store.saveScript(script);
  log('关卡①已通过；breakdown 资产清单已生成');
}

function candidateCount(isKey = false): number {
  return isKey ? 4 : 3;
}

export async function castingStage(
  config: AppConfig,
  store: ProjectStore,
  episodeId: string,
): Promise<void> {
  requireGate(store.state(episodeId), 'script', '请先通过关卡①剧本确认');
  const providers = createProviders(config);
  const imageStatus = providers.image.status();
  if (!imageStatus.ready) throw new Error(`出图供应商未就绪: ${imageStatus.message}`);
  const groups: ReviewGroup[] = [];
  for (const character of store.characters()) {
    if (character.status === 'locked') continue;
    const root = path.join(store.paths.characterRoot(character.id), 'candidates');
    const candidates = [];
    let voiceSample: string | undefined;
    for (let index = 0; index < candidateCount(); index += 1) {
      const output = path.join(root, `image-${index + 1}.png`);
      const generated = await providers.image.generate({
        prompt: [
          store.series().style.prompt,
          'anime character model sheet, front view, side view, back view, expression row',
          `角色名=${character.name}; 年龄=${character.age}; 性格=${character.personality}`,
        ].join('\n'),
        negativePrompt: store.series().style.negativePrompt,
        referenceImages: [],
        width: 768,
        height: 1024,
        seed: index + 1,
        outputFile: output,
      });
      recordCost(store, episodeId, 'image', generated, 1, 'candidate');
      candidates.push({
        label: `定妆候选 ${index + 1}`,
        file: output,
        metadata: `${generated.provider}/${generated.model}`,
      });
    }
    if (
      config.dryRun ||
      (character.voice.voiceId !== 'PLEASE_CONFIGURE' && providers.tts.status().ready)
    ) {
      const voiceFile = path.join(root, 'voice-sample.mp3');
      const voice = await providers.tts.synthesize({
        text: `我是${character.name}，这一次，我会做自己的选择。`,
        voiceId: character.voice.voiceId,
        emotion: 'determined',
        params: character.voice.params,
        outputFile: voiceFile,
      });
      recordCost(store, episodeId, 'tts', voice, 1, 'voice_sample');
      voiceSample = voiceFile;
    }
    character.status = 'candidates_ready';
    store.saveCharacter(character);
    groups.push({
      id: character.id,
      title: `${character.id} · ${character.name}`,
      note: `${character.personality}；试听文件位于 candidates/voice-sample.mp3`,
      ...(voiceSample ? { audioFile: voiceSample } : {}),
      candidates,
    });
  }
  for (const location of store.locations()) {
    if (location.status === 'locked') continue;
    const root = path.join(path.dirname(store.paths.locationFile(location.id)), 'candidates');
    const candidates = [];
    for (let index = 0; index < candidateCount(); index += 1) {
      const output = path.join(root, `image-${index + 1}.png`);
      const generated = await providers.image.generate({
        prompt: `${store.series().style.prompt}\nanime background model sheet, no characters\n${location.name}`,
        negativePrompt: store.series().style.negativePrompt,
        referenceImages: [],
        width: 768,
        height: 1024,
        seed: 101 + index,
        outputFile: output,
      });
      recordCost(store, episodeId, 'image', generated, 1, 'candidate');
      candidates.push({
        label: `场景候选 ${index + 1}`,
        file: output,
        metadata: `${generated.provider}/${generated.model}`,
      });
    }
    location.status = 'candidates_ready';
    store.saveLocation(location);
    groups.push({
      id: location.id,
      title: `${location.id} · ${location.name}`,
      note: '系列级场景资产',
      candidates,
    });
  }
  if (!groups.length) {
    log('本集引用的资产均已锁定，无需重新定妆');
    return;
  }
  const reviewFile = writeChoiceReview(
    path.join(store.paths.reviewDir(episodeId), 'gate-0-cast.html'),
    `关卡⓪ 定妆锁定 · ${episodeId}`,
    `amntv approve cast ${store.seriesId} ${episodeId}`,
    groups,
  );
  openReview(config, reviewFile);
  log(`定妆审核页已生成: ${reviewFile}`);
}

export function approveCast(
  store: ProjectStore,
  episodeId: string,
  picks: Record<string, number>,
): void {
  for (const [assetId, pick] of Object.entries(picks)) {
    const character = store.character(assetId);
    if (character) {
      const source = path.join(
        store.paths.characterRoot(assetId),
        'candidates',
        `image-${pick}.png`,
      );
      if (!fs.existsSync(source)) throw new Error(`定妆候选不存在: ${source}`);
      const target = path.join(store.paths.characterRoot(assetId), 'turnaround', 'main.png');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
      character.turnaround = [target];
      const firstOutfit = Object.keys(character.outfits)[0];
      if (firstOutfit) character.outfits[firstOutfit]!.referenceImage = target;
      character.status = 'locked';
      character.lockedAt = now();
      store.saveCharacter(character);
      continue;
    }
    const location = store.location(assetId);
    if (location) {
      const source = path.join(
        path.dirname(store.paths.locationFile(assetId)),
        'candidates',
        `image-${pick}.png`,
      );
      if (!fs.existsSync(source)) throw new Error(`场景候选不存在: ${source}`);
      const target = path.join(path.dirname(store.paths.locationFile(assetId)), 'main.png');
      fs.copyFileSync(source, target);
      location.referenceImages = [target];
      location.status = 'locked';
      location.lockedAt = now();
      store.saveLocation(location);
      continue;
    }
    throw new Error(`未知资产 ${assetId}`);
  }
  const validation = validateAssetsLocked(store, store.script(episodeId));
  assertValid(validation, '关卡⓪资产');
  const state = store.state(episodeId);
  state.gates.cast = approval('本集引用的角色、音色与场景资产均锁定');
  store.saveState(state);
  log('关卡⓪已通过：系列资产锁定');
}

export async function storyboardStage(
  config: AppConfig,
  store: ProjectStore,
  episodeId: string,
): Promise<void> {
  const state = store.state(episodeId);
  requireGate(state, 'script', '请先通过关卡①');
  requireGate(state, 'cast', '请先通过关卡⓪');
  if (config.dryRun) {
    throw new Error('demo 已包含可验证分镜；真实分镜生成需要 ANTHROPIC_API_KEY');
  }
  const output = await drawStoryboard(config, {
    series: store.series(),
    script: store.script(episodeId),
    characters: store.characters(),
    locations: store.locations(),
  });
  const storyboard: Storyboard = {
    episodeId,
    cuts: output.cuts,
    status: 'draft',
  };
  assertValid(
    validateStoryboard(store.series(), store.script(episodeId), storyboard),
    '分镜',
  );
  store.saveStoryboard(storyboard);
  store.initCuts(episodeId, storyboard.cuts);
  const reviewFile = writeDocumentReview(
    path.join(store.paths.reviewDir(episodeId), 'gate-2-storyboard.html'),
    `关卡② 分镜批准 · ${episodeId}`,
    `amntv approve storyboard ${store.seriesId} ${episodeId}`,
    [{ label: '镜头表', content: YAML.stringify(storyboard) }],
  );
  openReview(config, reviewFile);
  log(`分镜审核页已生成: ${reviewFile}`);
}

export function approveStoryboard(store: ProjectStore, episodeId: string): void {
  const state = store.state(episodeId);
  requireGate(state, 'script', '剧本关卡未通过');
  requireGate(state, 'cast', '定妆关卡未通过');
  const storyboard = store.storyboard(episodeId);
  assertValid(
    validateStoryboard(store.series(), store.script(episodeId), storyboard),
    '分镜',
  );
  assertValid(
    validateAssetsLocked(store, store.script(episodeId), storyboard),
    '分镜资产',
  );
  storyboard.status = 'approved';
  storyboard.approvedAt = now();
  store.saveStoryboard(storyboard);
  store.initCuts(episodeId, storyboard.cuts);
  state.gates.storyboard = approval('关卡②的分镜表部分');
  store.saveState(state);
  log('关卡②分镜部分已批准');
}

function dialogueLookup(script: Script) {
  return new Map(
    script.scenes.flatMap((scene) =>
      scene.dialogue.map((line) => [line.id, line] as const),
    ),
  );
}

export async function audioStage(
  config: AppConfig,
  store: ProjectStore,
  episodeId: string,
): Promise<void> {
  const state = store.state(episodeId);
  requireGate(state, 'storyboard', '请先批准关卡②的分镜表');
  const providers = createProviders(config);
  const ttsStatus = providers.tts.status();
  if (!ttsStatus.ready) throw new Error(`TTS 供应商未就绪: ${ttsStatus.message}`);
  const script = store.script(episodeId);
  const storyboard = store.storyboard(episodeId);
  const dialogue = dialogueLookup(script);
  for (const cut of storyboard.cuts) {
    const entry = store.state(episodeId).cuts[cut.id];
    if (!entry || entry.stage !== 'pending') continue;
    const bag = store.paths.cut(episodeId, cut.id);
    for (const dialogueId of cut.dialogueIds) {
      const line = dialogue.get(dialogueId);
      if (!line || !['dialogue', 'narration'].includes(line.kind)) continue;
      const character = line.speakerId ? store.character(line.speakerId) : undefined;
      const voiceId = character?.voice.voiceId ?? 'narrator';
      if (!config.dryRun && voiceId === 'PLEASE_CONFIGURE') {
        throw new Error(`${line.speakerId} 的 voiceId 尚未配置`);
      }
      const params = character?.voice.params ?? {};
      const contentHash = hash(
        JSON.stringify([line.text, voiceId, line.emotion, params]),
      );
      if (
        line.audio?.contentHash === contentHash &&
        fs.existsSync(line.audio.file)
      ) {
        continue;
      }
      const replacedExistingAudio = Boolean(line.audio);
      const output = path.join(bag.audio, `${dialogueId}.mp3`);
      const generated = await providers.tts.synthesize({
        text: line.text,
        voiceId,
        emotion: line.emotion,
        params,
        outputFile: output,
      });
      const durationSec = (await probeMedia(config, output)).durationSec;
      line.audio = {
        file: output,
        durationSec,
        contentHash,
        provider: generated.provider,
      };
      recordCost(store, episodeId, 'tts', generated, [...line.text].length, 'character', cut.id);
      if (replacedExistingAudio) {
        const latest = store.state(episodeId);
        const reason = `${dialogueId} 文本或音色变化`;
        if (!latest.cuts[cut.id]!.staleReasons.includes(reason)) {
          latest.cuts[cut.id]!.staleReasons.push(reason);
          store.saveState(latest);
        }
      }
    }
    const lines = cut.dialogueIds
      .map((id) => dialogue.get(id))
      .filter((line) => line?.audio);
    const audioDuration = lines.reduce(
      (sum, line) => sum + (line?.audio?.durationSec ?? 0),
      0,
    );
    if (audioDuration > 0) {
      cut.durationSec = Math.max(cut.durationSec, Number((audioDuration + 0.8).toFixed(3)));
    }
  }
  store.saveScript(script);
  store.saveStoryboard(storyboard);
  assertValid(
    validateStoryboard(store.series(), script, storyboard),
    '音频回填后的分镜',
  );
  for (const cut of storyboard.cuts) {
    const entry = store.state(episodeId).cuts[cut.id];
    if (entry?.stage === 'pending') store.transition(episodeId, cut.id, 'audio_ready');
  }
  log(
    `プレスコ完成，总时长 ${storyboard.cuts.reduce((sum, cut) => sum + cut.durationSec, 0).toFixed(2)}s`,
  );
}

function requiredFrameRoles(cut: Cut): Array<'first' | 'last'> {
  return cut.genMode === 'first_last' || cut.genMode === 'multi_frame'
    ? ['first', 'last']
    : ['first'];
}

export async function keyframeStage(
  config: AppConfig,
  store: ProjectStore,
  episodeId: string,
): Promise<void> {
  const providers = createProviders(config);
  const status = providers.image.status();
  if (!status.ready) throw new Error(`出图供应商未就绪: ${status.message}`);
  const script = store.script(episodeId);
  const storyboard = store.storyboard(episodeId);
  const series = store.series();
  const characters = store.characters();
  const groups: ReviewGroup[] = [];
  for (const cut of storyboard.cuts) {
    const entry = store.state(episodeId).cuts[cut.id];
    if (!entry || entry.stage !== 'audio_ready') continue;
    const scene = sceneForCut(script, cut);
    const bundle = assemblePrompt(
      series,
      scene,
      cut,
      characters,
      store.location(scene.locationId),
    );
    if (bundle.prompt.length > providers.image.promptLimit) {
      throw new Error(`${cut.id} prompt 超过 ${providers.image.promptLimit} 字符`);
    }
    const bag = store.paths.cut(episodeId, cut.id);
    const round = entry.retakeCount;
    writeYaml(path.join(bag.meta, 'prompt.yaml'), bundle);
    for (const role of requiredFrameRoles(cut)) {
      const count = cut.importance === 'key' ? 4 : 2;
      const candidates = [];
      for (let index = 0; index < count; index += 1) {
        const output = path.join(
          bag.keyframeCandidates,
          role,
          `round-${String(round).padStart(2, '0')}`,
          `candidate-${index + 1}.png`,
        );
        const roleInstruction =
          role === 'first' ? '画面是动作开始前的稳定构图' : '画面是动作完成后的稳定构图';
        const generated = await providers.image.generate({
          prompt: `${bundle.prompt}\nFRAME_ROLE: ${roleInstruction}`,
          negativePrompt: bundle.negativePrompt,
          referenceImages: bundle.referenceImages,
          width: 540,
          height: 960,
          seed: (role === 'first' ? 0 : 10_000) + index + 1,
          outputFile: output,
        });
        recordCost(store, episodeId, 'image', generated, 1, 'candidate', cut.id);
        const takeId = `${cut.id}_R${String(round).padStart(2, '0')}_KF_${role.toUpperCase()}_${String(index + 1).padStart(2, '0')}`;
        saveGenerationMeta(path.join(bag.meta, `${takeId}.yaml`), {
          takeId,
          cutId: cut.id,
          kind: 'keyframe',
          provider: generated.provider,
          model: generated.model,
          seed: (role === 'first' ? 0 : 10_000) + index + 1,
          prompt: `${bundle.prompt}\nFRAME_ROLE: ${roleInstruction}`,
          promptHash: hash(`${bundle.prompt}:${roleInstruction}`),
          referenceImages: bundle.referenceImages,
          outputFile: output,
          ...(generated.amountCny !== undefined
            ? { amountCny: generated.amountCny }
            : {}),
          createdAt: now(),
        });
        candidates.push({
          label: `${role === 'first' ? '首帧' : '尾帧'}候选 ${index + 1}`,
          file: output,
          metadata: `${generated.provider}/${generated.model}`,
        });
      }
      groups.push({
        id: `${cut.id}:${role}`,
        title: `${cut.id} · ${role === 'first' ? '首帧' : '尾帧'}`,
        note: `${cut.shotSize} / ${cut.genMode} / ${cut.durationSec.toFixed(2)}s · ${cut.action}`,
        candidates,
      });
    }
    store.transition(episodeId, cut.id, 'keyframes_ready');
  }
  const reviewFile = writeChoiceReview(
    path.join(store.paths.reviewDir(episodeId), 'gate-2-keyframes.html'),
    `关卡② 关键帧圈选 · ${episodeId}`,
    `amntv approve keyframes ${store.seriesId} ${episodeId}`,
    groups,
  );
  openReview(config, reviewFile);
  log(`关键帧审核页已生成: ${reviewFile}`);
}

export function approveKeyframes(
  store: ProjectStore,
  episodeId: string,
  picks: Record<string, number>,
): void {
  const storyboard = store.storyboard(episodeId);
  for (const cut of storyboard.cuts) {
    const entry = store.state(episodeId).cuts[cut.id];
    if (!entry) throw new Error(`${cut.id} 缺少状态记录`);
    if (
      ['keyframe_selected', 'video_ready', 'sakkan_pass', 'composited'].includes(
        entry.stage,
      )
    ) {
      continue;
    }
    if (entry.stage !== 'keyframes_ready') {
      throw new Error(`${cut.id} 尚未生成完整候选帧，当前状态 ${entry.stage}`);
    }
    const selected: string[] = [];
    for (const role of requiredFrameRoles(cut)) {
      const key = `${cut.id}:${role}`;
      const pick = picks[key];
      if (!pick || !Number.isInteger(pick) || pick < 1) {
        throw new Error(`缺少合法圈选: ${key}`);
      }
      const bag = store.paths.cut(episodeId, cut.id);
      const source = path.join(
        bag.keyframeCandidates,
        role,
        `round-${String(entry.retakeCount).padStart(2, '0')}`,
        `candidate-${pick}.png`,
      );
      if (!fs.existsSync(source)) throw new Error(`候选不存在: ${source}`);
      const target = path.join(bag.keyframeSelected, `${role}.png`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target);
      selected.push(target);
    }
    const state = store.state(episodeId);
    state.cuts[cut.id]!.selectedKeyframes = selected;
    store.saveState(state);
    store.transition(episodeId, cut.id, 'keyframe_selected');
  }
  const state = store.state(episodeId);
  state.gates.visual = approval('关卡②分镜与关键帧均已确认，视频生成 hard greenlight');
  store.saveState(state);
  log('关卡②已通过：视频生成解锁');
}

export function requestRetake(
  store: ProjectStore,
  episodeId: string,
  cutId: string,
  stage: 'keyframe' | 'video',
  instruction: string,
): void {
  const trimmed = instruction.trim();
  if (!trimmed) throw new Error('局部调整指令不能为空');
  const storyboard = store.storyboard(episodeId);
  const cut = storyboard.cuts.find((item) => item.id === cutId);
  if (!cut) throw new Error(`分镜中不存在卡 ${cutId}`);
  cut.promptDelta = [cut.promptDelta, `局部调整：${trimmed}`]
    .filter(Boolean)
    .join('；');
  store.saveStoryboard(storyboard);
  const round = store.resetCutForRetake(
    episodeId,
    cutId,
    stage === 'keyframe' ? 'audio_ready' : 'keyframe_selected',
    `${stage === 'keyframe' ? '关键帧' : '视频'}局部重做：${trimmed}`,
  );
  writeRetakeTicket(store, episodeId, cutId, trimmed, stage);
  log(
    `${cutId} 已进入第 ${round} 轮局部重做；下一步执行 ${stage === 'keyframe' ? 'keyframes' : 'generate'}`,
  );
}

function allOk(checks: ReadinessCheck[]): boolean {
  return checks.every((check) => check.ok);
}

function failedChecks(checks: ReadinessCheck[]): string {
  return checks
    .filter((check) => !check.ok)
    .map((check) => `[${check.key}] ${check.message}`)
    .join('；');
}

function classifyTransient(error: Error): boolean {
  return /\b(429|5\d\d|timeout|timed out|ECONNRESET|ENETUNREACH|fetch failed)\b/i.test(
    error.message,
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function taskStart(
  store: ProjectStore,
  episodeId: string,
  cutId: string,
  provider: string,
): string {
  const state = store.state(episodeId);
  const id = randomUUID();
  state.tasks.push({
    id,
    cutId,
    provider,
    kind: 'video',
    status: 'submitted',
    submittedAt: now(),
    updatedAt: now(),
  });
  store.saveState(state);
  return id;
}

function taskUpdate(
  store: ProjectStore,
  episodeId: string,
  taskId: string,
  status: 'polling' | 'success' | 'failed',
  providerTaskId?: string,
  error?: string,
): void {
  const state = store.state(episodeId);
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) throw new Error(`任务记录不存在: ${taskId}`);
  task.status = status;
  task.updatedAt = now();
  if (providerTaskId) task.providerTaskId = providerTaskId;
  if (error) task.error = error;
  store.saveState(state);
}

async function generateWithRetry(
  provider: VideoProvider,
  request: Parameters<VideoProvider['generate']>[0],
  onTask: (providerTaskId: string) => void,
): Promise<GenerationResult> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await provider.generate({ ...request, onSubmitted: onTask });
    } catch (caught) {
      const error = caught instanceof Error ? caught : new Error(String(caught));
      lastError = error;
      if (!classifyTransient(error) || attempt >= 3) break;
      await delay(2 ** attempt * 1_000);
    }
  }
  throw lastError ?? new Error('未知视频生成错误');
}

function writeRetakeTicket(
  store: ProjectStore,
  episodeId: string,
  cutId: string,
  instruction: string,
  stageToRedo: 'keyframe' | 'video' | 'composite',
): void {
  const bag = store.paths.cut(episodeId, cutId);
  fs.mkdirSync(bag.tickets, { recursive: true });
  writeYaml(path.join(bag.tickets, `${Date.now()}-retake.yaml`), {
    ticketId: randomUUID(),
    cutId,
    instruction,
    severity: 'B',
    stageToRedo,
    status: 'requested',
    createdAt: now(),
  });
}

async function fallbackStillPan(
  config: AppConfig,
  request: Parameters<VideoProvider['generate']>[0],
): Promise<GenerationResult> {
  return new StubVideoProvider(config).generate({
    ...request,
    mode: 'still_pan',
  });
}

export async function videoStage(
  config: AppConfig,
  store: ProjectStore,
  episodeId: string,
): Promise<void> {
  const providers: Providers = createProviders(config);
  const script = store.script(episodeId);
  const storyboard = store.storyboard(episodeId);
  for (const cut of storyboard.cuts) {
    const entry = store.state(episodeId).cuts[cut.id];
    if (!entry || entry.stage !== 'keyframe_selected') continue;
    const promptBundle = assemblePrompt(
      store.series(),
      sceneForCut(script, cut),
      cut,
      store.characters(),
      store.location(sceneForCut(script, cut).locationId),
    );
    const checks = videoReadiness(
      store,
      episodeId,
      cut,
      providers.video,
      promptBundle.prompt,
    );
    if (!allOk(checks)) {
      throw new Error(`${cut.id} readiness gate 拒绝: ${failedChecks(checks)}`);
    }
    store.transition(episodeId, cut.id, 'video_generating');
    const coverage = cut.importance === 'key' ? 2 : 1;
    const candidates: Array<{
      file: string;
      result: GenerationResult;
      score: number;
      pass: boolean;
    }> = [];
    for (let take = 1; take <= coverage; take += 1) {
      const bag = store.paths.cut(episodeId, cut.id);
      const takeId = `${cut.id}_R${String(entry.retakeCount).padStart(2, '0')}_T${String(take).padStart(2, '0')}`;
      const output = path.join(bag.clips, `${takeId}.mp4`);
      const taskId = taskStart(store, episodeId, cut.id, providers.video.name);
      let generated: GenerationResult;
      let degraded = false;
      try {
        generated = await generateWithRetry(
          providers.video,
          {
            prompt: `${promptBundle.prompt}\nMOTION: ${cut.action}`,
            mode: cut.genMode,
            frames: entry.selectedKeyframes,
            durationSec: cut.durationSec,
            outputFile: output,
          },
          (providerTaskId) =>
            taskUpdate(store, episodeId, taskId, 'polling', providerTaskId),
        );
        taskUpdate(store, episodeId, taskId, 'success');
      } catch (caught) {
        const error = caught instanceof Error ? caught : new Error(String(caught));
        taskUpdate(store, episodeId, taskId, 'failed', undefined, error.message);
        generated = await fallbackStillPan(config, {
          prompt: promptBundle.prompt,
          mode: 'still_pan',
          frames: entry.selectedKeyframes,
          durationSec: cut.durationSec,
          outputFile: output,
        });
        degraded = true;
        writeRetakeTicket(
          store,
          episodeId,
          cut.id,
          `云视频失败，已降级为本地 still_pan: ${error.message}`,
          'video',
        );
      }
      recordCost(store, episodeId, 'video', generated, cut.durationSec, 'second', cut.id);
      saveGenerationMeta(path.join(bag.meta, `${takeId}.yaml`), {
        takeId,
        cutId: cut.id,
        kind: 'video',
        provider: generated.provider,
        model: generated.model,
        prompt: `${promptBundle.prompt}\nMOTION: ${cut.action}`,
        promptHash: hash(`${promptBundle.prompt}\nMOTION: ${cut.action}`),
        referenceImages: entry.selectedKeyframes,
        outputFile: output,
        ...(generated.amountCny !== undefined
          ? { amountCny: generated.amountCny }
          : {}),
        createdAt: now(),
      });
      let score = 1;
      let pass = true;
      if (!config.dryRun && !degraded) {
        const inspectionFrame = path.join(bag.meta, `${takeId}-inspection.jpg`);
        await extractCover(config, output, inspectionFrame);
        const sakkan = await checkSakkan(config, {
          instruction:
            '请使用 Read 工具读取 inspectionFrame 和角色 turnaround 图片后再判断，不得仅凭文件名猜测。',
          inspectionFrame,
          characterReferences: cut.characters.map((appearance) => ({
            characterId: appearance.characterId,
            referenceImages:
              store.character(appearance.characterId)?.turnaround ?? [],
          })),
        });
        score = sakkan.identityScore;
        pass = sakkan.pass;
        writeYaml(path.join(bag.meta, `${takeId}-sakkan.yaml`), sakkan);
      }
      candidates.push({ file: output, result: generated, score, pass });
    }
    const selected =
      candidates
        .filter((candidate) => candidate.pass)
        .sort((a, b) => b.score - a.score)[0] ??
      candidates.sort((a, b) => b.score - a.score)[0];
    if (!selected || !selected.pass) {
      store.transition(episodeId, cut.id, 'failed');
      writeRetakeTicket(
        store,
        episodeId,
        cut.id,
        '所有 coverage take 均未通过作监，请重抽关键帧或简化动作',
        'keyframe',
      );
      continue;
    }
    store.transition(episodeId, cut.id, 'video_ready');
    const latest = store.state(episodeId);
    latest.cuts[cut.id]!.selectedVideo = selected.file;
    store.saveState(latest);
    store.transition(episodeId, cut.id, 'sakkan_pass');
  }
  const failed = storyboard.cuts.filter(
    (cut) => store.state(episodeId).cuts[cut.id]?.stage === 'failed',
  );
  if (failed.length) {
    throw new Error(`视频阶段有 ${failed.length} 卡失败: ${failed.map((cut) => cut.id).join(', ')}`);
  }
  log('视频 coverage 与作监检查完成');
}

export async function composeStage(
  config: AppConfig,
  store: ProjectStore,
  episodeId: string,
): Promise<void> {
  const script = store.script(episodeId);
  const storyboard = store.storyboard(episodeId);
  const state = store.state(episodeId);
  const notReady = storyboard.cuts.filter(
    (cut) => !['sakkan_pass', 'composited'].includes(state.cuts[cut.id]?.stage ?? ''),
  );
  if (notReady.length) {
    throw new Error(`以下卡尚未通过作监: ${notReady.map((cut) => cut.id).join(', ')}`);
  }
  const dialogue = dialogueLookup(script);
  const compositedFiles: string[] = [];
  for (const cut of storyboard.cuts) {
    const current = store.state(episodeId).cuts[cut.id]!;
    const output = path.join(store.paths.cut(episodeId, cut.id).root, 'composited.mp4');
    if (current.stage !== 'composited') {
      if (!current.selectedVideo || !fs.existsSync(current.selectedVideo)) {
        throw new Error(`${cut.id} 缺少圈选视频`);
      }
      const audioFiles = cut.dialogueIds
        .map((id) => dialogue.get(id)?.audio?.file)
        .filter((file): file is string => Boolean(file && fs.existsSync(file)));
      await composeCut(
        config,
        current.selectedVideo,
        audioFiles,
        cut.durationSec,
        output,
      );
      store.transition(episodeId, cut.id, 'composited');
    }
    compositedFiles.push(output);
  }
  const finalDir = store.paths.finalDir(episodeId);
  const rough = path.join(finalDir, 'rough.mp4');
  await concatCuts(config, compositedFiles, rough);
  const subtitles = writeSrt(
    storyboard.cuts,
    script,
    path.join(finalDir, `${episodeId}.srt`),
  );
  const finalVideo = path.join(finalDir, `${episodeId}.mp4`);
  await burnDelivery(
    config,
    rough,
    subtitles,
    finalVideo,
    store.series().spec.fps,
  );
  const cover = path.join(finalDir, 'cover.jpg');
  await extractCover(config, finalVideo, cover);
  const jianyingDraft = exportJianyingDraft(
    path.join(finalDir, 'jianying-draft'),
    storyboard.cuts,
    script,
    compositedFiles,
    subtitles,
  );
  const qc = await runDeliveryQc(
    config,
    store,
    episodeId,
    finalVideo,
    subtitles,
    cover,
    jianyingDraft,
  );
  exportQcReport(path.join(finalDir, 'qc-report.yaml'), qc);
  if (!qc.pass) throw new Error(`交付 QC 未通过:\n${qcReportText(qc)}`);
  const latest = store.state(episodeId);
  latest.delivery = {
    finalVideo,
    subtitles,
    cover,
    aigcLabel: 'burned',
    jianyingDraft,
    durationSec: (await probeMedia(config, finalVideo)).durationSec,
    qcPassedAt: now(),
  };
  store.saveState(latest);
  const reviewFile = writeChoiceReview(
    path.join(store.paths.reviewDir(episodeId), 'gate-3-final.html'),
    `关卡③ 成片确认 · ${episodeId}`,
    `amntv approve final ${store.seriesId} ${episodeId}`,
    [
      {
        id: `${episodeId}:final`,
        title: `${episodeId} · ${script.title}`,
        note: qcReportText(qc).replaceAll('\n', ' | '),
        candidates: [
          {
            label: '最终成片',
            file: finalVideo,
            metadata: `${latest.delivery.durationSec.toFixed(2)}s · 1080×1920`,
          },
        ],
      },
    ],
  );
  openReview(config, reviewFile);
  log(`成片与 QC 已生成: ${finalVideo}`);
}

export function approveFinal(store: ProjectStore, episodeId: string): void {
  const state = store.state(episodeId);
  if (!state.delivery) throw new Error('尚无通过自动 QC 的交付物');
  const stateFile = path.join(store.paths.finalDir(episodeId), 'qc-report.yaml');
  const qc = YAML.parse(fs.readFileSync(stateFile, 'utf8')) as { pass?: boolean };
  if (!qc.pass) throw new Error('自动 QC 未通过，不能批准成片');
  state.gates.final = approval('成片已人工确认，picture lock');
  store.saveState(state);
  log('关卡③已通过：成片 picture lock');
}

export function statusReport(store: ProjectStore, episodeId: string): string {
  const state = store.state(episodeId);
  const labels: Array<[keyof EpisodeState['gates'], string]> = [
    ['script', '① 剧本确认'],
    ['cast', '⓪ 定妆锁定'],
    ['visual', '② 分镜+关键帧'],
    ['final', '③ 成片确认'],
  ];
  const gates = labels.map(([key, label]) => {
    const value = state.gates[key];
    return `${value ? '✓' : '○'} ${label}${value ? ` · ${value.at}` : ''}`;
  });
  const counts = new Map<string, number>();
  for (const entry of Object.values(state.cuts)) {
    counts.set(entry.stage, (counts.get(entry.stage) ?? 0) + 1);
  }
  const stages = [...counts].map(([stage, count]) => `${stage}: ${count}`).join(' · ');
  const orphaned = state.tasks.filter((task) => task.status === 'orphaned').length;
  return [
    `系列 ${store.seriesId} / ${episodeId}`,
    ...gates,
    `卡状态：${stages || '尚无'}`,
    `孤儿视频任务：${orphaned}`,
    state.delivery
      ? `交付：${state.delivery.finalVideo} (${state.delivery.durationSec.toFixed(2)}s)`
      : '交付：尚未生成',
  ].join('\n');
}

export function costReport(store: ProjectStore, episodeId: string): string {
  const state = store.state(episodeId);
  const known = state.costLedger.filter((entry) => entry.amountCny !== undefined);
  const total = known.reduce((sum, entry) => sum + (entry.amountCny ?? 0), 0);
  const unknown = state.costLedger.length - known.length;
  const byProvider = new Map<string, { calls: number; amount: number; unknown: number }>();
  for (const entry of state.costLedger) {
    const row = byProvider.get(entry.provider) ?? { calls: 0, amount: 0, unknown: 0 };
    row.calls += 1;
    if (entry.amountCny === undefined) row.unknown += 1;
    else row.amount += entry.amountCny;
    byProvider.set(entry.provider, row);
  }
  const cuts = Math.max(1, Object.keys(state.cuts).length);
  const draws = state.costLedger.filter((entry) => entry.kind === 'image').length;
  const durationMinutes = (state.delivery?.durationSec ?? 0) / 60;
  return [
    `已知成本：¥${total.toFixed(2)}${unknown ? `；${unknown} 笔供应商价格未知，未伪造估价` : ''}`,
    ...[...byProvider].map(
      ([provider, row]) =>
        `${provider}: ${row.calls} 次 / ¥${row.amount.toFixed(2)}${row.unknown ? ` / ${row.unknown} 笔未知` : ''}`,
    ),
    `抽卡次数/镜头：${(draws / cuts).toFixed(2)}（目标 ≤4）`,
    durationMinutes > 0
      ? `已知成本/分钟：¥${(total / durationMinutes).toFixed(2)}`
      : '已知成本/分钟：成片后计算',
  ].join('\n');
}

export function reviewPath(
  store: ProjectStore,
  episodeId: string,
  gate: 'script' | 'cast' | 'storyboard' | 'keyframes' | 'final',
): string {
  const names = {
    script: 'gate-1-script.html',
    cast: 'gate-0-cast.html',
    storyboard: 'gate-2-storyboard.html',
    keyframes: 'gate-2-keyframes.html',
    final: 'gate-3-final.html',
  };
  return path.join(store.paths.reviewDir(episodeId), names[gate]);
}
