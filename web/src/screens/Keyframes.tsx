import { useEffect, useMemo, useState } from 'react';
import { EmptyState, SectionHeader, StatusTag } from '../components/Common';
import type { Cut, Workspace } from '../types';

export function Keyframes({
  workspace,
  onGenerate,
  onApprove,
  onRetake,
}: {
  workspace: Workspace;
  onGenerate: () => Promise<void>;
  onApprove: (picks: Record<string, number>) => Promise<void>;
  onRetake: (cut: Cut) => void;
}) {
  const [picks, setPicks] = useState<Record<string, number>>({});
  useEffect(() => setPicks({}), [workspace]);
  const pendingGroups = useMemo(
    () =>
      workspace.storyboard.cuts.flatMap((cut) =>
        cut.state?.stage === 'keyframes_ready'
          ? Object.entries(cut.candidates).map(([role, candidates]) => ({
              cut,
              role,
              candidates,
              key: `${cut.id}:${role}`,
            }))
          : [],
      ),
    [workspace],
  );
  const canApprove =
    pendingGroups.length > 0 &&
    pendingGroups.every((group) => Boolean(picks[group.key]));
  return (
    <div className="screen-stack">
      <SectionHeader
        eyebrow="Visual dailies"
        title="关键帧宫格圈选"
        detail="关键卡生成 4 张候选，普通卡生成 2 张；圈选完成才开放付费视频。"
        actions={
          <>
            <button className="button ghost" onClick={() => void onGenerate()}>
              生成候选
            </button>
            <button
              className="button primary"
              disabled={!canApprove}
              onClick={() => void onApprove(picks)}
            >
              批准全部圈选
            </button>
          </>
        }
      />
      {!workspace.storyboard.cuts.length ? (
        <EmptyState
          title="尚无镜头"
          detail="请先完成剧本、定妆和分镜批准。"
        />
      ) : (
        <div className="dailies-list">
          {workspace.storyboard.cuts.map((cut, index) => (
            <article className="dailies-row" key={cut.id}>
              <header>
                <span className="cut-number">
                  {String(index + 1).padStart(2, '0')}
                </span>
                <div>
                  <strong>{cut.id}</strong>
                  <small>
                    {cut.shotSize} · {cut.genMode} · {cut.durationSec.toFixed(1)}s
                  </small>
                </div>
                <StatusTag
                  value={cut.state?.stage ?? 'pending'}
                  tone={
                    ['keyframe_selected', 'video_ready', 'sakkan_pass', 'composited'].includes(
                      cut.state?.stage ?? '',
                    )
                      ? 'good'
                      : cut.state?.stage === 'keyframes_ready'
                        ? 'warn'
                        : 'neutral'
                  }
                />
                <button className="text-button" onClick={() => onRetake(cut)}>
                  局部调整
                </button>
              </header>
              <p className="cut-action">{cut.action}</p>
              {Object.keys(cut.candidates).length > 0 ? (
                <div className="role-groups">
                  {Object.entries(cut.candidates).map(([role, candidates]) => {
                    const key = `${cut.id}:${role}`;
                    return (
                      <section className="role-group" key={role}>
                        <span className="role-label">
                          {role === 'first' ? '首帧' : '尾帧'}
                        </span>
                        <div className="frame-grid">
                          {candidates.map((candidate) => (
                            <label
                              key={candidate.file}
                              className={
                                picks[key] === candidate.index ? 'selected' : ''
                              }
                            >
                              <input
                                type="radio"
                                name={key}
                                checked={picks[key] === candidate.index}
                                onChange={() =>
                                  setPicks((current) => ({
                                    ...current,
                                    [key]: candidate.index,
                                  }))
                                }
                              />
                              {candidate.url ? (
                                <img
                                  src={candidate.url}
                                  alt={`${cut.id} ${role} 候选 ${candidate.index}`}
                                  loading="lazy"
                                />
                              ) : (
                                <div className="media-placeholder">不可预览</div>
                              )}
                              <span>T{String(candidate.index).padStart(2, '0')}</span>
                            </label>
                          ))}
                        </div>
                      </section>
                    );
                  })}
                </div>
              ) : cut.selectedKeyframeUrls.length ? (
                <div className="selected-frames">
                  {cut.selectedKeyframeUrls.map((url, frameIndex) => (
                    <img
                      src={url}
                      key={url}
                      alt={`${cut.id} 已圈选帧 ${frameIndex + 1}`}
                    />
                  ))}
                </div>
              ) : (
                <p className="muted">当前阶段还没有可圈选的关键帧。</p>
              )}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
