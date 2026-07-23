import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from './api';
import { EmptyState, ProgressBar, StatusTag } from './components/Common';
import { Assets } from './screens/Assets';
import { Costs } from './screens/Costs';
import { Delivery } from './screens/Delivery';
import { EvaluationCenter } from './screens/EvaluationCenter';
import { Home } from './screens/Home';
import { Keyframes } from './screens/Keyframes';
import { ImportCenter } from './screens/ImportCenter';
import { LibTvCanvas } from './screens/LibTvCanvas';
import { Overview } from './screens/Overview';
import { ScriptEditor } from './screens/ScriptEditor';
import { StoryboardEditor } from './screens/StoryboardEditor';
import { TaskCenter } from './screens/TaskCenter';
import { Workflow } from './screens/Workflow';
import type {
  CharacterAsset,
  Cut,
  ImportResult,
  JobType,
  LocationAsset,
  ScriptDocument,
  SeriesSummary,
  StoryboardDocument,
  StudioJob,
  StudioTab,
  Workspace,
} from './types';

const tabs: Array<[StudioTab, string, string]> = [
  ['import', '导入', 'IN'],
  ['workflow', '创作画布', 'WF'],
  ['overview', '项目总览', 'OV'],
  ['script', '剧本', 'SC'],
  ['storyboard', '分镜', 'SB'],
  ['canvas', '外部引擎', 'EX'],
  ['keyframes', '关键帧', 'KF'],
  ['assets', '资产库', 'AS'],
  ['evaluation', '评测', 'QA'],
  ['tasks', '任务', 'Q'],
  ['costs', '成本', '¥'],
  ['delivery', '交付', 'DL'],
];
const studioTabs = new Set(tabs.map(([id]) => id));

function initialTab(): StudioTab {
  const requested = new URLSearchParams(window.location.search).get('tab');
  if (requested && studioTabs.has(requested as StudioTab)) {
    return requested as StudioTab;
  }
  const stored = localStorage.getItem('amntv-tab');
  return stored && studioTabs.has(stored as StudioTab)
    ? (stored as StudioTab)
    : 'import';
}

type Theme = 'graphite' | 'paper' | 'projector';
type Density = 'compact' | 'comfortable';
type Surface = 'home' | 'studio';

function NewSeriesDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [form, setForm] = useState({
    id: '',
    title: '',
    genre: '女性向漫剧',
    logline: '',
  });
  const [error, setError] = useState('');
  if (!open) return null;
  const submit = async () => {
    try {
      setError('');
      const created = await api.createSeries(form);
      onCreated(created.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="modal-sheet create-series"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-series-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <span className="eyebrow">New production</span>
        <h2 id="new-series-title">创建漫剧系列</h2>
        <label className="field">
          <span>系列 ID</span>
          <input
            autoFocus
            placeholder="my-series"
            value={form.id}
            onChange={(event) => setForm({ ...form, id: event.target.value })}
          />
        </label>
        <label className="field">
          <span>系列名</span>
          <input
            value={form.title}
            onChange={(event) => setForm({ ...form, title: event.target.value })}
          />
        </label>
        <label className="field">
          <span>类型</span>
          <input
            value={form.genre}
            onChange={(event) => setForm({ ...form, genre: event.target.value })}
          />
        </label>
        <label className="field">
          <span>一句话故事</span>
          <textarea
            value={form.logline}
            onChange={(event) => setForm({ ...form, logline: event.target.value })}
          />
        </label>
        {error && <p className="error-text">{error}</p>}
        <div className="button-row end">
          <button className="button ghost" onClick={onClose}>
            取消
          </button>
          <button
            className="button primary"
            disabled={!form.id || !form.title || !form.logline}
            onClick={() => void submit()}
          >
            创建系列
          </button>
        </div>
      </section>
    </div>
  );
}

function RetakeDialog({
  cut,
  onClose,
  onSubmit,
}: {
  cut: Cut | undefined;
  onClose: () => void;
  onSubmit: (
    cutId: string,
    stage: 'keyframe' | 'video',
    instruction: string,
  ) => Promise<void>;
}) {
  const [stage, setStage] = useState<'keyframe' | 'video'>('keyframe');
  const [instruction, setInstruction] = useState('');
  useEffect(() => {
    setStage('keyframe');
    setInstruction('');
  }, [cut]);
  if (!cut) return null;
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="modal-sheet retake-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="retake-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <span className="eyebrow">Selective invalidation</span>
        <h2 id="retake-title">局部重做 · {cut.id}</h2>
        <p>{cut.action}</p>
        <div className="segmented">
          <button
            className={stage === 'keyframe' ? 'active' : ''}
            onClick={() => setStage('keyframe')}
          >
            重做关键帧
          </button>
          <button
            className={stage === 'video' ? 'active' : ''}
            onClick={() => setStage('video')}
          >
            只重做视频
          </button>
        </div>
        <label className="field">
          <span>调整指令</span>
          <textarea
            autoFocus
            placeholder="例如：女主视线更坚定，镜头减慢并保持稳定"
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
          />
        </label>
        <p className="small-note">
          将创建新的 round 和 retake ticket；旧候选与 take 保留，成片批准自动失效。
        </p>
        <div className="button-row end">
          <button className="button ghost" onClick={onClose}>
            取消
          </button>
          <button
            className="button primary"
            disabled={!instruction.trim()}
            onClick={() => void onSubmit(cut.id, stage, instruction)}
          >
            创建重做任务
          </button>
        </div>
      </section>
    </div>
  );
}

