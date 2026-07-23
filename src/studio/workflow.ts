import type { StudioJob, StudioJobType } from './db.js';
import type { ProjectStore } from '../store.js';

type WorkflowStatus =
  | 'complete'
  | 'active'
  | 'ready'
  | 'blocked'
  | 'optional';

interface WorkflowStage {
  id: string;
  code: string;
  label: string;
  detail: string;
  status: WorkflowStatus;
  progress: number;
  blockers: string[];
  optional: boolean;
  action: {
    kind: 'open' | 'job';
    label: string;
    tab: string;
    jobType?: StudioJobType;
  };
}

const cutOrder = [
  'pending',
  'audio_ready',
  'keyframes_ready',
  'keyframe_selected',
  'video_generating',
  'video_ready',
  'sakkan_pass',
  'composited',
] as const;

function atLeast(stage: string | undefined, target: string): boolean {
  return cutOrder.indexOf(stage as (typeof cutOrder)[number]) >= cutOrder.indexOf(
    target as (typeof cutOrder)[number],
  );
}

function stage(
  value: Omit<WorkflowStage, 'progress'> & { progress?: number },
): WorkflowStage {
  return { ...value, progress: Math.round(value.progress ?? 0) };
}

export function workflowView(
  store: ProjectStore,
  episodeId: string,
  jobs: StudioJob[],
  libTvSessions: Array<{ status: string }>,
  evaluations: Array<{ stale: boolean; scope: string }>,
) {
  const script = store.script(episodeId);
  const storyboard = store.storyboard(episodeId);
  const state = store.state(episodeId);
  const entries = storyboard.cuts.map((cut) => state.cuts[cut.id]);
  const total = Math.max(1, entries.length);
  const activeJobs = new Map(
    jobs
      .filter((job) => ['queued', 'running'].includes(job.status))
      .map((job) => [job.type, job]),
  );
  const running = (type: StudioJobType) => activeJobs.get(type);
  const stageProgress = (target: string) =>
    (entries.filter((entry) => atLeast(entry?.stage, target)).length / total) * 100;
  const scriptComplete = Boolean(state.gates.script);
  const castComplete = Boolean(state.gates.cast);
  const storyboardComplete = Boolean(state.gates.storyboard);
  const audioComplete = entries.length > 0 && entries.every((entry) => atLeast(entry?.stage, 'audio_ready'));
  const keyframesComplete = Boolean(state.gates.visual);
  const videoComplete =
    entries.length > 0 &&
    entries.every((entry) => ['sakkan_pass', 'composited'].includes(entry?.stage ?? ''));
  const composeComplete = Boolean(state.delivery);
  const finalComplete = Boolean(state.gates.final);
  const libTvReady = libTvSessions.filter((session) => session.status === 'ready').length;
  const currentEvaluations = evaluations.filter((evaluation) => !evaluation.stale);

  const values: WorkflowStage[] = [
    stage({
      id: 'script',
      code: '01',
      label: '剧本与表演意图',
      detail: `${script.scenes.length} 场 · 情绪承诺、人物目标和台词`,
      status: scriptComplete ? 'complete' : 'active',
      progress: scriptComplete ? 100 : 55,
      blockers: [],
      optional: false,
      action: { kind: 'open', label: scriptComplete ? '查看剧本' : '审核并批准', tab: 'script' },
    }),
    stage({
      id: 'cast',
      code: '02',
      label: '角色、场景与声音选角',
      detail: '系列资产锁定后才进入镜头生产',
      status: castComplete
        ? 'complete'
        : running('cast')
          ? 'active'
          : scriptComplete
            ? 'ready'
            : 'blocked',
      progress: castComplete
        ? 100
        : (store.characters().filter((item) => item.status !== 'draft').length /
            Math.max(1, store.characters().length)) *
          80,
      blockers: scriptComplete ? [] : ['先批准关卡①剧本'],
      optional: false,
      action: running('cast')
        ? { kind: 'open', label: '查看运行任务', tab: 'tasks' }
        : castComplete
          ? { kind: 'open', label: '查看资产', tab: 'assets' }
          : { kind: 'job', label: '生成定妆候选', tab: 'assets', jobType: 'cast' },
    }),
    stage({
      id: 'storyboard',
      code: '03',
      label: '分镜与镜头语言',
      detail: `${storyboard.cuts.length} 卡 · 信息顺序、景别、运镜和情绪节奏`,
      status: storyboardComplete
        ? 'complete'
        : running('storyboard')
          ? 'active'
          : castComplete
            ? 'ready'
            : 'blocked',
      progress: storyboardComplete ? 100 : storyboard.cuts.length ? 60 : 0,
      blockers: castComplete ? [] : ['先锁定角色、场景与音色'],
      optional: false,
      action: running('storyboard')
        ? { kind: 'open', label: '查看运行任务', tab: 'tasks' }
        : storyboardComplete
          ? { kind: 'open', label: '查看分镜', tab: 'storyboard' }
          : { kind: 'job', label: '生成分镜', tab: 'storyboard', jobType: 'storyboard' },
    }),
    stage({
      id: 'audio',
      code: '04',
      label: 'Audio-first 配音与时长',
      detail: '逐句音频、实际时长回填和声音证据',
      status: audioComplete
        ? 'complete'
        : running('audio')
          ? 'active'
          : storyboardComplete
            ? 'ready'
            : 'blocked',
      progress: audioComplete ? 100 : stageProgress('audio_ready'),
      blockers: storyboardComplete ? [] : ['先批准分镜'],
      optional: false,
      action: running('audio')
        ? { kind: 'open', label: '查看运行任务', tab: 'tasks' }
        : { kind: 'job', label: audioComplete ? '重新生成配音' : '生成配音', tab: 'workflow', jobType: 'audio' },
    }),
    stage({
      id: 'keyframes',
      code: '05',
      label: '关键帧候选与圈选',
      detail: '候选、首尾帧、局部重做与人工 greenlight',
      status: keyframesComplete
        ? 'complete'
        : running('keyframes')
          ? 'active'
          : audioComplete
            ? 'ready'
            : 'blocked',
      progress: keyframesComplete ? 100 : stageProgress('keyframes_ready'),
      blockers: audioComplete ? [] : ['先完成配音和时长回填'],
      optional: false,
      action: running('keyframes')
        ? { kind: 'open', label: '查看运行任务', tab: 'tasks' }
        : keyframesComplete
          ? { kind: 'open', label: '查看圈选', tab: 'keyframes' }
          : { kind: 'job', label: '生成关键帧', tab: 'keyframes', jobType: 'keyframes' },
    }),
    stage({
      id: 'canvas',
      code: 'EX',
      label: 'LibTV 外部创作画布',
      detail: `${libTvSessions.length} 个持久会话 · ${libTvReady} 个有结果；结果可晋升到镜头 round`,
      status: libTvReady ? 'complete' : storyboard.cuts.length ? 'optional' : 'blocked',
      progress: libTvReady ? 100 : libTvSessions.length ? 45 : 0,
      blockers: storyboard.cuts.length ? [] : ['先建立分镜，才能把结果晋升到镜头'],
      optional: true,
      action: { kind: 'open', label: libTvSessions.length ? '继续创作' : '打开外部画布', tab: 'canvas' },
    }),
    stage({
      id: 'video',
      code: '06',
      label: '视频 coverage 与作监',
      detail: '关键卡多 take、失败降级、身份一致性与局部重做',
      status: videoComplete
        ? 'complete'
        : running('video')
          ? 'active'
          : keyframesComplete
            ? 'ready'
            : 'blocked',
      progress: videoComplete ? 100 : stageProgress('sakkan_pass'),
      blockers: keyframesComplete ? [] : ['先完成关卡②关键帧圈选'],
      optional: false,
      action: running('video')
        ? { kind: 'open', label: '查看运行任务', tab: 'tasks' }
        : { kind: 'job', label: videoComplete ? '重新检查视频' : '生成视频', tab: 'workflow', jobType: 'video' },
    }),
    stage({
      id: 'evaluation',
      code: 'QA',
      label: '多维质量评测',
      detail: `${currentEvaluations.length} 份当前版本报告 · 自动证据与人工看片/试听分开`,
      status: currentEvaluations.length ? 'complete' : storyboard.cuts.length ? 'optional' : 'blocked',
      progress: currentEvaluations.length ? 100 : 0,
      blockers: storyboard.cuts.length ? [] : ['至少需要剧本与分镜'],
      optional: true,
      action: { kind: 'open', label: currentEvaluations.length ? '查看评测' : '创建评测', tab: 'evaluation' },
    }),
    stage({
      id: 'compose',
      code: '07',
      label: '合成、字幕与交付 QC',
      detail: '稳定时间线、AIGC 标识、封面和自动 QC',
      status: composeComplete
        ? 'complete'
        : running('compose')
          ? 'active'
          : videoComplete
            ? 'ready'
            : 'blocked',
      progress: composeComplete ? 100 : stageProgress('composited'),
      blockers: videoComplete ? [] : ['所有镜头先通过作监'],
      optional: false,
      action: running('compose')
        ? { kind: 'open', label: '查看运行任务', tab: 'tasks' }
        : { kind: 'job', label: composeComplete ? '重新合成' : '合成成片', tab: 'delivery', jobType: 'compose' },
    }),
    stage({
      id: 'final',
      code: '08',
      label: '人工成片批准',
      detail: '自动 QC 只是证据；最终 picture lock 必须人工完成',
      status: finalComplete ? 'complete' : composeComplete ? 'active' : 'blocked',
      progress: finalComplete ? 100 : composeComplete ? 80 : 0,
      blockers: composeComplete ? [] : ['先生成通过 QC 的交付物'],
      optional: false,
      action: { kind: 'open', label: finalComplete ? '查看交付' : '看片并批准', tab: 'delivery' },
    }),
  ];
  const required = values.filter((item) => !item.optional);
  const overallProgress = Math.round(
    required.reduce((sum, item) => sum + item.progress, 0) / required.length,
  );
  const next =
    values.find(
      (item) =>
        !item.optional &&
        item.status !== 'complete' &&
        item.status !== 'blocked',
    ) ?? values.find((item) => item.status === 'optional');
  return {
    seriesId: store.seriesId,
    episodeId,
    overallProgress,
    completedRequired: required.filter((item) => item.status === 'complete').length,
    totalRequired: required.length,
    nextStageId: next?.id,
    stages: values,
  };
}
