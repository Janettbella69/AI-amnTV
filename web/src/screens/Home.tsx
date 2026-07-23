import { useMemo, useState } from 'react';
import type { SeriesSummary, StudioTab, Workspace } from '../types';

const skillIdeas = [
  {
    code: 'DRAMA',
    title: '爆款漫剧策划',
    prompt: '把我的故事整理成 90 秒竖屏漫剧，先给出冲突、爽点、反转和结尾钩子。',
  },
  {
    code: 'SHOT',
    title: '导演级分镜',
    prompt: '按人物情绪和镜头语言拆出可生产的分镜，优先保证角色一致性。',
  },
  {
    code: 'VOICE',
    title: '差异化配音',
    prompt: '为主要角色建立不撞声的音色方案，并按台词情绪规划表演层次。',
  },
];

const categories = [
  '全部',
  '女性成长',
  '都市逆袭',
  '悬疑反转',
  '古风幻想',
  '情感治愈',
  '品牌短片',
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
  onEnter,
  onCreate,
}: {
  series: SeriesSummary[];
  workspace: Workspace | undefined;
  onEnter: (tab: StudioTab) => void;
  onCreate: () => void;
}) {
  const [prompt, setPrompt] = useState(
    () => localStorage.getItem('amntv-home-prompt') ?? '',
  );
  const [category, setCategory] = useState('全部');
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

  const launch = (value = prompt) => {
    const next = value.trim();
    if (next) localStorage.setItem('amntv-home-prompt', next);
    onEnter('workflow');
  };

  return (
    <div className="amn-home">
      <header className="home-nav">
        <button className="home-brand" onClick={() => window.scrollTo({ top: 0 })}>
          <span>AM</span>
          <strong>AI-amnTV</strong>
        </button>
        <nav aria-label="官网导航">
          <a href="#product">产品</a>
          <a href="#skills">Skills</a>
          <a href="#showcase">作品展</a>
          <a href="#opensource">开放生态</a>
        </nav>
        <div className="home-nav-actions">
          <button className="home-link-button" onClick={() => onEnter('import')}>
            导入项目
          </button>
          <button className="home-solid-button" onClick={() => onEnter('workflow')}>
            进入工作台
          </button>
        </div>
      </header>

      <main>
        <section className="home-hero" id="product">
          <div className="home-hero-copy">
            <span className="home-kicker">AI VERTICAL DRAMA STUDIO</span>
            <h1>
              从一个故事，
              <br />
              到一部能上线的漫剧。
            </h1>
            <p>
              剧本、角色、分镜、配音、画面、评测与交付在同一张生产图里协作。
              AI 提方案，人决定表演与成片。
            </p>
          </div>

          <div className="home-brief">
            <label htmlFor="home-idea">描述你想做的故事</label>
            <textarea
              id="home-idea"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="例如：被裁掉的女孩发现公司用她训练出的 AI 取代自己。请把它做成 90 秒女性逆袭漫剧，开场 3 秒必须抓人，结尾留追更钩子。"
            />
            <div className="home-brief-tools">
              <div>
                <button title="导入小说、剧本或项目" onClick={() => onEnter('import')}>
                  ＋
                </button>
                <button title="创建空白系列" onClick={onCreate}>
                  新建
                </button>
                <span>目标单集 55–120 秒</span>
              </div>
              <button
                className="home-submit"
                disabled={!prompt.trim()}
                onClick={() => launch()}
              >
                开始策划
                <span>↗</span>
              </button>
            </div>
          </div>

          <div className="home-skill-row" id="skills">
            {skillIdeas.map((skill) => (
              <button key={skill.code} onClick={() => launch(skill.prompt)}>
                <span>{skill.code}</span>
                {skill.title}
              </button>
            ))}
            <button className="all-skills" onClick={() => onEnter('workflow')}>
              全部 Skills <span>→</span>
            </button>
          </div>

          <div className="home-proof">
            <span>LOCAL-FIRST</span>
            <b />
            <span>HUMAN GATES</span>
            <b />
            <span>VOICE IDENTITY</span>
            <b />
            <span>EVIDENCE QA</span>
          </div>
        </section>

        <section className="home-projects">
          <header className="home-section-head">
            <div>
              <span>YOUR PRODUCTIONS</span>
              <h2>继续最近项目</h2>
            </div>
            <button onClick={() => onEnter('overview')}>全部项目 →</button>
          </header>
          <div className="home-project-grid">
            <button className="home-new-project" onClick={() => onEnter('import')}>
              <span>＋</span>
              <strong>导入或开始新项目</strong>
              <small>小说 / 剧本 / AI-amnTV 项目</small>
            </button>
            {series.slice(0, 4).map((item, index) => (
              <button
                className="home-project-card"
                key={item.id}
                onClick={() => onEnter('workflow')}
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
          <div className="home-category-row">
            {categories.map((item) => (
              <button
                key={item}
                className={category === item ? 'active' : ''}
                onClick={() => setCategory(item)}
              >
                {item}
              </button>
            ))}
          </div>
          {showcases.length ? (
            <div className="home-show-grid">
              {showcases.map((item, index) => (
                <article
                  className={index === 0 ? 'featured' : ''}
                  key={item.id}
                  onClick={() => onEnter('keyframes')}
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
            <button className="home-show-empty" onClick={() => onEnter('import')}>
              <span>[ 作品关键帧 ]</span>
              <strong>导入一个项目后，这里会出现真实镜头与创作过程</strong>
              <small>不使用与当前项目无关的演示素材</small>
            </button>
          )}
        </section>

        <section className="home-product-strip" id="opensource">
          <div>
            <span>01</span>
            <h3>一张生产图</h3>
            <p>素材、脚本、角色、镜头和成片保留引用关系，分支重做不推倒重来。</p>
          </div>
          <div>
            <span>02</span>
            <h3>不像别人的声音</h3>
            <p>音色身份、台词情绪和实际时长进入角色资产，而不是最后统一套模板。</p>
          </div>
          <div>
            <span>03</span>
            <h3>能审、能算、能交付</h3>
            <p>人工关卡、证据评测、费用账本和平台规格从第一天就在项目里。</p>
          </div>
        </section>
      </main>

      <footer className="home-footer">
        <div>
          <span className="home-footer-mark">AM</span>
          <strong>AI-amnTV</strong>
        </div>
        <p>面向 AI 漫剧团队的本地优先生产系统</p>
        <button onClick={() => onEnter('workflow')}>打开创作画布 →</button>
      </footer>
    </div>
  );
}
