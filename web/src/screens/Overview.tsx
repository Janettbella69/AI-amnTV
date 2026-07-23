import { ProgressBar, SectionHeader, StatusTag } from '../components/Common';
import type { JobType, StudioJob, Workspace } from '../types';

const gates = [
  ['script', '① 剧本'],
  ['cast', '⓪ 定妆'],
  ['storyboard', '② 分镜'],
  ['visual', '② 圈图'],
  ['final', '③ 成片'],
] as const;

const stages: Array<{
  type: JobType;
  label: string;
  gate: string;
  detail: string;
}> = [
  { type: 'cast', label: '定妆候选', gate: '①', detail: '角色、场景与音色' },
  { type: 'storyboard', label: '分镜生成', gate: '⓪', detail: '15–25 卡镜头表' },
  { type: 'audio', label: '配音回填', gate: '②A', detail: 'プレスコ时长对齐' },
  { type: 'keyframes', label: '关键帧', gate: '②A', detail: '首帧与首尾帧候选' },
  { type: 'video', label: '视频覆盖', gate: '②B', detail: '生成、作监与降级' },
  { type: 'compose', label: '成片合成', gate: '作监', detail: '字幕、AIGC 与 QC' },
];

export function Overview({
  workspace,
  jobs,
  onRun,
}: {
  workspace: Workspace;
  jobs: StudioJob[];
  onRun: (type: JobType) => void;
}) {
  const counts = new Map<string, number>();
  Object.values(workspace.state.cuts).forEach((entry) => {
    counts.set(entry.stage, (counts.get(entry.stage) ?? 0) + 1);
  });
  const active = jobs.find((job) =>
    ['queued', 'running'].includes(job.status),
  );
  const duration = workspace.storyboard.cuts.reduce(
    (sum, cut) => sum + cut.durationSec,
    0,
  );
  return (
    <div className="screen-stack">
      <SectionHeader
        eyebrow="Production pulse"
        title={`${workspace.episodeId} · ${workspace.script.title}`}
        detail={workspace.series.logline}
      />

      <section className="gate-strip" aria-label="制作关卡">
        {gates.map(([key, label]) => {
          const value = workspace.state.gates[key];
          return (
            <article key={key} className={value ? 'passed' : ''}>
              <span>{label}</span>
              <strong>{value ? '已通过' : '待确认'}</strong>
              <small>{value ? new Date(value.at).toLocaleDateString() : '人工关卡'}</small>
            </article>
          );
        })}
      </section>

      {active && (
        <section className="active-job">
          <div>
            <span className="eyebrow">Active job</span>
            <strong>{active.message}</strong>
          </div>
          <ProgressBar value={active.progress} />
          <b>{active.progress}%</b>
        </section>
      )}

      <div className="overview-grid">
        <section className="metric-ledger">
          <div>
            <span>镜头</span>
            <strong>{workspace.storyboard.cuts.length}</strong>
            <small>目标 {workspace.series.spec.targetCuts.join('–')}</small>
          </div>
          <div>
            <span>时长</span>
            <strong>{duration.toFixed(1)}s</strong>
            <small>目标 60–120s</small>
          </div>
          <div>
            <span>已知成本</span>
            <strong>¥{workspace.costs.knownTotalCny.toFixed(2)}</strong>
            <small>{workspace.costs.unknownEntries} 笔未知</small>
          </div>
          <div>
            <span>抽卡/镜头</span>
            <strong>{workspace.costs.imageDrawsPerCut.toFixed(2)}</strong>
            <small>预算上限 4.00</small>
          </div>
        </section>

        <section className="stage-distribution">
          <div className="subhead">
            <span className="eyebrow">Cut states</span>
            <h3>卡片状态</h3>
          </div>
          {[...counts].map(([stage, count]) => (
            <div className="distribution-row" key={stage}>
              <span>{stage}</span>
              <div>
                <i
                  style={{
                    width: `${(count / Math.max(1, workspace.storyboard.cuts.length)) * 100}%`,
                  }}
                />
              </div>
              <b>{count}</b>
            </div>
          ))}
          {!counts.size && <p className="muted">分镜批准后显示卡片状态。</p>}
        </section>
      </div>

      <section className="pipeline-table">
        <div className="subhead">
          <span className="eyebrow">Pipeline controls</span>
          <h3>制作阶段</h3>
        </div>
        {stages.map((stage) => {
          const running = jobs.some(
            (job) =>
              job.type === stage.type &&
              ['queued', 'running'].includes(job.status),
          );
          return (
            <div className="pipeline-row" key={stage.type}>
              <span className="stage-code">{stage.gate}</span>
              <div>
                <strong>{stage.label}</strong>
                <small>{stage.detail}</small>
              </div>
              <button
                className="button ghost"
                disabled={running}
                onClick={() => onRun(stage.type)}
              >
                {running ? '队列中' : '执行'}
              </button>
            </div>
          );
        })}
      </section>

      <section className="provider-ledger">
        {(Object.entries(workspace.providers) as Array<
          [keyof Workspace['providers'], Workspace['providers']['image']]
        >).map(([kind, provider]) => (
          <div key={kind}>
            <span>{kind.toUpperCase()}</span>
            <strong>{provider.name}</strong>
            <StatusTag
              value={provider.ready ? 'READY' : 'NOT READY'}
              tone={provider.ready ? 'good' : 'warn'}
            />
            <small>{provider.message}</small>
          </div>
        ))}
      </section>
    </div>
  );
}
