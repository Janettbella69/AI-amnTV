import { useMemo, useState } from 'react';
import { api } from '../api';
import type { SeriesSummary, Workspace } from '../types';

const skillIdeas = [
  {
    code: 'DRAMA',
    title: '爆款漫剧策划',
    prompt:
      '被裁掉的女孩发现公司用她训练出的 AI 取代自己。请做成 90 秒女性逆袭漫剧，开场 3 秒抓人，结尾留追更钩子。',
  },
  {
    code: 'SHOT',
    title: '导演级分镜',
    prompt:
      '一场退婚宴上的当众反转。请按情绪节拍拆出可生产的竖屏分镜，优先保证角色一致性和视线连续。',
  },
  {
    code: 'VOICE',
    title: '差异化配音',
    prompt:
      '双女主暗中较量的对手戏。请为两人建立不撞声的音色方案，并按台词情绪规划表演层次。',
  },
];

function projectMedia(workspace: Workspace | undefined): string | undefined {
  if (workspace?.state.delivery?.coverUrl) return workspace.state.delivery.coverUrl;
  for (const cut of workspace?.storyboard.cuts ?? []) {
    if (cut.selectedKeyframeUrls[0]) return cut.selectedKeyframeUrls[0];
    const candidate = Object.values(cut.candidates).flat()[0]?.url;
    if (candidate) return candidate;
  }
  return workspace?.assets.characters[0]?.previewUrl;
}

