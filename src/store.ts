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

  saveLocation(value: Location): void {
    writeYaml(this.paths.locationFile(value.id), LocationSchema.parse(value));
  }

  script(episodeId: string): Script {
    return ScriptSchema.parse(readYaml(this.paths.scriptFile(episodeId)));
  }

  saveScript(value: Script): void {
    const next = ScriptSchema.parse(value);
    const file = this.paths.scriptFile(next.episodeId);
    if (fs.existsSync(file)) {
      assertLockedScriptIdsStable(ScriptSchema.parse(readYaml(file)), next);
    }
    writeYaml(file, next);
  }

  storyboard(episodeId: string): Storyboard {
    return StoryboardSchema.parse(readYaml(this.paths.storyboardFile(episodeId)));
  }

  saveStoryboard(value: Storyboard): void {
    const next = StoryboardSchema.parse(value);
    const file = this.paths.storyboardFile(next.episodeId);
    if (fs.existsSync(file)) {
      const old = StoryboardSchema.parse(readYaml(file));
      if (old.status === 'approved') {
        const oldIds = old.cuts.map((cut) => cut.id);
        const nextIds = next.cuts.map((cut) => cut.id);
        if (!orderedSubsequence(oldIds, nextIds)) {
          throw new Error('批准后的既有卡号不可删除或重排；插卡请使用字母后缀');
        }
      }
    }
    writeYaml(file, next);
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
