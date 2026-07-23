import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import {
  CharacterSchema,
  EpisodeStateSchema,
  LocationSchema,
  ScriptSchema,
  SeriesSchema,
  StoryboardSchema,
  type Character,
  type Cut,
  type CutStage,
  type EpisodeState,
  type Location,
  type Script,
  type Series,
  type Storyboard,
} from './domain.js';
import { ProjectPaths } from './paths.js';

function readYaml(file: string): unknown {
  return YAML.parse(fs.readFileSync(file, 'utf8'));
}

export function writeYaml(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, YAML.stringify(value, { lineWidth: 120 }), 'utf8');
  fs.renameSync(temp, file);
}

function orderedSubsequence(before: string[], after: string[]): boolean {
  let cursor = 0;
  for (const item of after) {
    if (item === before[cursor]) cursor += 1;
  }
  return cursor === before.length;
}

function assertLockedScriptIdsStable(previous: Script, next: Script): void {
  if (previous.status !== 'locked') return;
  if (next.status !== 'locked') throw new Error('锁定剧本不能退回 draft');
  const oldScenes = previous.scenes.map((scene) => scene.id);
  const newScenes = next.scenes.map((scene) => scene.id);
  if (!orderedSubsequence(oldScenes, newScenes)) {
    throw new Error('锁定后既有场号不可删除或重排；删除场请保留并标记 omitted，插入场使用字母后缀');
  }
  for (const oldScene of previous.scenes) {
    const newScene = next.scenes.find((scene) => scene.id === oldScene.id);
    if (!newScene) throw new Error(`锁定场 ${oldScene.id} 不可删除`);
    const oldDialogue = oldScene.dialogue.map((line) => line.id);
    const newDialogue = newScene.dialogue.map((line) => line.id);
    if (!orderedSubsequence(oldDialogue, newDialogue)) {
      throw new Error(`锁定场 ${oldScene.id} 的既有台词 ID 不可删除或重排`);
    }
  }
}

function scriptChanges(
  previous: Script,
  next: Script,
): { changed: boolean; global: boolean; sceneIds: Set<string> } {
  const previousGlobal = {
    title: previous.title,
    emotionContract: previous.emotionContract,
  };
  const nextGlobal = {
    title: next.title,
    emotionContract: next.emotionContract,
  };
  const global = JSON.stringify(previousGlobal) !== JSON.stringify(nextGlobal);
  const sceneIds = new Set<string>();
  const ids = new Set([
    ...previous.scenes.map((scene) => scene.id),
    ...next.scenes.map((scene) => scene.id),
    ...previous.manifests.map((manifest) => manifest.sceneId),
    ...next.manifests.map((manifest) => manifest.sceneId),
  ]);
  for (const id of ids) {
    const stripAudio = (script: Script) => {
      const scene = script.scenes.find((item) => item.id === id);
      if (!scene) return undefined;
      return {
        ...scene,
        dialogue: scene.dialogue.map(({ audio: _audio, ...line }) => line),
      };
    };
    const before = {
      scene: stripAudio(previous),
      manifest: previous.manifests.find((item) => item.sceneId === id),
    };
    const after = {
      scene: stripAudio(next),
      manifest: next.manifests.find((item) => item.sceneId === id),
    };
    if (JSON.stringify(before) !== JSON.stringify(after)) sceneIds.add(id);
  }
  return { changed: global || sceneIds.size > 0, global, sceneIds };
}

function changedStoryboardCuts(previous: Storyboard, next: Storyboard): Set<string> {
  const changed = new Set<string>();
  const ids = new Set([
    ...previous.cuts.map((cut) => cut.id),
    ...next.cuts.map((cut) => cut.id),
  ]);
  for (const id of ids) {
    const before = previous.cuts.find((cut) => cut.id === id);
    const after = next.cuts.find((cut) => cut.id === id);
    if (JSON.stringify(before) !== JSON.stringify(after)) changed.add(id);
  }
  return changed;
}

const transitions: Record<CutStage, CutStage[]> = {
  pending: ['audio_ready'],
  audio_ready: ['keyframes_ready'],
  keyframes_ready: ['keyframe_selected'],
  keyframe_selected: ['video_generating'],
  video_generating: ['video_ready', 'failed'],
  video_ready: ['sakkan_pass', 'failed'],
  sakkan_pass: ['composited', 'failed'],
  composited: ['failed'],
  failed: ['keyframes_ready', 'video_generating'],
};

export class ProjectStore {
  readonly paths: ProjectPaths;

  constructor(
    projectsRoot: string,
    readonly seriesId: string,
  ) {
    this.paths = new ProjectPaths(projectsRoot, seriesId);
  }

  hasSeries(): boolean {
    return fs.existsSync(this.paths.seriesFile);
  }

  series(): Series {
    return SeriesSchema.parse(readYaml(this.paths.seriesFile));
  }

  saveSeries(value: Series): void {
    writeYaml(this.paths.seriesFile, SeriesSchema.parse(value));
  }

