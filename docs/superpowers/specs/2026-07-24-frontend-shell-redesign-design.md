# 前端壳层重构：首页 + 画布工作区（方案 A）

> 2026-07-24 用户拍板。参照 LibTV 两张截图：首页=大输入框+发现页；进入后=画布即工作区。
> 后端 API 零改动；业务 screen 组件零改动，只改壳层与打开方式。

## 背景与问题

- 首页输入框是假的：`Home.tsx` 的「开始策划」只写 localStorage 后跳 tab，不创建系列、Agent 看不到灵感。
- 进入后是 12-tab sidebar 后台管理形态，「创作画布」只是其中一个 tab；参照图要求画布即工作区。
- 首页有假交互（分类筛选不筛、Skill 卡直接跳转）。

## §1 信息架构

- **Home surface**（图二形态）：品牌导航 + 居中大输入框 + Skill chips + 最近项目 + 真实镜头区。
- **Canvas surface**（图一形态）：顶栏 + 中央生产图画布 + 右侧 Agent 面板 + 底部工具条 + 左下资产入口；无 sidebar。

## §2 首页

顶栏（logo + 导入/进入工作台）→ 居中大输入框（左下：＋导入、新建空白；右下：发送）→ Skill chips（点击=填模板进输入框，不跳转）→ 最近项目卡片 → 真实镜头区（仅真项目关键帧）。
砍掉：假分类 tab、01/02/03 宣传 strip（浓缩为输入框下一行标语）。

## §3 输入 → 进入流程

1. 输入灵感 → 发送；
2. `POST /api/series`：id=`s`+时间戳 base36，title=灵感前 12 字，logline=前 50 字，genre 默认女性向漫剧；
3. 切到画布，右侧 Agent 展开、灵感预填，显示建议动作「▶ 开始编剧（EP01）」；
4. 用户点击后 `POST .../jobs {type:'script', payload:{outline}}`，「剧本」节点进运行态（SSE）。
   **不自动跑编剧**：agent 调用耗 token，须人点一下（既有付费确认纪律）。

## §4 画布工作区壳层

- 顶栏：左=logo(回首页)+系列/分集切换；中=「工作流|故事板」toggle（故事板=现有 StoryboardEditor）；右=任务(红点)/成本/导入/总览图标→浮层。
- 中央：现有 Workflow 画布；无系列时空画布+快速开始卡（写灵感/导入/跑 demo）。
- 右侧：现有制作 Agent 面板，可收起，接收首页灵感预填。
- 底部：悬浮工具条（缩放/整理/回中）。
- 左下：「资产管理」→ 资产库抽屉。

## §5 原 12 tab 去向

| 原 tab | 去向 |
|---|---|
| workflow | 工作区本体 |
| storyboard | 顶栏「故事板」toggle |
| script / keyframes / delivery | 画布节点 → 抽屉 |
| canvas(LibTV) / evaluation | 画布可选工位节点 → 抽屉 |
| assets | 左下入口 → 抽屉 |
| tasks / costs / import / overview | 顶栏图标 → 浮层 |

统一 `Drawer` 容器组件，内部原样挂现有 screen 组件（props 不变）。

## §6 技术落点与边界

- 改动：`App.tsx`（壳层）、`Home.tsx`（重排+真流程）、`Workflow.tsx`（空态卡+Agent 预填）、`styles.css`；新增 `Drawer.tsx`。api.ts/types.ts/后端不动（types 如需加 UI 层类型可加）。
- URL 兼容：`?tab=` 深链映射到对应抽屉/浮层自动打开。
- 异常：创建系列失败→输入框下红字；agent job 失败→节点失败态（现有能力）。
- 主题：默认 graphite 暗色；paper/projector 保留。

## §7 验证

`npm run typecheck` + `npm run build` + `npm test` 全绿；studio 实跑「输入→创建→画布→跑编剧」全流程，截图 open 给用户。
