import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { StatusTag } from '../components/Common';
import type {
  JobType,
  StudioJob,
  StudioTab,
  WorkflowStage,
  WorkflowView,
  Workspace,
} from '../types';

type Point = { x: number; y: number };
export type CanvasView = 'graph' | 'storyboard';
type ScratchKind = 'text' | 'image' | 'video' | 'audio';

interface ScratchNode {
  id: string;
  kind: ScratchKind;
  title: string;
  note: string;
}

interface GraphNode {
  id: string;
  code: string;
  title: string;
  detail: string;
  status: WorkflowStage['status'] | 'source' | 'scratch';
  progress: number;
  stage?: WorkflowStage | undefined;
  media?: string | undefined;
  kind: 'source' | 'stage' | ScratchKind;
}

const DEFAULT_LAYOUT: Record<string, Point> = {
  source: { x: 72, y: 70 },
  script: { x: 72, y: 310 },
  cast: { x: 370, y: 120 },
  storyboard: { x: 370, y: 390 },
  keyframes: { x: 675, y: 245 },
  audio: { x: 675, y: 545 },
  canvas: { x: 980, y: 55 },
  video: { x: 980, y: 360 },
  compose: { x: 1285, y: 260 },
  evaluation: { x: 1285, y: 560 },
  final: { x: 1575, y: 300 },
};

const EDGES: Array<[string, string]> = [
  ['source', 'script'],
  ['script', 'cast'],
  ['cast', 'storyboard'],
  ['storyboard', 'keyframes'],
  ['storyboard', 'audio'],
  ['keyframes', 'canvas'],
  ['keyframes', 'video'],
  ['audio', 'video'],
  ['video', 'compose'],
  ['video', 'evaluation'],
  ['compose', 'final'],
  ['evaluation', 'final'],
];

const nodeKind: Record<string, string> = {
  source: 'SRC',
  script: 'TXT',
  cast: 'ID',
  storyboard: 'SHOT',
  audio: 'AUD',
  keyframes: 'IMG',
  canvas: 'EXT',
  video: 'VID',
  evaluation: 'QA',
  compose: 'CUT',
  final: 'LOCK',
};

function tone(status: WorkflowStage['status']) {
  if (status === 'complete') return 'good' as const;
  if (status === 'ready' || status === 'active') return 'warn' as const;
  if (status === 'blocked') return 'bad' as const;
  return 'neutral' as const;
}

function statusLabel(status: GraphNode['status']): string {
  return {
    complete: '已完成',
    active: '进行中',
    ready: '可执行',
    blocked: '等待上游',
    optional: '可选能力',
    source: '事实源',
    scratch: '画布草稿',
  }[status];
}

function mediaFor(stageId: string, workspace: Workspace): string | undefined {
  const firstCut = workspace.storyboard.cuts[0];
  if (stageId === 'cast') {
    return (
      workspace.assets.characters[0]?.previewUrl ??
      workspace.assets.locations[0]?.previewUrl
    );
  }
  if (stageId === 'storyboard' || stageId === 'keyframes') {
    return (
      firstCut?.selectedKeyframeUrls[0] ??
      Object.values(firstCut?.candidates ?? {}).flat()[0]?.url
    );
  }
  if (stageId === 'video' || stageId === 'compose') {
    return (
      firstCut?.selectedVideoUrl ??
      workspace.state.delivery?.coverUrl ??
      firstCut?.selectedKeyframeUrls[0]
    );
  }
  if (stageId === 'final') return workspace.state.delivery?.coverUrl;
  return undefined;
}

function scratchLabel(kind: ScratchKind): string {
  return {
    text: '文本笔记',
    image: '图片参考',
    video: '视频参考',
    audio: '声音参考',
  }[kind];
}

