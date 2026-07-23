import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { EmptyState, SectionHeader, StatusTag, formatTime } from '../components/Common';
import type { LibTvSession, LibTvStatus, Workspace } from '../types';

interface ReferenceOption {
  file: string;
  url: string | undefined;
  code: string;
  label: string;
  group: '角色资产' | '场景资产' | '已选关键帧' | '镜头候选';
}

function referenceOptions(workspace: Workspace): ReferenceOption[] {
  const values: ReferenceOption[] = [];
  for (const character of workspace.assets.characters) {
    character.turnaround.forEach((file, index) => {
      values.push({
        file,
        url: character.turnaroundUrls[index],
        code: character.id,
        label: `${character.name} · 定妆`,
        group: '角色资产',
      });
    });
  }
  for (const location of workspace.assets.locations) {
    location.referenceImages.forEach((file, index) => {
      values.push({
        file,
        url: location.referenceUrls[index],
        code: location.id,
        label: `${location.name} · 场景`,
        group: '场景资产',
      });
    });
  }
  for (const cut of workspace.storyboard.cuts) {
    const selected = workspace.state.cuts[cut.id]?.selectedKeyframes ?? [];
    selected.forEach((file, index) => {
      values.push({
        file,
        url: cut.selectedKeyframeUrls[index],
        code: cut.id,
        label: `${cut.id} · 已圈选 ${index + 1}`,
        group: '已选关键帧',
      });
    });
    for (const [role, candidates] of Object.entries(cut.candidates)) {
      candidates.forEach((candidate) => {
        values.push({
          file: candidate.file,
          url: candidate.url,
          code: cut.id,
          label: `${cut.id} · ${role === 'first' ? '首帧' : '尾帧'} T${candidate.index}`,
          group: '镜头候选',
        });
      });
    }
  }
  return [...new Map(values.map((value) => [value.file, value])).values()];
}

function tone(status: LibTvSession['status']) {
  if (status === 'ready') return 'good' as const;
  if (status === 'running' || status === 'submitting') return 'warn' as const;
  return 'bad' as const;
}

function statusLabel(status: LibTvSession['status']): string {
  return {
    submitting: '提交中',
    running: '生成中',
    ready: '有结果',
    failed: '失败',
    orphaned: '待人工核对',
  }[status];
}

function bytes(value: number): string {
  if (value < 1_024 * 1_024) return `${Math.ceil(value / 1_024)} KB`;
  return `${(value / 1_024 / 1_024).toFixed(1)} MB`;
}

