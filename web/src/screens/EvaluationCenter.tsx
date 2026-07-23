import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { EmptyState, SectionHeader, StatusTag, formatTime } from '../components/Common';
import type {
  BenchmarkCandidate,
  BenchmarkCriterion,
  BenchmarkReport,
  EvaluationDimensionId,
  EvaluationReport,
  EvaluationScope,
  Workspace,
} from '../types';

const benchmarkCriteria: Array<{
  id: BenchmarkCriterion;
  label: string;
  detail: string;
}> = [
  { id: 'identity', label: '人物一致性', detail: '脸、身体、服装与角色身份' },
  { id: 'composition', label: '构图与画面', detail: '信息层级、空间和可读性' },
  { id: 'cameraLanguage', label: '镜头语言', detail: '景别、视线、运动与叙事动机' },
  { id: 'motion', label: '动作与时序', detail: '动作完整、自然且没有突变' },
  { id: 'artifacts', label: '干净度', detail: '高分代表少伪影、少漂移' },
  { id: 'voicePerformance', label: '配音表演', detail: '音色、情绪、停顿和可懂度' },
];

interface BenchmarkRatingState {
  criteria: Record<BenchmarkCriterion, number>;
  note: string;
}

function initialBenchmarkRating(): BenchmarkRatingState {
  return {
    criteria: {
      identity: 80,
      composition: 80,
      cameraLanguage: 80,
      motion: 80,
      artifacts: 80,
      voicePerformance: 80,
    },
    note: '',
  };
}

function criteriaFor(candidate: BenchmarkCandidate) {
  return benchmarkCriteria.filter(
    (criterion) =>
      candidate.kind === 'video' ||
      !['motion', 'voicePerformance'].includes(criterion.id),
  );
}

const scopeOptions: Array<{
  id: EvaluationScope;
  code: string;
  label: string;
  detail: string;
  dimensions: EvaluationDimensionId[];
}> = [
  {
    id: 'story',
    code: '01',
    label: '剧本 / 分镜',
    detail: '在付费画面前检查叙事、人物、镜头和竖屏节奏。',
    dimensions: ['narrative', 'character', 'storyboard', 'platform'],
  },
  {
    id: 'dailies',
    code: '02',
    label: '样片 / 作监',
    detail: '看片、试听并检查画面、配音和跨镜连续性。',
    dimensions: ['narrative', 'character', 'storyboard', 'visual', 'audio', 'continuity'],
  },
  {
    id: 'final',
    code: '03',
    label: '成片 / 交付',
    detail: '综合内容、视听、平台和自动 QC 证据。',
    dimensions: [
      'narrative',
      'character',
      'storyboard',
      'visual',
      'audio',
      'continuity',
      'platform',
      'delivery',
    ],
  },
];

const dimensionLabels: Record<EvaluationDimensionId, string> = {
  narrative: '剧本与情绪',
  character: '人物与声音身份',
  storyboard: '分镜与镜头语言',
  visual: '画面与动作',
  audio: '配音与声音',
  continuity: '跨镜连续性',
  platform: '竖屏发行适配',
  delivery: '成片与交付 QC',
};

interface ManualState {
  enabled: boolean;
  score: number;
  note: string;
}

function initialManual(): Record<EvaluationDimensionId, ManualState> {
  return Object.fromEntries(
    Object.keys(dimensionLabels).map((id) => [
      id,
      { enabled: false, score: 80, note: '' },
    ]),
  ) as Record<EvaluationDimensionId, ManualState>;
}

function verdict(report: EvaluationReport) {
  if (report.verdict === 'pass') return { label: '通过', tone: 'good' as const };
  if (report.verdict === 'revise') return { label: '需修订', tone: 'bad' as const };
  return { label: '待人工评审', tone: 'warn' as const };
}

