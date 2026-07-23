import fs from 'node:fs';
import type {
  Character,
  Cut,
  ReadinessCheck,
  Script,
  Series,
  Storyboard,
} from '../domain.js';
import type { ProjectStore } from '../store.js';
import type { VideoProvider } from '../providers/types.js';

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

function result(errors: string[]): ValidationResult {
  return { ok: errors.length === 0, errors };
}

function visibleLength(text: string): number {
  return [...text.replace(/\s|\p{P}/gu, '')].length;
}

export function validateScript(script: Script): ValidationResult {
  const errors: string[] = [];
  const sceneIds = new Set<string>();
  const dialogueIds = new Set<string>();
  for (const scene of script.scenes) {
    if (sceneIds.has(scene.id)) errors.push(`重复场号 ${scene.id}`);
    sceneIds.add(scene.id);
    for (const line of scene.dialogue) {
      if (dialogueIds.has(line.id)) errors.push(`重复台词 ID ${line.id}`);
      dialogueIds.add(line.id);
      if (
        (line.kind === 'dialogue' || line.kind === 'narration') &&
        visibleLength(line.text) > 15
      ) {
        errors.push(`${scene.id}/${line.id} 超过 15 字: ${line.text}`);
      }
      if (line.kind === 'dialogue' && !line.speakerId) {
        errors.push(`${scene.id}/${line.id} 是 dialogue 但缺少 speakerId`);
      }
      if (line.kind !== 'dialogue' && line.speakerId) {
        errors.push(`${scene.id}/${line.id} 非对白却设置了 speakerId`);
      }
    }
  }
  return result(errors);
}

function dialogueMap(script: Script): Map<string, { sceneId: string; kind: string }> {
  return new Map(
    script.scenes.flatMap((scene) =>
      scene.dialogue.map((line) => [
        line.id,
        { sceneId: scene.id, kind: line.kind },
      ] as const),
    ),
  );
}

export function validateStoryboard(
  series: Series,
  script: Script,
  storyboard: Storyboard,
): ValidationResult {
  const errors: string[] = [];
  const [minCuts, maxCuts] = series.spec.targetCuts;
  if (storyboard.cuts.length < minCuts || storyboard.cuts.length > maxCuts) {
    errors.push(`镜头数 ${storyboard.cuts.length} 不在 ${minCuts}–${maxCuts}`);
  }
  const total = storyboard.cuts.reduce((sum, cut) => sum + cut.durationSec, 0);
  const [minDuration, maxDuration] = series.spec.episodeDurationSec;
  if (total < minDuration || total > maxDuration) {
    errors.push(`分镜总时长 ${total.toFixed(2)}s 不在 ${minDuration}–${maxDuration}s`);
  }
  const knownScenes = new Set(script.scenes.map((scene) => scene.id));
  const knownDialogue = dialogueMap(script);
  const coverage = new Map<string, string[]>();
  const cutIds = new Set<string>();
  for (const cut of storyboard.cuts) {
    if (cutIds.has(cut.id)) errors.push(`重复卡号 ${cut.id}`);
    cutIds.add(cut.id);
    if (!knownScenes.has(cut.sceneId)) errors.push(`${cut.id} 引用了未知场 ${cut.sceneId}`);
    for (const dialogueId of cut.dialogueIds) {
      const line = knownDialogue.get(dialogueId);
      if (!line) {
        errors.push(`${cut.id} 引用了未知台词 ${dialogueId}`);
        continue;
      }
      if (line.sceneId !== cut.sceneId) {
        errors.push(`${cut.id} 的 ${dialogueId} 属于 ${line.sceneId}`);
      }
      (coverage.get(dialogueId) ?? coverage.set(dialogueId, []).get(dialogueId)!).push(cut.id);
    }
  }
  for (const [dialogueId, line] of knownDialogue) {
    if (!['dialogue', 'narration'].includes(line.kind)) continue;
    const cuts = coverage.get(dialogueId) ?? [];
    if (cuts.length !== 1) {
      errors.push(
        `${dialogueId} 必须被恰好一张卡覆盖，当前 ${cuts.length} 次${cuts.length ? ` (${cuts.join(',')})` : ''}`,
      );
    }
  }
  return result(errors);
}