export function LibTvCanvas({ workspace }: { workspace: Workspace }) {
  const [provider, setProvider] = useState<LibTvStatus>();
  const [sessions, setSessions] = useState<LibTvSession[]>([]);
  const [instruction, setInstruction] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [followups, setFollowups] = useState<Record<string, string>>({});
  const [promotionTargets, setPromotionTargets] = useState<
    Record<
      string,
      { cutId: string; role: 'first' | 'last'; replaceExisting: boolean }
    >
  >({});
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const options = useMemo(() => referenceOptions(workspace), [workspace]);

  const load = useCallback(async () => {
    const response = await api.libTvSessions(
      workspace.series.id,
      workspace.episodeId,
    );
    setProvider(response.status);
    setSessions(response.sessions);
  }, [workspace.episodeId, workspace.series.id]);

  useEffect(() => {
    setInstruction('');
    setSelected([]);
    setFollowups({});
    setPromotionTargets({});
    setError('');
    setNotice('');
    void load().catch((caught) =>
      setError(caught instanceof Error ? caught.message : String(caught)),
    );
  }, [load]);

  const toggle = (file: string) => {
    setError('');
    setSelected((current) => {
      if (current.includes(file)) return current.filter((value) => value !== file);
      if (current.length >= 8) {
        setError('LibTV 单次最多上传 8 个参考素材');
        return current;
      }
      return [...current, file];
    });
  };

  const create = async () => {
    try {
      setError('');
      setBusy('create');
      const created = await api.createLibTvSession(
        workspace.series.id,
        workspace.episodeId,
        {
          instruction: instruction.trim(),
          referenceFiles: selected,
        },
      );
      setSessions((current) => [
        created,
        ...current.filter((item) => item.id !== created.id),
      ]);
      setInstruction('');
      setSelected([]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy('');
    }
  };

  const operate = async (
    session: LibTvSession,
    operation: 'refresh' | 'collect',
  ) => {
    try {
      setError('');
      setBusy(`${operation}:${session.id}`);
      const updated =
        operation === 'refresh'
          ? await api.refreshLibTvSession(
              workspace.series.id,
              workspace.episodeId,
              session.id,
            )
          : await api.collectLibTvSession(
              workspace.series.id,
              workspace.episodeId,
              session.id,
            );
      setSessions((current) =>
        current.map((item) => (item.id === updated.id ? updated : item)),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy('');
    }
  };

  const continueSession = async (session: LibTvSession) => {
    const value = followups[session.id]?.trim() ?? '';
    if (value.length < 3) return;
    try {
      setError('');
      setNotice('');
      setBusy(`continue:${session.id}`);
      const updated = await api.continueLibTvSession(
        workspace.series.id,
        workspace.episodeId,
        session.id,
        { instruction: value, referenceFiles: selected },
      );
      setSessions((current) =>
        current.map((item) => (item.id === updated.id ? updated : item)),
      );
      setFollowups((current) => ({ ...current, [session.id]: '' }));
      setSelected([]);
      setNotice('续写已记录到同一持久会话');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy('');
    }
  };

  const promote = async (session: LibTvSession, resultIndex: number) => {
    const key = `${session.id}:${resultIndex}`;
    const target = promotionTargets[key] ?? {
      cutId: workspace.storyboard.cuts[0]?.id ?? '',
      role: 'first' as const,
      replaceExisting: false,
    };
    if (!target.cutId) return;
    try {
      setError('');
      setNotice('');
      setBusy(`promote:${key}`);
      const result = await api.promoteLibTvResult(
        workspace.series.id,
        workspace.episodeId,
        session.id,
        { resultIndex, ...target },
      );
      setNotice(
        `${result.cutId} ${result.role === 'first' ? '首帧' : '尾帧'}已加入 round ${result.round} 的候选 ${result.candidateIndex}`,
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy('');
    }
  };

  const groups = useMemo(
    () =>
      (['角色资产', '场景资产', '已选关键帧', '镜头候选'] as const)
        .map((group) => ({
          group,
          values: options.filter((option) => option.group === group),
        }))
        .filter((group) => group.values.length),
    [options],
  );

  return (
    <div className="screen-stack libtv-canvas">
      <SectionHeader
        eyebrow="Controlled external canvas"
        title="LibTV 外部创作台"
        detail="AI-amnTV 保留剧本、分镜、资产锁定与审核门；只把你明确选择的指令和素材交给 LibTV。会话、远端 ID 和回收结果都写入当前项目。"
        actions={
          provider && (
            <div className="canvas-provider">
              <StatusTag
                value={provider.mode === 'dry-run' ? 'DRY RUN' : 'LIBTV LIVE'}
                tone={provider.ready ? 'good' : 'bad'}
              />
              <small>{provider.message}</small>
            </div>
          )
        }
      />

      <section className="canvas-composer">
        <div className="canvas-prompt">
          <div className="ledger-header">
            <div>
              <span className="eyebrow">01 / Creative brief</span>
              <h3>本次创作指令</h3>
            </div>
            <small>{instruction.length.toLocaleString()} / 20,000</small>
          </div>
          <label className="field canvas-instruction">
            <span>写清画面目标、人物动作、镜头、风格和需要保留的约束</span>
            <textarea
              value={instruction}
              maxLength={20_000}
              placeholder="例如：基于已圈选首帧生成竖屏情绪镜头。女主克制地抬眼，保持角色服装与脸部一致；镜头缓慢推进，不增加文字和新人物。"
              onChange={(event) => setInstruction(event.target.value)}
            />
          </label>
          <div className="canvas-submit">
            <div>
              <strong>
                {selected.length
                  ? `将上传 ${selected.length} 个已选素材`
                  : '本次不上传参考素材'}
              </strong>
              <small>
                不自动轮询、不自动重提。实时模式的生成可能产生 LibTV 费用。
              </small>
            </div>
            <button
              className="button primary"
              disabled={
                instruction.trim().length < 3 ||
                !provider?.ready ||
                Boolean(busy)
              }
              onClick={() => void create()}
            >
              {busy === 'create'
                ? '正在建立会话…'
                : provider?.mode === 'dry-run'
                  ? '运行本地画布验收'
                  : '确认发送到 LibTV'}
            </button>
          </div>
          {error && <p className="canvas-error">{error}</p>}
          {notice && <p className="canvas-notice">{notice}</p>}
        </div>

        <aside className="canvas-tray">
          <div className="ledger-header">
            <div>
              <span className="eyebrow">02 / Reference tray</span>
              <h3>参考素材</h3>
            </div>
            <small>{selected.length} / 8 已选</small>
          </div>
          {!groups.length ? (
            <div className="canvas-tray-empty">
              完成定妆或关键帧候选后，可在这里明确选择要上传的素材。
            </div>
          ) : (
            <div className="canvas-reference-scroll">
              {groups.map((group) => (
                <section className="canvas-reference-group" key={group.group}>
                  <header>
                    <strong>{group.group}</strong>
                    <span>{group.values.length}</span>
                  </header>
                  <div className="canvas-reference-grid">
                    {group.values.map((option) => (
                      <button
                        className={selected.includes(option.file) ? 'selected' : ''}
                        key={option.file}
                        title={option.file}
                        onClick={() => toggle(option.file)}
                      >
                        {option.url ? (
                          <img src={option.url} alt={option.label} loading="lazy" />
                        ) : (
                          <span className="canvas-file-placeholder">{option.code}</span>
                        )}
                        <span>
                          <b>{option.code}</b>
                          <small>{option.label}</small>
                        </span>
                        <i>{selected.includes(option.file) ? '已选' : '选择'}</i>
                      </button>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </aside>
      </section>

      <section className="canvas-history">
        <div className="subhead">
          <span className="eyebrow">Persistent sessions</span>
          <h3>创作会话与本地回收</h3>
        </div>
        {!sessions.length ? (
          <EmptyState
            title="尚无外部画布会话"
            detail="创建后，AI-amnTV 会先落盘本地记录，再提交远端；发生中断时不会自动重复计费。"
          />
        ) : (
          <div className="canvas-session-list">
            {sessions.map((session) => (
              <article className="canvas-session" key={session.id}>
                <header>
                  <div>
                    <StatusTag value={statusLabel(session.status)} tone={tone(session.status)} />
                    <time>{formatTime(session.createdAt)}</time>
                  </div>
                  <span className="canvas-session-id">
                    {session.remoteSessionId
                      ? `REMOTE ${session.remoteSessionId.slice(0, 12)}`
                      : `LOCAL ${session.id.slice(0, 8)}`}
                  </span>
                  <div className="button-row">
                    {session.projectUrl && (
                      <a
                        className="button ghost"
                        href={session.projectUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        打开 LibTV 画布
                      </a>
                    )}
                    {provider?.mode === 'live' &&
                      session.status !== 'orphaned' &&
                      session.status !== 'failed' && (
                        <button
                          className="button ghost"
                          disabled={Boolean(busy)}
                          onClick={() => void operate(session, 'refresh')}
                        >
                          {busy === `refresh:${session.id}` ? '查询中…' : '手动刷新'}
                        </button>
                      )}
                    {provider?.mode === 'live' && session.resultSources.length > 0 && (
                      <button
                        className="button primary"
                        disabled={Boolean(busy)}
                        onClick={() => void operate(session, 'collect')}
                      >
                        {busy === `collect:${session.id}` ? '回收中…' : '回收到项目'}
                      </button>
                    )}
                  </div>
                </header>
                <p className="canvas-session-prompt">{session.instruction}</p>
                <div className="canvas-session-facts">
                  <span>{session.references.length} 个参考</span>
                  <span>{session.turns.length} 轮指令</span>
                  <span>{session.messages.length} 条消息</span>
                  <span>{session.resultSources.length} 个远端结果</span>
                  <span>{session.results.length} 个本地文件</span>
                </div>
                {session.error && <p className="canvas-session-error">{session.error}</p>}
                {session.results.length > 0 && (
                  <div className="canvas-results">
                    {session.results.map((result, resultIndex) => {
                      const key = `${session.id}:${resultIndex}`;
                      const target = promotionTargets[key] ?? {
                        cutId: workspace.storyboard.cuts[0]?.id ?? '',
                        role: 'first' as const,
                        replaceExisting: false,
                      };
                      const targetCut = workspace.storyboard.cuts.find(
                        (cut) => cut.id === target.cutId,
                      );
                      const allowsLast =
                        targetCut?.genMode === 'first_last' ||
                        targetCut?.genMode === 'multi_frame';
                      return (
                        <figure key={result.file}>
                          {result.url && result.mimeType.startsWith('video/') ? (
                            <video src={result.url} controls preload="metadata" />
                          ) : result.url ? (
                            <img
                              src={result.url}
                              alt="LibTV 回收结果"
                              loading="lazy"
                            />
                          ) : (
                            <div className="media-placeholder">结果不可预览</div>
                          )}
                          <figcaption>
                            <span>{result.mimeType}</span>
                            <b>{bytes(result.bytes)}</b>
                          </figcaption>
                          {result.mimeType.startsWith('image/') &&
                            workspace.storyboard.cuts.length > 0 && (
                              <div className="canvas-promote">
                                <label>
                                  <span>晋升到镜头</span>
                                  <select
                                    value={target.cutId}
                                    onChange={(event) =>
                                      setPromotionTargets((current) => ({
                                        ...current,
                                        [key]: {
                                          ...target,
                                          cutId: event.target.value,
                                          role: 'first',
                                        },
                                      }))
                                    }
                                  >
                                    {workspace.storyboard.cuts.map((cut) => (
                                      <option value={cut.id} key={cut.id}>
                                        {cut.id}
                                      </option>
                                    ))}
                                  </select>
                                </label>
                                <label>
                                  <span>帧角色</span>
                                  <select
                                    value={allowsLast ? target.role : 'first'}
                                    onChange={(event) =>
                                      setPromotionTargets((current) => ({
                                        ...current,
                                        [key]: {
                                          ...target,
                                          role: event.target.value as
                                            | 'first'
                                            | 'last',
                                        },
                                      }))
                                    }
                                  >
                                    <option value="first">首帧</option>
                                    {allowsLast && (
                                      <option value="last">尾帧</option>
                                    )}
                                  </select>
                                </label>
                                <label className="canvas-replace">
                                  <input
                                    type="checkbox"
                                    checked={target.replaceExisting}
                                    onChange={(event) =>
                                      setPromotionTargets((current) => ({
                                        ...current,
                                        [key]: {
                                          ...target,
                                          replaceExisting: event.target.checked,
                                        },
                                      }))
                                    }
                                  />
                                  <span>允许撤销该卡现有下游结果</span>
                                </label>
                                <button
                                  className="button ghost"
                                  disabled={Boolean(busy)}
                                  onClick={() => void promote(session, resultIndex)}
                                >
                                  {busy === `promote:${key}`
                                    ? '正在晋升…'
                                    : '加入关键帧候选'}
                                </button>
                              </div>
                            )}
                        </figure>
                      );
                    })}
                  </div>
                )}
                <section className="canvas-followup">
                  <div>
                    <span className="eyebrow">Continue same session</span>
                    <strong>继续追问 / 调整结果</strong>
                    <small>
                      会使用当前参考托盘中已选择的 {selected.length}{' '}
                      个素材；每次都需要明确点击发送。
                    </small>
                  </div>
                  <textarea
                    aria-label={`续写 ${session.id.slice(0, 8)}`}
                    placeholder="例如：保持人物与构图，只把女主的眼神调整得更坚定，并减慢镜头推进。"
                    value={followups[session.id] ?? ''}
                    onChange={(event) =>
                      setFollowups((current) => ({
                        ...current,
                        [session.id]: event.target.value,
                      }))
                    }
                  />
                  <button
                    className="button primary"
                    disabled={
                      (followups[session.id]?.trim().length ?? 0) < 3 ||
                      Boolean(busy) ||
                      session.status === 'orphaned'
                    }
                    onClick={() => void continueSession(session)}
                  >
                    {busy === `continue:${session.id}`
                      ? '正在续写…'
                      : provider?.mode === 'dry-run'
                        ? '运行本地续写验收'
                        : '确认续写 LibTV 会话'}
                  </button>
                </section>
                {session.messages.length > 0 && (
                  <details className="canvas-messages">
                    <summary>查看 LibTV 消息记录</summary>
                    {session.messages.map((message) => (
                      <div key={message.id}>
                        <strong>{message.role}</strong>
                        <p>{message.content}</p>
                      </div>
                    ))}
                  </details>
                )}
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