function NewEpisode({
  series,
  jobs,
  onEnqueue,
}: {
  series: SeriesSummary;
  jobs: StudioJob[];
  onEnqueue: (episodeId: string, outline: string) => Promise<void>;
}) {
  const sourceDraft = series.sourceDrafts[0];
  const [episodeId, setEpisodeId] = useState(
    sourceDraft?.episodeId ?? 'EP01',
  );
  const [outline, setOutline] = useState(sourceDraft?.content ?? '');
  useEffect(() => {
    setEpisodeId(sourceDraft?.episodeId ?? 'EP01');
    setOutline(sourceDraft?.content ?? '');
  }, [series.id, sourceDraft?.content, sourceDraft?.episodeId]);
  const active = jobs.find((job) =>
    ['queued', 'running'].includes(job.status),
  );
  return (
    <div className="new-episode">
      <span className="eyebrow">First episode</span>
      <h1>{series.title}</h1>
      <p>{series.logline}</p>
      <div className="new-episode-form">
        <label className="field">
          <span>分集 ID</span>
          <input
            value={episodeId}
            onChange={(event) => setEpisodeId(event.target.value.toUpperCase())}
          />
        </label>
        <label className="field wide">
          <span>本集大纲</span>
          <textarea
            placeholder="开场冲突、第一次爆点、爽点、反转与结尾钩子……"
            value={outline}
            onChange={(event) => setOutline(event.target.value)}
          />
        </label>
        <button
          className="button primary"
          disabled={!/^EP\d{2,}$/.test(episodeId) || !outline.trim() || Boolean(active)}
          onClick={() => void onEnqueue(episodeId, outline)}
        >
          {active ? '剧本任务运行中' : '创建分集并生成剧本'}
        </button>
      </div>
      {active && (
        <div className="new-episode-progress">
          <span>{active.message}</span>
          <ProgressBar value={active.progress} />
          <b>{active.progress}%</b>
        </div>
      )}
    </div>
  );
}