export function EvaluationCenter({ workspace }: { workspace: Workspace }) {
  const [scope, setScope] = useState<EvaluationScope>('story');
  const [reports, setReports] = useState<EvaluationReport[]>([]);
  const [candidates, setCandidates] = useState<BenchmarkCandidate[]>([]);
  const [benchmarks, setBenchmarks] = useState<BenchmarkReport[]>([]);
  const [benchmarkSelection, setBenchmarkSelection] = useState<string[]>([]);
  const [benchmarkRatings, setBenchmarkRatings] = useState<
    Record<string, BenchmarkRatingState>
  >({});
  const [selectedId, setSelectedId] = useState('');
  const [manual, setManual] = useState(initialManual);
  const [busy, setBusy] = useState(false);
  const [benchmarkBusy, setBenchmarkBusy] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    const [values, candidateValues, benchmarkValues] = await Promise.all([
      api.evaluations(workspace.series.id, workspace.episodeId),
      api.benchmarkCandidates(workspace.series.id, workspace.episodeId),
      api.benchmarks(workspace.series.id, workspace.episodeId),
    ]);
    setReports(values);
    setCandidates(candidateValues);
    setBenchmarks(benchmarkValues);
    setSelectedId((current) =>
      values.some((report) => report.id === current)
        ? current
        : (values[0]?.id ?? ''),
    );
  }, [workspace.episodeId, workspace.series.id]);

  useEffect(() => {
    setError('');
    void load().catch((caught) =>
      setError(caught instanceof Error ? caught.message : String(caught)),
    );
  }, [load]);

  const option = scopeOptions.find((item) => item.id === scope)!;
  const selected = useMemo(
    () => reports.find((report) => report.id === selectedId),
    [reports, selectedId],
  );

  const run = async () => {
    try {
      setBusy(true);
      setError('');
      const report = await api.createEvaluation(
        workspace.series.id,
        workspace.episodeId,
        {
          scope,
          manualRatings: option.dimensions.flatMap((dimension) => {
            const rating = manual[dimension];
            return rating.enabled
              ? [{ dimension, score: rating.score, note: rating.note }]
              : [];
          }),
        },
      );
      setReports((current) => [
        report,
        ...current.filter((item) => item.id !== report.id),
      ]);
      setSelectedId(report.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const toggleBenchmark = (candidateId: string) => {
    setBenchmarkSelection((current) => {
      if (current.includes(candidateId)) {
        return current.filter((id) => id !== candidateId);
      }
      if (current.length >= 4) {
        setError('一次对比最多选择 4 个产物');
        return current;
      }
      setBenchmarkRatings((ratings) => ({
        ...ratings,
        [candidateId]: ratings[candidateId] ?? initialBenchmarkRating(),
      }));
      return [...current, candidateId];
    });
  };

  const createBenchmark = async () => {
    if (benchmarkSelection.length < 2) return;
    try {
      setBenchmarkBusy(true);
      setError('');
      const report = await api.createBenchmark(
        workspace.series.id,
        workspace.episodeId,
        {
          title: 'LibTV / 本地管线产物对比',
          ratings: benchmarkSelection.map((candidateId) => {
            const candidate = candidates.find((item) => item.id === candidateId)!;
            const rating =
              benchmarkRatings[candidateId] ?? initialBenchmarkRating();
            return {
              candidateId,
              criteria: Object.fromEntries(
                criteriaFor(candidate).map((criterion) => [
                  criterion.id,
                  rating.criteria[criterion.id],
                ]),
              ),
              note: rating.note,
            };
          }),
        },
      );
      setBenchmarks((current) => [
        report,
        ...current.filter((item) => item.id !== report.id),
      ]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBenchmarkBusy(false);
    }
  };

  return (
    <div className="screen-stack evaluation-center">
      <SectionHeader
        eyebrow="Evidence-based review"
        title="多维评测中心"
        detail="自动部分只评可验证的结构、文件和 QC 证据；画面审美、表演、镜头意图和声音质感必须由人看片/试听评分，不用演示数字冒充真实质量。"
        actions={
          <button className="button primary" disabled={busy} onClick={() => void run()}>
            {busy ? '正在生成报告…' : '生成当前检查点报告'}
          </button>
        }
      />
      {error && <p className="canvas-error">{error}</p>}

      <section className="evaluation-builder">
        <div className="evaluation-scope">
          <div className="subhead">
            <span className="eyebrow">Evaluation scope</span>
            <h3>选择评测检查点</h3>
          </div>
          {scopeOptions.map((item) => (
            <button
              className={scope === item.id ? 'active' : ''}
              key={item.id}
              onClick={() => setScope(item.id)}
            >
              <span>{item.code}</span>
              <strong>{item.label}</strong>
              <small>{item.detail}</small>
            </button>
          ))}
        </div>
        <div className="manual-ratings">
          <div className="subhead">
            <span className="eyebrow">Human evidence</span>
            <h3>人工看片 / 试听评分（可选）</h3>
          </div>
          <p className="evaluation-note">
            未勾选的维度不会获得人工分。报告会分别显示自动证据覆盖率与人工覆盖率。
          </p>
          {option.dimensions.map((dimension) => {
            const value = manual[dimension];
            return (
              <article className={value.enabled ? 'enabled' : ''} key={dimension}>
                <label>
                  <input
                    type="checkbox"
                    checked={value.enabled}
                    onChange={(event) =>
                      setManual((current) => ({
                        ...current,
                        [dimension]: {
                          ...current[dimension],
                          enabled: event.target.checked,
                        },
                      }))
                    }
                  />
                  <strong>{dimensionLabels[dimension]}</strong>
                </label>
                <div className="manual-score">
                  <input
                    type="range"
                    min="0"
                    max="100"
                    step="1"
                    disabled={!value.enabled}
                    value={value.score}
                    onChange={(event) =>
                      setManual((current) => ({
                        ...current,
                        [dimension]: {
                          ...current[dimension],
                          score: Number(event.target.value),
                        },
                      }))
                    }
                  />
                  <b>{value.enabled ? value.score : '—'}</b>
                </div>
                <input
                  aria-label={`${dimensionLabels[dimension]}人工证据`}
                  disabled={!value.enabled}
                  placeholder="记录具体镜头、台词或声音证据"
                  value={value.note}
                  onChange={(event) =>
                    setManual((current) => ({
                      ...current,
                      [dimension]: {
                        ...current[dimension],
                        note: event.target.value,
                      },
                    }))
                  }
                />
              </article>
            );
          })}
        </div>
      </section>

      {!selected ? (
        <EmptyState
          title="尚无评测报告"
          detail="先选择检查点。可以只生成自动证据报告，也可以在看片/试听后加入人工评分。"
        />
      ) : (
        <section className="evaluation-report">
          <header className="evaluation-report-head">
            <div>
              <span className="eyebrow">{selected.scope} evaluation</span>
              <h3>{selected.title}</h3>
              <small>{formatTime(selected.createdAt)}</small>
            </div>
            <div className="evaluation-verdict">
              <StatusTag value={verdict(selected).label} tone={verdict(selected).tone} />
              {selected.stale && <StatusTag value="项目已变化" tone="warn" />}
            </div>
            <strong>{selected.overallScore}</strong>
          </header>
          <div className="evaluation-coverage">
            <div>
              <span>自动证据覆盖</span>
              <strong>{selected.evidenceCoverage}%</strong>
              <small>直接文件证据计满；结构代理只计一半</small>
            </div>
            <div>
              <span>人工评审覆盖</span>
              <strong>{selected.humanCoverage}%</strong>
              <small>低于 50% 不会给出最终“通过”</small>
            </div>
            <div>
              <span>输入版本</span>
              <strong>{selected.inputHash.slice(0, 8)}</strong>
              <small>{selected.stale ? '报告已过期，建议重跑' : '与当前项目一致'}</small>
            </div>
          </div>
          <div className="evaluation-dimensions">
            {selected.dimensions.map((dimension) => (
              <article key={dimension.id}>
                <header>
                  <div>
                    <span className="eyebrow">Weight {dimension.weight}%</span>
                    <h4>{dimension.label}</h4>
                  </div>
                  <strong>{dimension.score}</strong>
                </header>
                <div className="evaluation-score-split">
                  <span>自动 {dimension.automaticScore}</span>
                  <span>
                    人工 {dimension.manualScore === undefined ? '未评' : dimension.manualScore}
                  </span>
                  <span>置信度 {(dimension.confidence * 100).toFixed(0)}%</span>
                </div>
                <p>{dimension.summary}</p>
                {dimension.manualNote && (
                  <blockquote>{dimension.manualNote}</blockquote>
                )}
                <details>
                  <summary>查看 {dimension.checks.length} 项证据</summary>
                  <div className="evaluation-checks">
                    {dimension.checks.map((check) => (
                      <div key={check.id}>
                        <StatusTag
                          value={check.status}
                          tone={
                            check.status === 'pass'
                              ? 'good'
                              : check.status === 'warn'
                                ? 'warn'
                                : 'bad'
                          }
                        />
                        <strong>{check.label}</strong>
                        <span>
                          {check.score.toFixed(1)} / {check.maxScore}
                        </span>
                        <p>{check.evidence}</p>
                        <small>{check.evidenceKind}</small>
                      </div>
                    ))}
                  </div>
                </details>
              </article>
            ))}
          </div>
        </section>
      )}

      {reports.length > 0 && (
        <section className="evaluation-history">
          <div className="subhead">
            <span className="eyebrow">Immutable reports</span>
            <h3>历史报告</h3>
          </div>
          {reports.map((report) => (
            <button
              className={selectedId === report.id ? 'active' : ''}
              key={report.id}
              onClick={() => setSelectedId(report.id)}
            >
              <span>{formatTime(report.createdAt)}</span>
              <strong>{report.title}</strong>
              <b>{report.overallScore}</b>
              <StatusTag
                value={report.stale ? '过期' : verdict(report).label}
                tone={report.stale ? 'warn' : verdict(report).tone}
              />
            </button>
          ))}
        </section>
      )}

      <section className="benchmark-board">
        <header className="benchmark-head">
          <div>
            <span className="eyebrow">Provider / artifact benchmark</span>
            <h3>LibTV 与本地管线产物对比</h3>
            <p>
              同一套人工量表对比人物一致性、构图、镜头语言、动作、伪影和配音。费用未由供应商返回时保持“未知”。
            </p>
          </div>
          <button
            className="button primary"
            disabled={benchmarkSelection.length < 2 || benchmarkBusy}
            onClick={() => void createBenchmark()}
          >
            {benchmarkBusy
              ? '正在保存对比…'
              : `保存对比报告（${benchmarkSelection.length}/4）`}
          </button>
        </header>
        {!candidates.length ? (
          <div className="benchmark-empty">
            外部画布回收结果、已圈选关键帧、视频 take 或最终成片出现后，才会进入候选池。
          </div>
        ) : (
          <div className="benchmark-candidates">
            {candidates.map((candidate) => {
              const selectedCandidate = benchmarkSelection.includes(candidate.id);
              const rating =
                benchmarkRatings[candidate.id] ?? initialBenchmarkRating();
              return (
                <article
                  className={selectedCandidate ? 'selected' : ''}
                  key={candidate.id}
                >
                  <div className="benchmark-preview">
                    {candidate.url && candidate.kind === 'video' ? (
                      <video src={candidate.url} controls preload="metadata" />
                    ) : candidate.url ? (
                      <img src={candidate.url} alt={candidate.label} loading="lazy" />
                    ) : (
                      <div className="media-placeholder">不可预览</div>
                    )}
                    <StatusTag
                      value={candidate.source === 'libtv' ? 'LIBTV' : 'PIPELINE'}
                      tone={candidate.source === 'libtv' ? 'warn' : 'neutral'}
                    />
                  </div>
                  <header>
                    <div>
                      <strong>{candidate.label}</strong>
                      <small>
                        {candidate.provider}
                        {candidate.model ? ` / ${candidate.model}` : ''}
                      </small>
                    </div>
                    <button
                      className={selectedCandidate ? 'button primary' : 'button ghost'}
                      onClick={() => toggleBenchmark(candidate.id)}
                    >
                      {selectedCandidate ? '已加入对比' : '加入对比'}
                    </button>
                  </header>
                  <div className="benchmark-cost">
                    <span>{candidate.kind === 'image' ? '图片' : '视频'}</span>
                    <span>
                      费用{' '}
                      {candidate.costKnown && candidate.costCny !== undefined
                        ? `¥${candidate.costCny.toFixed(2)}`
                        : '未知'}
                    </span>
                  </div>
                  {selectedCandidate && (
                    <div className="benchmark-rating">
                      {criteriaFor(candidate).map((criterion) => (
                        <label key={criterion.id}>
                          <span>
                            <strong>{criterion.label}</strong>
                            <small>{criterion.detail}</small>
                          </span>
                          <input
                            type="range"
                            min="0"
                            max="100"
                            value={rating.criteria[criterion.id]}
                            onChange={(event) =>
                              setBenchmarkRatings((current) => ({
                                ...current,
                                [candidate.id]: {
                                  ...rating,
                                  criteria: {
                                    ...rating.criteria,
                                    [criterion.id]: Number(event.target.value),
                                  },
                                },
                              }))
                            }
                          />
                          <b>{rating.criteria[criterion.id]}</b>
                        </label>
                      ))}
                      <textarea
                        aria-label={`${candidate.label}评测证据`}
                        placeholder="记录具体帧、动作、台词或声音证据"
                        value={rating.note}
                        onChange={(event) =>
                          setBenchmarkRatings((current) => ({
                            ...current,
                            [candidate.id]: {
                              ...rating,
                              note: event.target.value,
                            },
                          }))
                        }
                      />
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
        {benchmarks[0] && (
          <div className="benchmark-result">
            <div className="subhead">
              <span className="eyebrow">Latest comparison</span>
              <h3>{benchmarks[0].title}</h3>
            </div>
            {benchmarks[0].items.map((item) => (
              <div className="benchmark-rank" key={item.candidate.id}>
                <strong>#{item.rank}</strong>
                <div>
                  <b>{item.candidate.label}</b>
                  <small>
                    {item.technical.width}×{item.technical.height}
                    {item.technical.durationSec !== undefined
                      ? ` · ${item.technical.durationSec.toFixed(2)}s`
                      : ''}
                    {' · '}
                    {(item.technical.bytes / 1_024 / 1_024).toFixed(1)}MB
                  </small>
                </div>
                <span>{item.score}</span>
                <p>{item.note || '未填写补充证据'}</p>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
