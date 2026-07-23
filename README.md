# AI-amnTV

本地优先的 AI 竖屏漫剧生产工具。它把剧本、定妆、分镜、配音、关键帧、图生视频、作监检查、
合成和交付串成一条可恢复、可审核、可核算成本的生产线，同时提供 Web Studio 和 CLI。

项目按 `docs/specs/2026-07-24-manju-studio-design.md` 的产品约束独立实现，没有复用
`manju-studio` 的代码或提交历史。

## 已实现

- React Web Studio：总览、结构化剧本/分镜编辑、资产库、圈图、任务、成本和交付
- Fastify 本地 API、SQLite 持久任务队列与 SSE 实时进度；重启不重复提交付费任务
- 60–120 秒、1080×1920、15–25 卡的硬校验
- 四个人工关卡：剧本 → 定妆 → 分镜与关键帧 → 成片
- 系列级角色、音色、场景资产锁定；锁定后的场号、台词 ID、卡号不可重排
- 音频先行，实际 TTS 时长回填分镜
- 结构化提示词、最多 8 张参考图、首帧/首尾帧语义
- 关键卡 4 张候选图和 2 个视频 take；平均抽卡预算不超过 4 次/卡
- 付费视频前 readiness gate、瞬时错误重试、失败后本地 still-pan 降级
- 视频任务账本和孤儿任务恢复，避免进程重启后重复扣费
- 选中后单卡局部重做，旧 take 不覆盖
- 中文字幕与固定 AIGC 标识烧录，不依赖 FFmpeg 的 `subtitles`/`drawtext` 插件
- 最终 MP4、SRT、封面、QC 报告、稳定时间线和实验性剪映草稿
- ComfyUI 出图、MiniMax TTS/视频适配器，以及零云成本 dry-run 适配器

## Web Studio

构建并启动本地工作台：

```bash
npm ci
npm run build
AMNTV_DRY_RUN=1 npm run dev -- studio
```

浏览器会打开 `http://127.0.0.1:4317`。Studio 只监听本机回环地址；项目 YAML 与媒体文件仍是
事实源，SQLite 只保存可恢复的后台任务。开发界面时可运行：

```bash
AMNTV_DRY_RUN=1 npm run studio:dev
```

工作台包含：

- 制作总览与人工关卡状态
- 剧本、分镜结构化编辑与 Claude Agent SDK 任务入口
- 角色、场景、音色和候选资产管理
- 关键帧候选圈选、逐卡视频进度和局部重做
- 已知/未知成本账本、最终视频预览与交付下载
- graphite、paper、projector 三套视觉环境和两档信息密度

已批准内容被修改时，系统会撤销相关下游关卡：剧本只重置被改场景的镜头，分镜只重置被改卡，
未受影响的 take 和状态保留。

## 快速验收

要求 Node.js 22.12+、FFmpeg 和 FFprobe。

```bash
npm ci
AMNTV_DRY_RUN=1 AMNTV_NO_OPEN=1 npm run dev -- demo-run my-demo
```

交付物位于：

```text
projects/my-demo/episodes/EP01/final/
├── EP01.mp4
├── EP01.srt
├── cover.jpg
├── qc-report.yaml
└── jianying-draft/
```

dry-run 会生成真实可播放的 60 秒视频、提示音轨和占位画面，用来验收状态机、关卡与媒体链路；
它不代表云模型的最终画面质量。

运行全部检查：

```bash
npm run check
```

## 真实生产流程

先复制配置并填写密钥与本地服务路径：

```bash
cp .env.example .env
npm run dev -- doctor
```

然后按关卡推进：

```bash
npm run dev -- init my-series --title "她先撕掉婚约" --genre "女性向复仇" --logline "退婚宴上，她用假账夺回主动权"
npm run dev -- script my-series EP01 outline.txt
npm run dev -- review script my-series EP01
npm run dev -- approve script my-series EP01

npm run dev -- cast my-series EP01
npm run dev -- review cast my-series EP01
npm run dev -- approve cast my-series EP01 --pick CH-01=2,CH-02=1,LOC-01=3

npm run dev -- storyboard my-series EP01
npm run dev -- approve storyboard my-series EP01
npm run dev -- audio my-series EP01
npm run dev -- keyframes my-series EP01
npm run dev -- review keyframes my-series EP01
npm run dev -- approve keyframes my-series EP01 --pick <审核页生成的完整圈选列表>

npm run dev -- generate my-series EP01
npm run dev -- compose my-series EP01
npm run dev -- review final my-series EP01
npm run dev -- approve final my-series EP01
```

审核页会为每一组生成单选卡片，并拼好可复制的批准命令。必须通过 CLI 落盘，关卡才算真正放行。

### 单卡局部重做

不满意某一张图或某一段动作时，不必重跑整集：

```bash
npm run dev -- revise keyframe my-series EP01 EP01_S01_C001 --prompt "女主视线更坚定，账本抬高到胸前"
npm run dev -- keyframes my-series EP01

npm run dev -- revise video my-series EP01 EP01_S01_C001 --prompt "动作减慢，镜头保持稳定"
npm run dev -- generate my-series EP01
```

每次局部重做都会增加 round、保留旧候选与 take、写入 retake ticket，并只使相关下游产物失效。

## 架构

```mermaid
flowchart LR
  A["大纲"] --> B["编剧 Agent"]
  B --> G1{"① 剧本"}
  G1 --> C["Breakdown"]
  C --> G0{"⓪ 定妆"}
  G0 --> D["分镜 Agent"]
  D --> G2A{"② 分镜"}
  G2A --> E["TTS / 时长回填"]
  E --> F["关键帧候选"]
  F --> G2B{"② 圈图"}
  G2B --> H["Readiness Gate"]
  H --> I["视频 Coverage + 作监"]
  I --> J["合成 / 字幕 / AIGC / QC"]
  J --> G3{"③ 成片"}
```

确定性编排、校验、状态迁移和文件写入全部由 TypeScript 完成；Agent 只负责创作、审稿、分镜、
breakdown 和视觉判断。文件系统是唯一事实源，SQLite 只承担 Studio 任务调度，方便人工检查、
版本控制与故障恢复。

详细说明见 [架构文档](docs/architecture.md)、[供应商接入](docs/provider-guide.md)和
[竞品参考边界](docs/competitive-notes.md)。

## 重要边界

- 请只改编自有版权或公版内容。
- 云供应商调用可能产生费用；dry-run 不调用云服务。
- MiniMax 视频需要可公开读取的 HTTPS 参考帧 URL 映射。
- `jianying-draft/draft_content.json` 是实验性结构；`timeline.json` 才是稳定、无损的重建依据。
- 本仓库不包含任何 API 密钥、模型文件或生成项目。

## License

MIT