export function App() {
  const [surface, setSurface] = useState<Surface>(() =>
    new URLSearchParams(window.location.search).get('view') === 'studio'
      ? 'studio'
      : 'home',
  );
  const [series, setSeries] = useState<SeriesSummary[]>([]);
  const [seriesId, setSeriesId] = useState(
    () => localStorage.getItem('amntv-series') ?? '',
  );
  const [episodeId, setEpisodeId] = useState(
    () => localStorage.getItem('amntv-episode') ?? '',
  );
  const [workspace, setWorkspace] = useState<Workspace>();
  const [jobs, setJobs] = useState<StudioJob[]>([]);
  const [tab, setTab] = useState<StudioTab>(initialTab);
  const [theme, setTheme] = useState<Theme>(
    () => (localStorage.getItem('amntv-theme') as Theme | null) ?? 'graphite',
  );
  const [density, setDensity] = useState<Density>(
    () =>
      (localStorage.getItem('amntv-density') as Density | null) ?? 'comfortable',
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [newSeriesOpen, setNewSeriesOpen] = useState(false);
  const [retakeCut, setRetakeCut] = useState<Cut>();

  const selectedSeries = useMemo(
    () => series.find((item) => item.id === seriesId),
    [series, seriesId],
  );

  const loadSeries = useCallback(async () => {
    const values = await api.series();
    setSeries(values);
    setSeriesId((current) => {
      if (values.some((item) => item.id === current)) return current;
      return values[0]?.id ?? '';
    });
  }, []);

  const loadJobs = useCallback(async () => {
    setJobs(await api.jobs(seriesId || undefined, episodeId || undefined));
  }, [seriesId, episodeId]);

  const loadWorkspace = useCallback(async () => {
    if (!seriesId || !episodeId) {
      setWorkspace(undefined);
      return;
    }
    setWorkspace(await api.workspace(seriesId, episodeId));
  }, [seriesId, episodeId]);

  const refresh = useCallback(async () => {
    try {
      setError('');
      await Promise.all([loadSeries(), loadJobs(), loadWorkspace()]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, [loadJobs, loadSeries, loadWorkspace]);

  useEffect(() => {
    void loadSeries().finally(() => setLoading(false));
  }, [loadSeries]);

  useEffect(() => {
    if (!selectedSeries) return;
    setEpisodeId((current) =>
      selectedSeries.episodeIds.includes(current)
        ? current
        : (selectedSeries.episodeIds[0] ?? ''),
    );
  }, [selectedSeries]);

  useEffect(() => {
    if (loading) return;
    if (seriesId && !series.some((item) => item.id === seriesId)) return;
    localStorage.setItem('amntv-series', seriesId);
    localStorage.setItem('amntv-episode', episodeId);
    void Promise.all([loadWorkspace(), loadJobs()]).catch((caught) =>
      setError(caught instanceof Error ? caught.message : String(caught)),
    );
  }, [series, seriesId, episodeId, loadJobs, loadWorkspace, loading]);

  useEffect(() => {
    const events = new EventSource('/api/events');
    const reloadWorkspace = () => void refresh();
    const reloadJobs = () => void loadJobs();
    events.addEventListener('workspace', reloadWorkspace);
    events.addEventListener('series', reloadWorkspace);
    events.addEventListener('job', reloadJobs);
    events.onerror = () => setError('实时连接暂时中断，正在自动重连');
    events.onopen = () =>
      setError((current) =>
        current.startsWith('实时连接暂时中断') ? '' : current,
      );
    return () => events.close();
  }, [loadJobs, refresh]);

  useEffect(() => {
    localStorage.setItem('amntv-tab', tab);
    const url = new URL(window.location.href);
    if (surface === 'studio') {
      url.searchParams.set('view', 'studio');
      url.searchParams.set('tab', tab);
    } else {
      url.searchParams.delete('view');
      url.searchParams.delete('tab');
    }
    window.history.replaceState({}, '', url);
  }, [surface, tab]);
  useEffect(() => {
    localStorage.setItem('amntv-theme', theme);
  }, [theme]);
  useEffect(() => {
    localStorage.setItem('amntv-density', density);
  }, [density]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 2600);
    return () => clearTimeout(timer);
  }, [notice]);

  const act = async (label: string, operation: () => Promise<unknown>) => {
    try {
      setError('');
      await operation();
      setNotice(label);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const enqueue = async (
    type: JobType,
    payload: Record<string, unknown> = {},
    overrideEpisodeId?: string,
  ) => {
    if (!seriesId || !(overrideEpisodeId ?? episodeId)) return;
    await act(`${type} 已加入任务队列`, () =>
      api.enqueue(seriesId, overrideEpisodeId ?? episodeId, type, payload),
    );
  };

  const approve = async (
    gate: 'script' | 'cast' | 'storyboard' | 'keyframes' | 'final',
    picks: Record<string, number> = {},
  ) => {
    if (!seriesId || !episodeId) return;
    await act(`关卡 ${gate} 已批准`, () =>
      api.approve(seriesId, episodeId, gate, picks),
    );
  };

  const content = () => {
    if (tab === 'import') {
      return (
        <ImportCenter
          onComplete={async (result: ImportResult) => {
            const values = await api.series();
            setSeries(values);
            setSeriesId(result.seriesId);
            setEpisodeId(result.episodeId ?? '');
            setTab('overview');
            setNotice(
              result.alreadyAvailable
                ? '项目已在当前资料库中'
                : result.kind === 'outline'
                  ? '原始资料已导入，可创建剧本任务'
                  : '生产资料已导入',
            );
          }}
        />
      );
    }
    if (!selectedSeries) {
      return (
        <EmptyState
          title="导入资料或建立新生产线"
          detail="已有小说、剧本或 AI-amnTV 项目可以直接导入；也可以从空白系列开始。"
          actions={
            <>
              <button
                className="button primary"
                onClick={() => setTab('import')}
              >
                导入生产资料
              </button>
              <button
                className="button ghost"
                onClick={() => setNewSeriesOpen(true)}
              >
                创建系列
              </button>
              <button
                className="text-button"
                onClick={() =>
                  void act('验收样例已创建', async () => {
                    const created = await api.createDemo();
                    setSeriesId(created.seriesId);
                    setEpisodeId(created.episodeId);
                  })
                }
              >
                创建 dry-run 样例
              </button>
            </>
          }
        />
      );
    }
    if (!episodeId) {
      return (
        <NewEpisode
          series={selectedSeries}
          jobs={jobs}
          onEnqueue={(nextEpisodeId, outline) =>
            enqueue('script', { outline }, nextEpisodeId)
          }
        />
      );
    }
    if (!workspace) {
      return (
        <EmptyState
          title={loading ? '正在读取项目' : '无法读取分集'}
          detail={error || '请检查本地项目文件是否完整。'}
        />
      );
    }
    const common = { workspace };
    if (tab === 'overview') {
      return <Overview {...common} jobs={jobs} onRun={(type) => void enqueue(type)} />;
    }
    if (tab === 'workflow') {
      return (
        <Workflow
          {...common}
          jobs={jobs}
          onRun={(type) => enqueue(type)}
          onOpen={setTab}
        />
      );
    }
    if (tab === 'script') {
      return (
        <ScriptEditor
          script={workspace.script}
          approved={Boolean(workspace.state.gates.script)}
          onSave={(script: ScriptDocument) =>
            act('剧本已保存', () => api.saveScript(seriesId, episodeId, script))
          }
          onApprove={() => approve('script')}
          onGenerate={(outline) => enqueue('script', { outline })}
        />
      );
    }
    if (tab === 'storyboard') {
      return (
        <StoryboardEditor
          storyboard={workspace.storyboard}
          approved={Boolean(workspace.state.gates.storyboard)}
          onSave={(storyboard: StoryboardDocument) =>
            act('分镜已保存', () =>
              api.saveStoryboard(seriesId, episodeId, storyboard),
            )
          }
          onApprove={() => approve('storyboard')}
          onGenerate={() => enqueue('storyboard')}
          onRetake={setRetakeCut}
        />
      );
    }
    if (tab === 'canvas') return <LibTvCanvas {...common} />;
    if (tab === 'keyframes') {
      return (
        <Keyframes
          {...common}
          onGenerate={() => enqueue('keyframes')}
          onApprove={(picks) => approve('keyframes', picks)}
          onRetake={setRetakeCut}
        />
      );
    }
    if (tab === 'assets') {
      return (
        <Assets
          {...common}
          onRunCast={() => enqueue('cast')}
          onApprove={(picks) => approve('cast', picks)}
          onSaveCharacter={(character: CharacterAsset) =>
            act('角色档案已保存', () => api.saveCharacter(seriesId, character))
          }
          onSaveLocation={(location: LocationAsset) =>
            act('场景档案已保存', () => api.saveLocation(seriesId, location))
          }
        />
      );
    }
    if (tab === 'evaluation') return <EvaluationCenter {...common} />;
    if (tab === 'tasks') {
      return (
        <TaskCenter
          jobs={jobs}
          onCancel={(id) =>
            void act('排队任务已取消', () => api.cancel(id))
          }
        />
      );
    }
    if (tab === 'costs') return <Costs {...common} />;
    return <Delivery {...common} onApprove={() => void approve('final')} />;
  };

  const activeJob = jobs.find((job) =>
    ['queued', 'running'].includes(job.status),
  );
  const enterStudio = (nextTab: StudioTab) => {
    setTab(nextTab);
    setSurface('studio');
  };

  if (surface === 'home') {
    return (
      <div className="home-surface">
        <Home
          series={series}
          workspace={workspace}
          onEnter={enterStudio}
          onCreate={() => setNewSeriesOpen(true)}
        />
        <NewSeriesDialog
          open={newSeriesOpen}
          onClose={() => setNewSeriesOpen(false)}
          onCreated={(id) => {
            setNewSeriesOpen(false);
            setSeriesId(id);
            setSurface('studio');
            setTab('workflow');
            void loadSeries();
          }}
        />
      </div>
    );
  }

  return (
    <div className="studio" data-theme={theme} data-density={density}>
      <aside className="sidebar">
        <button
          className="brand"
          title="返回官网首页"
          onClick={() => setSurface('home')}
        >
          <span className="brand-mark">AM</span>
          <div>
            <strong>AI-amnTV</strong>
            <small>PRODUCTION OS</small>
          </div>
        </button>
        <div className="series-switcher">
          <label htmlFor="series-select">系列</label>
          <select
            id="series-select"
            value={seriesId}
            onChange={(event) => setSeriesId(event.target.value)}
          >
            {!series.length && <option value="">尚无系列</option>}
            {series.map((item) => (
              <option value={item.id} key={item.id}>
                {item.title}
              </option>
            ))}
          </select>
          <label htmlFor="episode-select">分集</label>
          <select
            id="episode-select"
            value={episodeId}
            disabled={!selectedSeries?.episodeIds.length}
            onChange={(event) => setEpisodeId(event.target.value)}
          >
            {!selectedSeries?.episodeIds.length && (
              <option value="">尚无分集</option>
            )}
            {selectedSeries?.episodeIds.map((id) => (
              <option key={id}>{id}</option>
            ))}
          </select>
        </div>
        <nav className="main-nav" aria-label="工作台页面">
          {tabs.map(([id, label, code]) => (
            <button
              key={id}
              className={tab === id ? 'active' : ''}
              onClick={() => setTab(id)}
              disabled={
                !workspace && !['import', 'overview', 'tasks'].includes(id)
              }
            >
              <span>{code}</span>
              {label}
              {id === 'tasks' &&
                jobs.filter((job) => job.status === 'running').length > 0 && (
                  <i />
                )}
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <button
            className="text-button import-link"
            onClick={() => setTab('import')}
          >
            导入资料
          </button>
          <button
            className="text-button new-link"
            onClick={() => setNewSeriesOpen(true)}
          >
            新建系列
          </button>
          <span>本地文件为事实源</span>
        </div>
      </aside>

      <div className="work-area">
        <header className="topbar">
          <div className="production-title">
            <span>
              {workspace?.series.genre ?? selectedSeries?.genre ?? 'AI 漫剧'}
            </span>
            <strong>
              {tab === 'import'
                ? '导入生产资料'
                : tab === 'workflow'
                  ? 'AI 漫剧创作画布'
                : tab === 'canvas'
                  ? '外部生成引擎'
                  : tab === 'evaluation'
                    ? '多维评测中心'
                : workspace?.series.title ??
                  selectedSeries?.title ??
                  '制片工作台'}
            </strong>
            {workspace && (
              <StatusTag
                value={workspace.state.gates.final ? 'PICTURE LOCK' : 'IN PRODUCTION'}
                tone={workspace.state.gates.final ? 'good' : 'warn'}
              />
            )}
          </div>
          <div className="tweaks" aria-label="外观调整">
            <span>环境</span>
            {(['graphite', 'paper', 'projector'] as Theme[]).map((value) => (
              <button
                key={value}
                className={theme === value ? 'active' : ''}
                onClick={() => setTheme(value)}
                title={value}
                aria-label={`切换到 ${value}`}
              />
            ))}
            <button
              className="density-button"
              onClick={() =>
                setDensity((value) =>
                  value === 'compact' ? 'comfortable' : 'compact',
                )
              }
            >
              {density === 'compact' ? '紧凑' : '舒展'}
            </button>
          </div>
        </header>
        {activeJob && (
          <div className="global-progress">
            <span>{activeJob.type}</span>
            <ProgressBar value={activeJob.progress} />
            <strong>{activeJob.message}</strong>
            <b>{activeJob.progress}%</b>
          </div>
        )}
        {error && (
          <div className="alert error">
            <span>{error}</span>
            <button onClick={() => setError('')}>关闭</button>
          </div>
        )}
        {notice && <div className="toast">{notice}</div>}
        <main className={tab === 'workflow' ? 'screen screen-canvas' : 'screen'}>
          {content()}
        </main>
      </div>

      <NewSeriesDialog
        open={newSeriesOpen}
        onClose={() => setNewSeriesOpen(false)}
        onCreated={(id) => {
          setNewSeriesOpen(false);
          setSeriesId(id);
          void loadSeries();
        }}
      />
      <RetakeDialog
        cut={retakeCut}
        onClose={() => setRetakeCut(undefined)}
        onSubmit={async (cutId, stage, instruction) => {
          await act('局部重做已创建', () =>
            api.retake(seriesId, episodeId, { cutId, stage, instruction }),
          );
          setRetakeCut(undefined);
        }}
      />
    </div>
  );
}