  characters(): Character[] {
    if (!fs.existsSync(this.paths.charactersDir)) return [];
    return fs
      .readdirSync(this.paths.charactersDir)
      .map((id) => this.paths.characterFile(id))
      .filter((file) => fs.existsSync(file))
      .map((file) => CharacterSchema.parse(readYaml(file)));
  }

  character(id: string): Character | undefined {
    const file = this.paths.characterFile(id);
    return fs.existsSync(file) ? CharacterSchema.parse(readYaml(file)) : undefined;
  }

  saveCharacter(value: Character, allowLockedUpdate = false): void {
    const next = CharacterSchema.parse(value);
    const existing = this.character(next.id);
    if (existing?.status === 'locked' && !allowLockedUpdate) {
      const comparableExisting = { ...existing, lockedAt: undefined };
      const comparableNext = { ...next, lockedAt: undefined };
      if (JSON.stringify(comparableExisting) !== JSON.stringify(comparableNext)) {
        throw new Error(`角色 ${next.id} 已锁定；修改需显式解锁并使下游产物失效`);
      }
    }
    writeYaml(this.paths.characterFile(next.id), next);
  }

  locations(): Location[] {
    if (!fs.existsSync(this.paths.locationsDir)) return [];
    return fs
      .readdirSync(this.paths.locationsDir)
      .map((id) => this.paths.locationFile(id))
      .filter((file) => fs.existsSync(file))
      .map((file) => LocationSchema.parse(readYaml(file)));
  }

  location(id: string): Location | undefined {
    const file = this.paths.locationFile(id);
    return fs.existsSync(file) ? LocationSchema.parse(readYaml(file)) : undefined;
  }

  saveLocation(value: Location, allowLockedUpdate = false): void {
    const next = LocationSchema.parse(value);
    const existing = this.location(next.id);
    if (existing?.status === 'locked' && !allowLockedUpdate) {
      const comparableExisting = { ...existing, lockedAt: undefined };
      const comparableNext = { ...next, lockedAt: undefined };
      if (JSON.stringify(comparableExisting) !== JSON.stringify(comparableNext)) {
        throw new Error(`场景 ${next.id} 已锁定；修改需显式解锁并使下游产物失效`);
      }
    }
    writeYaml(this.paths.locationFile(next.id), next);
  }

  script(episodeId: string): Script {
    return ScriptSchema.parse(readYaml(this.paths.scriptFile(episodeId)));
  }

  saveScript(value: Script): void {
    const next = ScriptSchema.parse(value);
    const file = this.paths.scriptFile(next.episodeId);
    let changes:
      | { changed: boolean; global: boolean; sceneIds: Set<string> }
      | undefined;
    if (fs.existsSync(file)) {
      const previous = ScriptSchema.parse(readYaml(file));
      assertLockedScriptIdsStable(previous, next);
      if (previous.status === 'locked') changes = scriptChanges(previous, next);
    }
    writeYaml(file, next);
    if (changes?.changed) {
      this.invalidateAfterScriptChange(next.episodeId, changes);
    }
  }

  storyboard(episodeId: string): Storyboard {
    return StoryboardSchema.parse(readYaml(this.paths.storyboardFile(episodeId)));
  }

  saveStoryboard(
    value: Storyboard,
    options: { preserveApproval?: boolean } = {},
  ): void {
    let next = StoryboardSchema.parse(value);
    const file = this.paths.storyboardFile(next.episodeId);
    let changedCutIds = new Set<string>();
    let approvalRevoked = false;
    if (fs.existsSync(file)) {
      const old = StoryboardSchema.parse(readYaml(file));
      if (old.status === 'approved') {
        const oldIds = old.cuts.map((cut) => cut.id);
        const nextIds = next.cuts.map((cut) => cut.id);
        if (!orderedSubsequence(oldIds, nextIds)) {
          throw new Error('批准后的既有卡号不可删除或重排；插卡请使用字母后缀');
        }
        changedCutIds = changedStoryboardCuts(old, next);
        const explicitlyDrafted = next.status !== 'approved';
        if (
          !options.preserveApproval &&
          (changedCutIds.size > 0 || explicitlyDrafted)
        ) {
          next = { ...next, status: 'draft' };
          delete next.approvedAt;
          approvalRevoked = true;
        }
      }
    }
    writeYaml(file, next);
    if (approvalRevoked) {
      this.invalidateAfterStoryboardChange(next.episodeId, changedCutIds);
    }
  }

  private invalidateAfterScriptChange(
    episodeId: string,
    changes: { global: boolean; sceneIds: Set<string> },
  ): void {
    const storyboardFile = this.paths.storyboardFile(episodeId);
    let storyboard: Storyboard | undefined;
    if (fs.existsSync(storyboardFile)) {
      storyboard = StoryboardSchema.parse(readYaml(storyboardFile));
      if (storyboard.status === 'approved') {
        const draft = { ...storyboard, status: 'draft' as const };
        delete draft.approvedAt;
        writeYaml(storyboardFile, draft);
        storyboard = draft;
      }
    }
    const stateFile = this.paths.stateFile(episodeId);
    if (!fs.existsSync(stateFile)) return;
    const state = this.state(episodeId);
    const affectedCutIds = changes.global
      ? new Set(Object.keys(state.cuts))
      : new Set(
          storyboard?.cuts
            .filter((cut) => changes.sceneIds.has(cut.sceneId))
            .map((cut) => cut.id) ?? [],
        );
    const reason = changes.global
      ? '剧本全局信息变更'
      : `剧本场景变更：${[...changes.sceneIds].join('、')}`;
    this.resetAffectedCuts(state, affectedCutIds, reason);
    delete state.gates.script;
    delete state.gates.storyboard;
    delete state.gates.visual;
    delete state.gates.final;
    delete state.delivery;
    this.saveState(state);
  }