export function Home({
  series,
  workspace,
  onLaunched,
  onOpenSeries,
  onImport,
  onEnterStudio,
  onCreate,
}: {
  series: SeriesSummary[];
  workspace: Workspace | undefined;
  onLaunched: (seriesId: string) => void;
  onOpenSeries: (seriesId: string) => void;
  onImport: () => void;
  onEnterStudio: () => void;
  onCreate: () => void;
}) {
  const [prompt, setPrompt] = useState(
    () => localStorage.getItem('amntv-home-prompt') ?? '',
  );
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const currentMedia = projectMedia(workspace);
  const showcases = useMemo(
    () =>
      (workspace?.storyboard.cuts ?? [])
        .map((cut) => {
          const image =
            cut.selectedKeyframeUrls[0] ??
            Object.values(cut.candidates).flat()[0]?.url;
          return image
            ? {
                id: cut.id,
                image,
                title: cut.action,
                meta: `${cut.shotSize} · ${cut.camera.move.replace('_', ' ')} · ${cut.durationSec}s`,
              }
            : undefined;
        })
        .filter((item): item is NonNullable<typeof item> => Boolean(item))
        .slice(0, 8),
    [workspace],
  );

  const submit = async () => {
    const idea = prompt.trim();
    if (!idea || creating) return;
    setCreating(true);
    setError('');
    try {
      const id = `s${Date.now().toString(36)}`;
      const firstLine = idea.split('\n')[0]?.trim() ?? idea;
      const created = await api.createSeries({
        id,
        title: firstLine.slice(0, 12) || 'AI 漫剧系列',
        genre: '女性向漫剧',
        logline: idea.slice(0, 50),
      });
      localStorage.setItem('amntv-home-prompt', idea);
      onLaunched(created.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="amn-home">
      <header className="home-nav">
        <button className="home-brand" onClick={() => window.scrollTo({ top: 0 })}>
          <span>AM</span>
          <strong>AI-amnTV</strong>
        </button>
        <nav aria-label="官网导航">
          <a href="#showcase">作品</a>
          <a
            href="https://github.com/Janettbella69/AI-amnTV"
            target="_blank"
            rel="noreferrer"
          >
            GitHub
          </a>
        </nav>
        <div className="home-nav-actions">
          <button className="home-link-button" onClick={onImport}>
            导入项目
          </button>
          <button className="home-solid-button" onClick={onEnterStudio}>
            进入工作台
          </button>
        </div>
      </header>

      <main>
        <section className="home-hero" id="product">
          <div className="home-hero-copy">
            <span className="home-kicker">AI VERTICAL DRAMA STUDIO</span>
            <h1>
              一句灵感，
              <br />
              落进生产图的第一格。
            </h1>
            <p>
              写下你的故事，它会成为生产图上的第一个节点——剧本、角色、分镜、
              配音、画面在同一张图里接力，AI 提方案，人决定表演与成片。
            </p>
          </div>

          <div className="home-brief" data-creating={creating || undefined}>
            <header className="home-brief-node" aria-hidden="true">
              <span>SRC</span>
              <small>EP00 · 灵感</small>
              <i />
            </header>
            <label className="visually-hidden" htmlFor="home-idea">
              描述你想做的故事
            </label>
            <textarea
              id="home-idea"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                  void submit();
                }
              }}
              placeholder="例如：被裁掉的女孩发现公司用她训练出的 AI 取代自己。请把它做成 90 秒女性逆袭漫剧，开场 3 秒必须抓人，结尾留追更钩子。"
            />
            <div className="home-brief-tools">
              <div>
                <button title="导入小说、剧本或项目" onClick={onImport}>
                  ＋
                </button>
                <button title="创建空白系列" onClick={onCreate}>
                  新建
                </button>
                <span>竖屏 9:16 · 单集 60–120 秒</span>
              </div>
              <button
                className="home-submit"
                disabled={!prompt.trim() || creating}
                onClick={() => void submit()}
              >
                {creating ? '正在创建系列…' : '开始创作'}
                <span>↑</span>
              </button>
            </div>
            {error && <p className="home-brief-error">{error}</p>}
          </div>

          <div className="home-skill-row" id="skills">
            {skillIdeas.map((skill) => (
              <button key={skill.code} onClick={() => setPrompt(skill.prompt)}>
                <span>{skill.code}</span>
                {skill.title}
              </button>
            ))}
            <span className="home-skill-hint">点击填入输入框，可再修改</span>
          </div>

          <div className="home-proof">
            <span>一张生产图</span>
            <b />
            <span>角色与声音资产</span>
            <b />
            <span>人工关卡</span>
            <b />
            <span>证据评测与交付</span>
          </div>
        </section>

        <section className="home-projects">
          <header className="home-section-head">
            <div>
              <span>YOUR PRODUCTIONS</span>
              <h2>继续最近项目</h2>
            </div>
            <button onClick={onEnterStudio}>打开工作台 →</button>
          </header>
          <div className="home-project-grid">
            <button className="home-new-project" onClick={onImport}>
              <span>＋</span>
              <strong>导入或开始新项目</strong>
              <small>小说 / 剧本 / AI-amnTV 项目</small>
            </button>
            {series.slice(0, 4).map((item, index) => (
              <button
                className="home-project-card"
                key={item.id}
                onClick={() => onOpenSeries(item.id)}
              >
                <div className="home-project-cover">
                  {index === 0 && currentMedia ? (
                    <img src={currentMedia} alt="" />
                  ) : (
                    <span>
                      {item.genre}
                      <small>等待首帧</small>
                    </span>
                  )}
                  <i>{item.episodeIds.length || 0} 集</i>
                </div>
                <strong>{item.title}</strong>
                <small>{item.logline}</small>
              </button>
            ))}
          </div>
        </section>

        <section className="home-showcase" id="showcase">
          <header className="home-section-head">
            <div>
              <span>PRODUCTION SHOWCASE</span>
              <h2>作品与镜头过程</h2>
            </div>
            <p>展示当前项目的真实关键帧，不用虚构案例填充页面。</p>
          </header>
          {showcases.length ? (
            <div className="home-show-grid">
              {showcases.map((item, index) => (
                <article
                  className={index === 0 ? 'featured' : ''}
                  key={item.id}
                  onClick={onEnterStudio}
                >
                  <img src={item.image} alt={item.title} loading="lazy" />
                  <div>
                    <span>{item.id}</span>
                    <strong>{item.title}</strong>
                    <small>{item.meta}</small>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <button className="home-show-empty" onClick={onImport}>
              <span>[ 作品关键帧 ]</span>
              <strong>导入一个项目后，这里会出现真实镜头与创作过程</strong>
              <small>不使用与当前项目无关的演示素材</small>
            </button>
          )}
        </section>
      </main>

      <footer className="home-footer">
        <div>
          <span className="home-footer-mark">AM</span>
          <strong>AI-amnTV</strong>
        </div>
        <p>面向 AI 漫剧团队的本地优先生产系统</p>
        <button onClick={onEnterStudio}>打开创作画布 →</button>
      </footer>
    </div>
  );
}
