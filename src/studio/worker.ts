import type { AppConfig } from '../config.js';
import {
  audioStage,
  castingStage,
  composeStage,
  keyframeStage,
  scriptStage,
  storyboardStage,
  videoStage,
} from '../pipeline/index.js';
import { ProjectStore } from '../store.js';
import type { StudioDatabase, StudioJob, StudioJobType } from './db.js';
import type { StudioEvents } from './events.js';

function estimateProgress(
  config: AppConfig,
  job: StudioJob,
): { progress: number; message: string } {
  const store = new ProjectStore(config.projectsRoot, job.seriesId);
  if (job.type === 'script') {
    return { progress: 35, message: '编剧与监督 Agent 正在工作' };
  }
  if (job.type === 'cast') {
    const assets = [...store.characters(), ...store.locations()];
    const ready = assets.filter((asset) => asset.status !== 'draft').length;
    return {
      progress: 10 + (ready / Math.max(1, assets.length)) * 80,
      message: `正在生成定妆候选 ${ready}/${assets.length}`,
    };
  }
  let storyboard;
  try {
    storyboard = store.storyboard(job.episodeId);
  } catch {
    return { progress: 15, message: '正在准备分镜数据' };
  }
  if (job.type === 'storyboard') {
    return { progress: 45, message: '分镜 Agent 正在绘制镜头表' };
  }
  const state = store.state(job.episodeId);
  const total = Math.max(1, storyboard.cuts.length);
  const stageDone = (type: StudioJobType, stage: string): boolean => {
    const order = [
      'pending',
      'audio_ready',
      'keyframes_ready',
      'keyframe_selected',
      'video_generating',
      'video_ready',
      'sakkan_pass',
      'composited',
    ];
    const current = order.indexOf(stage);
    if (type === 'audio') return current >= order.indexOf('audio_ready');
    if (type === 'keyframes') {
      return current >= order.indexOf('keyframes_ready');
    }
    if (type === 'video') return current >= order.indexOf('sakkan_pass');
    if (type === 'compose') return stage === 'composited';
    return false;
  };
  const done = storyboard.cuts.filter((cut) =>
    stageDone(job.type, state.cuts[cut.id]?.stage ?? 'pending'),
  ).length;
  const labels: Partial<Record<StudioJobType, string>> = {
    audio: '正在配音并回填时长',
    keyframes: '正在生成关键帧候选',
    video: '正在生成视频并执行作监检查',
    compose: '正在合成卡片与成片',
  };
  return {
    progress: 8 + (done / total) * 86,
    message: `${labels[job.type] ?? '正在执行'} ${done}/${total}`,
  };
}

export class PipelineWorker {
  private timer: NodeJS.Timeout | undefined;
  private active = false;

  constructor(
    private readonly config: AppConfig,
    private readonly database: StudioDatabase,
    private readonly events: StudioEvents,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), 500);
    this.timer.unref();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async tick(): Promise<void> {
    if (this.active) return;
    const job = this.database.claimNext();
    if (!job) return;
    this.active = true;
    this.events.broadcast('job', job);
    const heartbeat = setInterval(() => {
      try {
        const progress = estimateProgress(this.config, job);
        this.events.broadcast(
          'job',
          this.database.updateProgress(job.id, progress.progress, progress.message),
        );
      } catch {
        // The stage may be between atomic file writes. The next heartbeat retries.
      }
    }, 750);
    try {
      await this.execute(job);
      const completed = this.database.succeed(job.id);
      this.events.broadcast('job', completed);
      this.events.broadcast('workspace', {
        seriesId: job.seriesId,
        episodeId: job.episodeId,
      });
    } catch (caught) {
      const error = caught instanceof Error ? caught : new Error(String(caught));
      this.events.broadcast('job', this.database.fail(job.id, error.message));
    } finally {
      clearInterval(heartbeat);
      this.active = false;
      queueMicrotask(() => void this.tick());
    }
  }

  private async execute(job: StudioJob): Promise<void> {
    const store = new ProjectStore(this.config.projectsRoot, job.seriesId);
    switch (job.type) {
      case 'script': {
        const outline = job.payload.outline;
        if (typeof outline !== 'string' || !outline.trim()) {
          throw new Error('剧本任务缺少 outline');
        }
        await scriptStage(this.config, store, job.episodeId, outline);
        return;
      }
      case 'cast':
        await castingStage(this.config, store, job.episodeId);
        return;
      case 'storyboard':
        await storyboardStage(this.config, store, job.episodeId);
        return;
      case 'audio':
        await audioStage(this.config, store, job.episodeId);
        return;
      case 'keyframes':
        await keyframeStage(this.config, store, job.episodeId);
        return;
      case 'video':
        await videoStage(this.config, store, job.episodeId);
        return;
      case 'compose':
        await composeStage(this.config, store, job.episodeId);
    }
  }
}