export function Workflow({
  workspace,
  jobs,
  view,
  agentOpen,
  onAgentClose,
  onRun,
  onOpen,
}: {
  workspace: Workspace;
  jobs: StudioJob[];
  view: CanvasView;
  agentOpen: boolean;
  onAgentClose: () => void;
  onRun: (type: JobType) => Promise<void>;
  onOpen: (tab: StudioTab) => void;
}) {
  const [workflow, setWorkflow] = useState<WorkflowView>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [zoom, setZoom] = useState(0.74);
  const [selectedId, setSelectedId] = useState('script');
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [agentPrompt, setAgentPrompt] = useState(
    () => localStorage.getItem('amntv-home-prompt') ?? '',
  );
  const [proposal, setProposal] = useState('');
  const [positions, setPositions] =
    useState<Record<string, Point>>(DEFAULT_LAYOUT);
  const [scratchNodes, setScratchNodes] = useState<ScratchNode[]>([]);
  const dragRef = useRef<
    | {
        id: string;
        startX: number;
        startY: number;
        origin: Point;
      }
    | undefined
  >(undefined);
  const storageKey = `amntv-graph:${workspace.series.id}:${workspace.episodeId}`;
  const scratchKey = `${storageKey}:scratch`;
  const jobVersion = useMemo(
    () => jobs.map((job) => `${job.id}:${job.status}:${job.progress}`).join('|'),
    [jobs],
  );

  const load = useCallback(async () => {
    const next = await api.workflow(workspace.series.id, workspace.episodeId);
    setWorkflow(next);
    setSelectedId((current) =>
      current === 'script' && next.nextStageId ? next.nextStageId : current,
    );
  }, [workspace.episodeId, workspace.series.id]);

  useEffect(() => {
    void load().catch((caught) =>
      setError(caught instanceof Error ? caught.message : String(caught)),
    );
  }, [jobVersion, load, workspace.state.gates, workspace.state.delivery]);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      const savedScratch = localStorage.getItem(scratchKey);
      setPositions(saved ? { ...DEFAULT_LAYOUT, ...JSON.parse(saved) } : DEFAULT_LAYOUT);
      setScratchNodes(savedScratch ? JSON.parse(savedScratch) : []);
    } catch {
      setPositions(DEFAULT_LAYOUT);
      setScratchNodes([]);
    }
  }, [scratchKey, storageKey]);

  useEffect(() => {
    const move = (event: PointerEvent) => {
      const dragging = dragRef.current;
      if (!dragging) return;
      setPositions((current) => ({
        ...current,
        [dragging.id]: {
          x: Math.max(
            18,
            dragging.origin.x + (event.clientX - dragging.startX) / zoom,
          ),
          y: Math.max(
            18,
            dragging.origin.y + (event.clientY - dragging.startY) / zoom,
          ),
        },
      }));
    };
    const end = () => {
      if (!dragRef.current) return;
      dragRef.current = undefined;
      setPositions((current) => {
        localStorage.setItem(storageKey, JSON.stringify(current));
        return current;
      });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
    };
  }, [storageKey, zoom]);

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

  const nodes = useMemo<GraphNode[]>(() => {
    const source: GraphNode = {
      id: 'source',
      code: '00',
      title: `原始资料 · ${workspace.episodeId}`,
      detail: workspace.series.logline,
      status: 'source',
      progress: 100,
      kind: 'source',
    };
    const stages =
      workflow?.stages.map((stage) => ({
        id: stage.id,
        code: stage.code,
        title: stage.label,
        detail: stage.detail,
        status: stage.status,
        progress: stage.progress,
        stage,
        media: mediaFor(stage.id, workspace),
        kind: 'stage' as const,
      })) ?? [];
    const scratch = scratchNodes.map<GraphNode>((node) => ({
      id: node.id,
      code: nodeKind[node.kind] ?? node.kind.toUpperCase(),
      title: node.title,
      detail: node.note,
      status: 'scratch',
      progress: 0,
      kind: node.kind,
    }));
    return [source, ...stages, ...scratch];
  }, [scratchNodes, workflow?.stages, workspace]);

  const selected = nodes.find((node) => node.id === selectedId) ?? nodes[0];
  const stageMap = useMemo(
    () => new Map(workflow?.stages.map((stage) => [stage.id, stage]) ?? []),
    [workflow?.stages],
  );

  const addScratch = (kind: ScratchKind) => {
    const id = `scratch-${Date.now()}`;
    const next: ScratchNode = {
      id,
      kind,
      title: `${scratchLabel(kind)} ${scratchNodes.length + 1}`,
      note: '只保存在当前浏览器画布；确认后再晋升为正式资产。',
    };
    const values = [...scratchNodes, next];
    setScratchNodes(values);
    localStorage.setItem(scratchKey, JSON.stringify(values));
    setPositions((current) => ({
      ...current,
      [id]: {
        x: 540 + (values.length % 3) * 270,
        y: 70 + (values.length % 2) * 190,
      },
    }));
    setSelectedId(id);
    setPaletteOpen(false);
  };

  const arrange = () => {
    const scratchPositions = Object.fromEntries(
      scratchNodes.map((node, index) => [
        node.id,
        { x: 1000 + (index % 2) * 270, y: 700 + Math.floor(index / 2) * 190 },
      ]),
    );
    const next = { ...DEFAULT_LAYOUT, ...scratchPositions };
    setPositions(next);
    localStorage.setItem(storageKey, JSON.stringify(next));
  };

  const createProposal = () => {
    const value = agentPrompt.trim();
    if (!value) return;
    localStorage.setItem('amntv-home-prompt', value);
    const blocker = selected?.stage?.blockers[0];
    setProposal(
      blocker
        ? `建议先处理「${blocker}」，再围绕 @${selected.title} 建立一个可回滚分支。系统不会自动执行或产生费用。`
        : `已为 @${selected?.title ?? '当前画布'} 形成执行计划：先锁定输入与人物/声音约束，再生成候选，最后通过人工关卡晋升。系统不会自动执行或产生费用。`,
    );
  };

  const beginDrag = (event: React.PointerEvent, id: string) => {
    if ((event.target as HTMLElement).closest('button')) return;
    const origin = positions[id] ?? { x: 100, y: 100 };
    dragRef.current = {
      id,
      startX: event.clientX,
      startY: event.clientY,
      origin,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  return (
    <div className={`production-workbench ${agentOpen ? 'agent-visible' : ''}`}>
      {error && <div className="workbench-error">{error}</div>}

      <div className="workbench-body">
        <aside className="canvas-tools" aria-label="画布工具">
          <div className="tool-popover-anchor">
            <button
              className={paletteOpen ? 'active' : ''}
              title="添加节点"
              onClick={() => setPaletteOpen((value) => !value)}
            >
              ＋
            </button>
            {paletteOpen && (
              <div className="node-palette">
                <span>添加节点</span>
                <button onClick={() => addScratch('text')}>TXT 文本笔记</button>
                <button onClick={() => addScratch('image')}>IMG 图片参考</button>
                <button onClick={() => addScratch('video')}>VID 视频参考</button>
                <button onClick={() => addScratch('audio')}>AUD 声音参考</button>
                <hr />
                <button onClick={() => onOpen('import')}>SRC 导入生产资料</button>
                <button onClick={() => onOpen('canvas')}>EXT 外部生成引擎</button>
              </div>
            )}
          </div>
          <button title="选择与移动">↖</button>
          <button title="角色资产" onClick={() => onOpen('assets')}>
            ID
          </button>
          <button title="素材库" onClick={() => onOpen('keyframes')}>
            LIB
          </button>
          <button title="历史与任务" onClick={() => onOpen('tasks')}>
            HIS
          </button>
          <button title="证据评测" onClick={() => onOpen('evaluation')}>
            QA
          </button>
        </aside>

        {view === 'graph' ? (
          <section className="graph-viewport" aria-label="可拖拽制作图谱">
            <div
              className="graph-space"
              style={{ transform: `scale(${zoom})` }}
            >
              <div className="graph-zone zone-pre">
                <span>PRE-PRODUCTION / 前期</span>
              </div>
              <div className="graph-zone zone-make">
                <span>GENERATION / 生产</span>
              </div>
              <div className="graph-zone zone-finish">
                <span>FINISHING / 后期与交付</span>
              </div>

              <svg
                className="graph-edges"
                width="1840"
                height="980"
                viewBox="0 0 1840 980"
                aria-hidden="true"
              >
                {EDGES.map(([from, to]) => {
                  const start = positions[from] ?? DEFAULT_LAYOUT[from];
                  const end = positions[to] ?? DEFAULT_LAYOUT[to];
                  if (!start || !end) return null;
                  const x1 = start.x + 240;
                  const y1 = start.y + 78;
                  const x2 = end.x;
                  const y2 = end.y + 78;
                  const bend = Math.max(60, Math.abs(x2 - x1) * 0.45);
                  const active =
                    stageMap.get(to)?.status !== 'blocked' ||
                    to === workflow?.nextStageId;
                  return (
                    <g key={`${from}-${to}`}>
                      <path
                        className={active ? 'active' : ''}
                        d={`M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`}
                      />
                      <circle cx={x2} cy={y2} r="3.5" />
                    </g>
                  );
                })}
              </svg>

              {nodes.map((node) => {
                const point = positions[node.id] ?? {
                  x: 920,
                  y: 720,
                };
                const isNext = workflow?.nextStageId === node.id;
                return (
                  <article
                    className={`graph-node ${node.status} ${selectedId === node.id ? 'selected' : ''} ${isNext ? 'next' : ''}`}
                    key={node.id}
                    style={{ left: point.x, top: point.y }}
                    onClick={() => setSelectedId(node.id)}
                    onPointerDown={(event) => beginDrag(event, node.id)}
                  >
                    <header>
                      <span>{nodeKind[node.id] ?? node.code}</span>
                      <small>{node.code}</small>
                      <i />
                    </header>
                    {node.media && (
                      <div className="graph-node-media">
                        <img src={node.media} alt="" draggable={false} />
                      </div>
                    )}
                    <div className="graph-node-copy">
                      <strong>{node.title}</strong>
                      <p>{node.detail}</p>
                    </div>
                    <footer>
                      <span>{statusLabel(node.status)}</span>
                      <div>
                        <i style={{ width: `${node.progress}%` }} />
                      </div>
                      <b>{Math.round(node.progress)}%</b>
                    </footer>
                    {isNext && <em>下一步</em>}
                  </article>
                );
              })}
            </div>

            <div className="canvas-statusbar">
              <button onClick={arrange}>自动整理</button>
              <button onClick={() => setZoom((value) => Math.max(0.45, value - 0.1))}>
                −
              </button>
              <span>{Math.round(zoom * 100)}%</span>
              <button onClick={() => setZoom((value) => Math.min(1.15, value + 0.1))}>
                ＋
              </button>
              <div className="statusbar-progress" title="必需生产线进度">
                <div>
                  <i style={{ width: `${workflow?.overallProgress ?? 0}%` }} />
                </div>
                <b>{workflow?.overallProgress ?? 0}%</b>
              </div>
              <i>拖动节点调整生产图 · 所有执行仍受人工关卡约束</i>
            </div>
          </section>
        ) : (
          <section className="storyboard-wall">
            <header>
              <div>
                <span className="eyebrow">SHOT WALL</span>
                <h2>{workspace.storyboard.cuts.length} 个镜头 · 竖屏节奏板</h2>
              </div>
              <div>
                <button onClick={() => onOpen('storyboard')}>编辑分镜</button>
                <button onClick={() => onOpen('keyframes')}>圈选关键帧</button>
              </div>
            </header>
            <div className="shot-wall-grid">
              {workspace.storyboard.cuts.map((cut, index) => {
                const image =
                  cut.selectedKeyframeUrls[0] ??
                  Object.values(cut.candidates).flat()[0]?.url;
                const state = workspace.state.cuts[cut.id];
                return (
                  <article key={cut.id}>
                    <div className="shot-index">
                      <span>{String(index + 1).padStart(2, '0')}</span>
                      <b>{cut.id}</b>
                    </div>
                    <div className="shot-preview">
                      {image ? (
                        <img src={image} alt={cut.action} loading="lazy" />
                      ) : (
                        <span>[ 等待关键帧 ]</span>
                      )}
                      <i>{cut.durationSec}s</i>
                    </div>
                    <div className="shot-copy">
                      <strong>{cut.action}</strong>
                      <p>{cut.promptDelta || '尚未填写本镜头的生成增量。'}</p>
                      <div>
                        <span>{cut.shotSize}</span>
                        <span>{cut.camera.move.replace('_', ' ')}</span>
                        <span>{cut.genMode}</span>
                      </div>
                    </div>
                    <footer>
                      <span>{state?.stage ?? 'planned'}</span>
                      <b>{cut.characters.length} 人物</b>
                      <button onClick={() => onOpen('keyframes')}>查看 →</button>
                    </footer>
                  </article>
                );
              })}
            </div>
          </section>
        )}

        {agentOpen && (
          <aside className="context-agent">
            <header>
              <div>
                <span className="agent-mark">A</span>
                <div>
                  <strong>制作 Agent</strong>
                  <small>提案模式 · 执行前确认</small>
                </div>
              </div>
              <button onClick={onAgentClose}>×</button>
            </header>

            <section className="agent-context">
              <span>当前引用</span>
              <button>@ {selected?.title ?? '当前画布'}</button>
              {selected?.stage && (
                <div className="agent-stage-facts">
                  <StatusTag
                    value={statusLabel(selected.stage.status)}
                    tone={tone(selected.stage.status)}
                  />
                  <b>{Math.round(selected.stage.progress)}%</b>
                </div>
              )}
              <p>{selected?.detail}</p>
              {selected?.stage?.blockers.map((blocker) => (
                <small key={blocker}>阻塞：{blocker}</small>
              ))}
              {selected?.stage && (
                <button
                  className="agent-primary-action"
                  disabled={
                    selected.stage.status === 'blocked' ||
                    busy === selected.stage.id
                  }
                  onClick={() => void act(selected.stage!)}
                >
                  {busy === selected.stage.id
                    ? '正在创建任务…'
                    : selected.stage.action.label}
                </button>
              )}
              {selected?.kind === 'source' && (
                <button
                  className="agent-primary-action"
                  onClick={() => onOpen('import')}
                >
                  导入或替换资料
                </button>
              )}
            </section>

            <section className="agent-skills">
              <div>
                <span>推荐 Skills</span>
                <small>基于当前节点</small>
              </div>
              <button
                onClick={() =>
                  setAgentPrompt('检查开场 3 秒、情绪爆点、反转和结尾追更钩子。')
                }
              >
                <span>STORY</span>
                爆款节奏诊断
              </button>
              <button
                onClick={() =>
                  setAgentPrompt('检查主要角色音色是否相似，并给出可表演的差异化方案。')
                }
              >
                <span>VOICE</span>
                配音去同质化
              </button>
              <button
                onClick={() =>
                  setAgentPrompt('检查单集时长、镜头密度、字幕和 AIGC 标识。')
                }
              >
                <span>QC</span>
                平台上线检查
              </button>
            </section>

            {proposal && (
              <section className="agent-proposal">
                <span>执行建议</span>
                <p>{proposal}</p>
                <small>尚未创建任务，也未调用付费模型。</small>
              </section>
            )}

            <section className="agent-composer">
              <textarea
                value={agentPrompt}
                onChange={(event) => setAgentPrompt(event.target.value)}
                placeholder="描述目标，或用 @ 引用当前节点 / 角色 / 镜头…"
              />
              <div>
                <button onClick={() => onOpen('assets')}>@ 资源</button>
                <button onClick={() => onOpen('canvas')}>外部引擎</button>
                <button
                  className="agent-send"
                  disabled={!agentPrompt.trim()}
                  onClick={createProposal}
                >
                  生成计划 ↑
                </button>
              </div>
            </section>
          </aside>
        )}
      </div>
    </div>
  );
}