  private invalidateAfterStoryboardChange(
    episodeId: string,
    changedCutIds: Set<string>,
  ): void {
    const stateFile = this.paths.stateFile(episodeId);
    if (!fs.existsSync(stateFile)) return;
    const state = this.state(episodeId);
    this.resetAffectedCuts(state, changedCutIds, '分镜内容变更');
    delete state.gates.storyboard;
    delete state.gates.visual;
    delete state.gates.final;
    delete state.delivery;
    this.saveState(state);
  }

  private resetAffectedCuts(
    state: EpisodeState,
    cutIds: Set<string>,
    reason: string,
  ): void {
    const at = new Date().toISOString();
    for (const cutId of cutIds) {
      const entry = state.cuts[cutId];
      if (!entry) continue;
      entry.stage = 'pending';
      entry.updatedAt = at;
      entry.selectedKeyframes = [];
      delete entry.selectedVideo;
      if (!entry.staleReasons.includes(reason)) entry.staleReasons.push(reason);
    }
  }

  state(episodeId: string): EpisodeState {
    const file = this.paths.stateFile(episodeId);
    if (!fs.existsSync(file)) {
      const initial: EpisodeState = {
        episodeId,
        gates: {},
        cuts: {},
        tasks: [],
        costLedger: [],
      };
      this.saveState(initial);
      return initial;
    }
    return EpisodeStateSchema.parse(readYaml(file));
  }

  saveState(value: EpisodeState): void {
    writeYaml(this.paths.stateFile(value.episodeId), EpisodeStateSchema.parse(value));
  }

  initCuts(episodeId: string, cuts: Cut[]): void {
    const state = this.state(episodeId);
    for (const cut of cuts) {
      state.cuts[cut.id] ??= {
        stage: 'pending',
        updatedAt: new Date().toISOString(),
        selectedKeyframes: [],
        retakeCount: 0,
        staleReasons: [],
      };
    }
    this.saveState(state);
  }

  transition(episodeId: string, cutId: string, to: CutStage): void {
    const state = this.state(episodeId);
    const entry = state.cuts[cutId];
    if (!entry) throw new Error(`状态表不存在卡 ${cutId}`);
    if (entry.stage === to) return;
    if (!transitions[entry.stage].includes(to)) {
      throw new Error(
        `非法状态流转 ${cutId}: ${entry.stage} → ${to}；允许: ${transitions[entry.stage].join(', ') || '无'}`,
      );
    }
    entry.stage = to;
    entry.updatedAt = new Date().toISOString();
    this.saveState(state);
  }

  recoverOrphanedVideoTasks(episodeId: string): number {
    const state = this.state(episodeId);
    let changed = 0;
    for (const task of state.tasks) {
      if (
        task.kind === 'video' &&
        (task.status === 'submitted' || task.status === 'polling')
      ) {
        task.status = 'orphaned';
        task.updatedAt = new Date().toISOString();
        task.error = '进程重启后不自动重提视频任务，避免供应商重复扣费';
        const cut = state.cuts[task.cutId];
        if (cut?.stage === 'video_generating') {
          cut.stage = 'failed';
          cut.updatedAt = task.updatedAt;
        }
        changed += 1;
      }
    }
    if (changed) this.saveState(state);
    return changed;
  }

  resetCutForRetake(
    episodeId: string,
    cutId: string,
    target: 'audio_ready' | 'keyframe_selected',
    reason: string,
  ): number {
    const state = this.state(episodeId);
    const entry = state.cuts[cutId];
    if (!entry) throw new Error(`状态表不存在卡 ${cutId}`);
    const activeTask = state.tasks.find(
      (task) =>
        task.cutId === cutId &&
        task.kind === 'video' &&
        ['submitted', 'polling'].includes(task.status),
    );
    if (activeTask) {
      throw new Error(
        `${cutId} 仍有视频任务 ${activeTask.id} 在运行；先等待，或执行 recover 标记孤儿任务`,
      );
    }
    if (target === 'keyframe_selected' && entry.selectedKeyframes.length === 0) {
      throw new Error(`${cutId} 没有已圈选关键帧，不能只重做视频`);
    }
    entry.stage = target;
    entry.updatedAt = new Date().toISOString();
    entry.retakeCount += 1;
    if (!entry.staleReasons.includes(reason)) entry.staleReasons.push(reason);
    if (target === 'audio_ready') {
      entry.selectedKeyframes = [];
      delete state.gates.visual;
    }
    delete entry.selectedVideo;
    delete state.gates.final;
    delete state.delivery;
    this.saveState(state);
    return entry.retakeCount;
  }
}
