import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { ProgressBar, SectionHeader, StatusTag } from '../components/Common';
import type { JobType, StudioJob, StudioTab, WorkflowStage, WorkflowView, Workspace } from '../types';

function tone(status: WorkflowStage['status']) {
  if (status === 'complete') return 'good' as const;
  if (status === 'ready' || status === 'active') return 'warn' as const;
  if (status === 'blocked') return 'bad' as const;
  return 'neutral' as const;
}

function statusLabel(status: WorkflowStage['status']): string {
  return {
    complete: '已完成',
    active: '进行中',
    ready: '可执行',
    blocked: '被阻塞',
    optional: '可选',
  }[status];
}

export function Workflow({
  workspace,
  jobs,
  onRun,
  onOpen,
}: {
  workspace: Workspace;
  jobs: StudioJob[];
  onRun: (type: JobType) => Promise<void>;
  onOpen: (tab: StudioTab) => void;
}) {
  const [workflow, setWorkflow] = useState<WorkflowView>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const jobVersion = useMemo(
    () => jobs.map((job) => `${job.id}:${job.status}:${job.progress}`).join('|'),
    [jobs],
  );
  const load = useCallback(async () => {
    setWorkflow(
      await api.workflow(workspace.series.id, workspace.episodeId),
    );
  }, [workspace.episodeId, workspace.series.id]);

  useEffect(() => {
    void load().catch((caught) =>
      setError(caught instanceof Error ? caught.message : String(caught)),
    );
  }, [jobVersion, load, workspace.state.gates, workspace.state.delivery]);

  const act = async (stage: WorkflowStage) => {
    if (stage.action.kind === 'open' || !stage.action.jobType) {
      onOpen(stage.action.tab);
      return;
    }
    try {
      setError('');
      setBusy(stage.id);
      await onRun(stage.action.jobType);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="screen-stack workflow-screen">
      <SectionHeader
        eyebrow="Production graph"
        title="可恢复制作工作流"
        detail="每一步都由当前项目文件和任务状态计算，不靠前端猜测。LibTV 与评测是可选工位，不会绕过剧本、资产、圈图和成片人工关卡。"
        actions={
          workflow && (
            <div className="workflow-score">
              <strong>{workflow.overallProgress}%</strong>
              <span>
                {workflow.completedRequired}/{workflow.totalRequired} 个必需阶段
              </span>
            </div>
          )
        }
      />
      {error && <p className="canvas-error">{error}</p>}
      {workflow && (
        <>
          <section className="workflow-rail" aria-label="工作流进度">
            <ProgressBar value={workflow.overallProgress} />
            <span>
              当前建议：
              {workflow.stages.find((stage) => stage.id === workflow.nextStageId)
                ?.label ?? '检查可选评测'}
            </span>
          </section>
          <section className="workflow-stages">
            {workflow.stages.map((stage, index) => (
              <article
                className={`workflow-stage ${stage.status} ${stage.id === workflow.nextStageId ? 'next' : ''}`}
                key={stage.id}
              >
                <div className="workflow-index">
                  <span>{stage.code}</span>
                  {index < workflow.stages.length - 1 && <i />}
                </div>
                <div className="workflow-stage-body">
                  <header>
                    <div>
                      <span className="eyebrow">
                        {stage.optional ? 'Optional workbench' : 'Required stage'}
                      </span>
                      <h3>{stage.label}</h3>
                    </div>
                    <StatusTag value={statusLabel(stage.status)} tone={tone(stage.status)} />
                  </header>
                  <p>{stage.detail}</p>
                  <div className="workflow-stage-progress">
                    <ProgressBar value={stage.progress} />
                    <b>{stage.progress}%</b>
                  </div>
                  {stage.blockers.length > 0 && (
                    <ul>
                      {stage.blockers.map((blocker) => (
                        <li key={blocker}>{blocker}</li>
                      ))}
                    </ul>
                  )}
                </div>
                <div className="workflow-stage-action">
                  <button
                    className={stage.status === 'ready' ? 'button primary' : 'button ghost'}
                    disabled={
                      stage.status === 'blocked' ||
                      Boolean(busy) ||
                      (stage.status === 'active' && stage.action.kind === 'job')
                    }
                    onClick={() => void act(stage)}
                  >
                    {busy === stage.id ? '正在创建任务…' : stage.action.label}
                  </button>
                  {stage.optional && <small>不阻塞主生产线</small>}
                </div>
              </article>
            ))}
          </section>
        </>
      )}
    </div>
  );
}
