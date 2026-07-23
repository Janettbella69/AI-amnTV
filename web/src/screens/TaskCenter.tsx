import {
  EmptyState,
  formatTime,
  ProgressBar,
  SectionHeader,
  StatusTag,
} from '../components/Common';
import type { StudioJob } from '../types';

export function TaskCenter({
  jobs,
  onCancel,
}: {
  jobs: StudioJob[];
  onCancel: (id: string) => void;
}) {
  return (
    <div className="screen-stack">
      <SectionHeader
        eyebrow="Persistent queue"
        title="任务中心"
        detail="队列持久化在 SQLite；进程重启不会悄悄重提付费任务。"
      />
      {!jobs.length ? (
        <EmptyState title="暂无任务" detail="从概览或各生产页面启动阶段任务。" />
      ) : (
        <section className="job-list">
          {jobs.map((job) => (
            <article key={job.id} className={`job-row ${job.status}`}>
              <div className="job-type">
                <span>{job.type.toUpperCase()}</span>
                <small>{job.id.slice(0, 8)}</small>
              </div>
              <div className="job-body">
                <div>
                  <strong>{job.message}</strong>
                  <StatusTag
                    value={job.status}
                    tone={
                      job.status === 'succeeded'
                        ? 'good'
                        : job.status === 'failed'
                          ? 'bad'
                          : job.status === 'running'
                            ? 'warn'
                            : 'neutral'
                    }
                  />
                </div>
                <ProgressBar value={job.progress} />
                {job.error && <p className="error-text">{job.error}</p>}
              </div>
              <div className="job-time">
                <span>{formatTime(job.createdAt)}</span>
                {job.status === 'queued' && (
                  <button className="text-button" onClick={() => onCancel(job.id)}>
                    取消
                  </button>
                )}
              </div>
            </article>
          ))}
        </section>
      )}
    </div>
  );
}