export function referencedAssets(
  script: Script,
  storyboard?: Storyboard,
): { characterIds: string[]; locationIds: string[] } {
  const characterIds = new Set<string>();
  const locationIds = new Set<string>();
  for (const scene of script.scenes) {
    locationIds.add(scene.locationId);
    for (const line of scene.dialogue) {
      if (line.speakerId) characterIds.add(line.speakerId);
    }
  }
  for (const manifest of script.manifests) {
    manifest.characters.forEach((id) => characterIds.add(id));
    manifest.locations.forEach((id) => locationIds.add(id));
  }
  for (const cut of storyboard?.cuts ?? []) {
    cut.characters.forEach((item) => characterIds.add(item.characterId));
  }
  return {
    characterIds: [...characterIds],
    locationIds: [...locationIds],
  };
}

export function validateAssetsLocked(
  store: ProjectStore,
  script: Script,
  storyboard?: Storyboard,
): ValidationResult {
  const errors: string[] = [];
  const assets = referencedAssets(script, storyboard);
  for (const id of assets.characterIds) {
    const value = store.character(id);
    if (!value) errors.push(`缺少角色资产 ${id}`);
    else if (value.status !== 'locked') errors.push(`角色资产 ${id} 未锁定`);
  }
  for (const id of assets.locationIds) {
    const value = store.location(id);
    if (!value) errors.push(`缺少场景资产 ${id}`);
    else if (value.status !== 'locked') errors.push(`场景资产 ${id} 未锁定`);
  }
  return result(errors);
}

function requiredFrameCount(cut: Cut): number {
  return cut.genMode === 'first_last' || cut.genMode === 'multi_frame' ? 2 : 1;
}

export function videoReadiness(
  store: ProjectStore,
  episodeId: string,
  cut: Cut,
  provider: VideoProvider,
  prompt: string,
): ReadinessCheck[] {
  const state = store.state(episodeId);
  const script = store.script(episodeId);
  const storyboard = store.storyboard(episodeId);
  const assetValidation = validateAssetsLocked(store, script, storyboard);
  const entry = state.cuts[cut.id];
  const frames = entry?.selectedKeyframes.filter((file) => fs.existsSync(file)) ?? [];
  const providerState = provider.status();
  return [
    {
      key: 'script_locked',
      ok: Boolean(state.gates.script),
      message: '关卡①剧本尚未确认',
    },
    {
      key: 'assets_locked',
      ok: Boolean(state.gates.cast) && assetValidation.ok,
      message: assetValidation.errors.join('；') || '关卡⓪定妆尚未确认',
    },
    {
      key: 'storyboard_approved',
      ok: Boolean(state.gates.storyboard),
      message: '关卡②的分镜部分尚未批准',
    },
    {
      key: 'keyframes_approved',
      ok: Boolean(state.gates.visual),
      message: '关卡②的关键帧部分尚未圈选',
    },
    {
      key: 'duration_ready',
      ok: cut.durationSec > 0,
      message: '音频时长尚未回填',
    },
    {
      key: 'prompt_ready',
      ok: prompt.trim().length > 0 && prompt.length <= provider.promptLimit,
      message: `prompt 为空或超过供应商上限 ${provider.promptLimit}`,
    },
    {
      key: 'reference_frames_ready',
      ok: frames.length >= requiredFrameCount(cut),
      message: `${cut.genMode} 需要 ${requiredFrameCount(cut)} 张圈选帧，当前 ${frames.length}`,
    },
    {
      key: 'provider_ready',
      ok: providerState.ready,
      message: providerState.message,
    },
    {
      key: 'provider_mode',
      ok: provider.supports(cut.genMode),
      message: `${provider.name} 不支持 ${cut.genMode}`,
    },
    {
      key: 'no_active_task',
      ok: !state.tasks.some(
        (task) =>
          task.cutId === cut.id &&
          task.kind === 'video' &&
          ['submitted', 'polling'].includes(task.status),
      ),
      message: '该卡已有进行中的视频任务',
    },
  ];
}

export function assertValid(value: ValidationResult, label: string): void {
  if (!value.ok) throw new Error(`${label}未通过:\n- ${value.errors.join('\n- ')}`);
}

export function lockedCharacters(characters: Character[]): Character[] {
  return characters.filter((character) => character.status === 'locked');
}
