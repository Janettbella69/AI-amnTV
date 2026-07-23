# manju-studio 设计文档

> 2026-07-24。前置阅读：`docs/decisions.md`（拍板记录，本设计不得违背）；
> 证据基础：`docs/research/` 三份研究（github-repos / industrial-pipeline / competitors）。
> 每条非显然的设计决策都标注来源，格式 `[来源]`。

## 1. 定位与验收标准

自用 AI 漫剧生产工具（拍板 D1）：anime 风格竖屏短剧，端到端出片。

验收标准（按优先级）：
1. **能出片**：一集 60–120s 成片（含配音、字幕、AIGC 标识）完整走完流水线。
2. **单集成本可控**：成本台账逐笔记录；KPI = 抽卡次数/镜头 ≤ 4（行业熟手基准 [competitors §11]）。
3. **人工时间可控**：人只出现在四个关卡，其余全自动。

非目标：多用户、计费、Web 产品化 UI、平台发布自动化。

## 2. 总体架构

三层（拍板 D4.4 的推论）：

```
┌────────────────────────────────────────────────────┐
│ CLI（src/cli）：init/script/cast/storyboard/audio/  │
│ keyframes/generate/compose/review/approve/status/cost│
├────────────────────────────────────────────────────┤
│ 确定性编排层（src/orchestrator + src/state）          │
│ 状态机·关卡校验·任务轮询·重试降级·成本台账——纯 TS，无 LLM │
├──────────────────────┬─────────────────────────────┤
│ Agent 判断节点        │ 工具抽象层（src/tools）        │
│ (src/agents,          │ ImageGen/VideoGen/TTS/Compose │
│  Claude Agent SDK)    │ 供应商适配器注册表，可热替换     │
└──────────────────────┴─────────────────────────────┘
            文件系统 = 唯一事实源（projects/<series>/）
```

- **确定性的环节用普通代码，需要判断的环节才用 agent。** 任务队列、轮询、状态推进、ffmpeg 合成是代码；剧本、分镜、审查、失败诊断是 agent。
- Agent 调用方式：SDK `query()` + `outputFormat: json_schema`（强 schema 结构化输出）；烧钱工具挂 PreToolUse hook 做门禁。
- 供应商适配器注册表是 9 个开源仓的共性 [github-repos 共性14]；即梦一月三连涨、智影关停证明模型层必须可替换 [competitors §13.8]。

## 3. 数据模型（已实现于 src/state/types.ts）

核心实体与 ID 体系对齐工业惯例 [industrial-pipeline C2]：

- **不可变 ID**：场 `S03`（插入=S03A，删除标 omitted 占位）、卡 `EP01_S03_C012`（插卡=C012A）、take `..._T03`。下游全部外键引用，改剧本不引发引用漂移。
- **双层资产**（拍板 D3）：系列级 CharacterAsset（三视图/表情/服装/**色板**/**音色**）、LocationAsset、PropAsset、StyleGuide；单集级 Script/Storyboard/Take。角色引用只用 ID，禁止镜头里裸描述人物。
- **カット袋**：每卡一个自包含目录（keyframes/candidates、keyframes/selected、clips、audio、tickets），任何阶段可独立审计重跑 [industrial-pipeline B1；github-repos 共性11 的文件系统版]。
- **Take 溯源**：`gen_meta{provider,model,seed,prompt,ref_images,cost}` 全记录 = camera report，保证可复现 [industrial-pipeline C2.5；LumenX RenderLog 同构]。
- **RetakeTicket**：`stage_to_redo: keyframe|video|composite` 指明从哪个工序重跑，而非整卡重来 [industrial-pipeline C2.6]。

## 4. 流水线与关卡

四关卡（拍板 D3），门的密度与成本梯度成反比 [industrial-pipeline C4.3；OnlyShot 实测分镜图:视频=3:55 积分]：

```
大纲/自有小说
  → script-agent 生成剧本 → femdrama-reviewer 审查（≤2轮自动修订）
  → 关卡① 剧本确认（文本 diff 审，成本≈0）→ script.status=locked
  → breakdown-tagger 生成逐场资产清单（scene_manifest）
  → [新角色] casting：本地出图 N 候选定妆卡
  → 关卡⓪ 定妆锁定（N选1 + 音色试听）→ asset.status=locked   [系列级，一次]
  → storyboard-agent 生成镜头表（絵コンテ字段集）
  → 关卡② 之一：分镜表批准（杠杆最大的一道门 [industrial C1]）
  → 音频先行（プレスコ [industrial C4.2；TypeTale 模式②]）：
      TTS 逐句定稿 → cut.duration 以音频时长回填
  → 关键帧候选：本地生成，每卡按重要度出 1–4 张 [OnlyShot candidates_count]
  → 关卡② 之二：关键帧圈选（HTML 宫格 N选1）= hard greenlight
  → 视频生成（全自动，coverage + 降级链，见 §7）
  → sakkan-checker 一致性检查 → 不过 → RetakeTicket 循环
  → 装配粗合成 → 关卡③ 成片确认 → picture lock
  → 交付：字幕/AIGC标识/响度 → 自动 QC → 导出 MP4 + 剪映草稿
```

**关卡的实现 = readiness gate**，学 Jellyfish 双层设计 [github-repos §2]：
- 「准备完成」与「生成中」解耦：审批状态落盘（state.yaml），执行状态由任务系统单独表达。
- 每个烧钱动作前做**实时聚合的多项 check**（不落库），逐项返回 `{key, ok, message}`：剧本已锁、资产已锁、时长已回填、prompt 非空、参考帧齐全（按生成模式查必需帧集合）、供应商 key 存在、无进行中任务。全过才放行。
- hook 层兜底：PreToolUse 拦截 `gen_video`，未过 `keyframes_approved` 门直接拒绝——一致性和成本纪律靠门禁，不靠自觉。

**审核门交互 = 「N 选 1 + 局部改」两级** [competitors §12]：
- 每个门生成一页本地 HTML（contact sheet：候选宫格 + 元数据 + 单选），自动 `open` 给用户看；
- CLI `manju approve <gate>` 记录圈选结果（circled take [industrial A4]）；
- 选中后才允许进入「局部改」（改 prompt 重抽该卡/inpaint），不允许未选先改。

## 5. Agent 节点清单

全部经 SDK `query()` 调用、structured output、每个节点一个专职定义（src/agents）：

| 节点 | 输入→输出 | 关键设计 |
|---|---|---|
| `script-agent` | 大纲/章节 → EpisodeScript | 台词≤15字/句、4字/秒计时 [Toonflow 铁律]；情绪节拍标注；女频节奏七招钉进结构（对抗开场/30s爆破/60s爽点/90s反转/120s爽点/150s钩子/结尾钩子）[OnlyShot 节奏地图] |
| `femdrama-reviewer` | EpisodeScript → 审查报告 | 女频判断层（全行业空白 [competitors §11]）：情绪承诺/兑现校验、女主能动性、人设讨喜度、套路黑名单 grep 式逐项检查 [OnlyShot cliche-detector]；只提问题+改法，改不改人拍板 [Toonflow 监督层「只提不改」] |
| `breakdown-tagger` | 剧本 → SceneManifest[] | 多轮 pass 防漏标 [industrial A2]；输出即 Cast-ID 引用 |
| `storyboard-agent` | 剧本+资产 → Storyboard | 絵コンテ字段集 [industrial B2]；台词零删改>人物完整>只描述动作 [Toonflow]；人物外观不进分镜 prompt（交给资产引用）；连续性注入：上/下镜摘要、构图锚点、视线方向 [Jellyfish] |
| `sakkan-checker` | 生成帧/片段 vs 角色资产 → 判定 | 双层作监 [industrial C3]：逐卡身份比对（重点查脸）+ 跨集抽样；输出 identityScore + RetakeTicket 草案 |
| `failure-doctor` | 失败上下文 → 降级决策 | 见 §7 降级链;含审核拦截改写 [PrintFilm rewritePromptForModeration] |

## 6. Harness 机制（Agent SDK 用法）

- **structured output**：所有 agent 节点用 `outputFormat: {type:'json_schema', schema}`，schema 由 zod 定义单一来源，编排层直接消费类型化产物。
- **门禁 hook**：编排层调用生成 agent 时挂 `hooks.PreToolUse`，对 `mcp__manju__gen_video` 等烧钱工具校验 readiness gate，未过返回 deny。工具 handler 内部再校验一次（纵深防御）。
- **进程内 MCP 工具**：`createSdkMcpServer` 暴露 `gen_keyframe / gen_video / tts_line / asset_read`，供 agent 在判断过程中调用（如 failure-doctor 重试时直接触发降级生成）。
- **成本记账**：每个工具 handler 完成时向 costLedger 追加一笔（工具名/卡号/金额）。
- **会话**：每个 pipeline stage 独立短会话（无长会话状态依赖），断点靠 state.yaml 而非 SDK session——重启后可从任意关卡继续。

## 7. 生成策略

**模式选择**（per-cut 显式字段 + 自动规则 [github-repos 共性3]）：
- storyboard-agent 按镜头类型预填 `genMode`：对话→`first_frame`；关键反转→`first_last`；复杂动作→`multi_frame`；经验配比 i2v 80% / 首尾帧 10% / 多帧 5% [OnlyShot]。
- 执行时按「文件存在」校验降级：缺尾帧则降为 first_frame 并告警 [OnlyShot detect_mode 思路反用]。

**Coverage**：关键卡（爆点/反转/情绪高点，由 storyboard-agent 标注）默认生成 2 条 take（变 seed），普通卡 1 条；master 兜底条=构图保守全员入画 [industrial A7/C4.1]。

**尾帧衔接**：同场景连续镜头可选 `tail_link`：抽上镜末帧作下镜首帧 [LocalMiniDrama/TypeTale]。

**降级链**（failure-doctor 决策，编排层执行）：
1. 网络/限流类（429/5xx/timeout）→ 指数退避重试 ≤3 [PrintFilm retryOperation]
2. 内容审核拦截 → 敏感词预清洗表（生成前）+ LLM 温和化改写重投（拦截后）[OnlyShot 替换表 + PrintFilm rewrite]
3. 质量失败（sakkan 不过）→ 换 seed 重抽 ≤2 → 降复杂度（简化动作/降为 still_pan 静帧+运镜）→ 拆镜头 [PrintFilm splitShotIntoSubShots] → 标 failed 进人工队列
4. **孤儿任务哲学**：视频生成任务重启后标 failed 不自动续跑（防供应商重复扣费 [LumenX]）；轮询类任务续 poll+去重（无副作用 [LocalMiniDrama]）

**失效检测**：台词/音色变更 → `md5(台词|voiceId|参数)` hash 不一致标 STALE [LumenX]；角色主图变更 → 依赖该资产的下游产物标 stale [LocalMiniDrama]。

**Prompt 拼装**（模板在代码库、卡级只存增量）：
- 关键帧：8 段结构 CHARACTER/BACKGROUND/ACTION/SCENE/CAMERA/LIGHT/TEXT/STYLE [OnlyShot]；风格前缀来自 StyleGuide；角色引用用「图N」token 映射表注入参考图 [Jellyfish]，参考图顺序约定：场景第一、角色其后 [PrintFilm]；ref 总数 ≤8 [OnlyShot]。
- prompt 长度硬上限校验（供应商各异，配置于适配器）[OnlyShot InvalidNode 教训]。

## 8. 配音与时长对齐（プレスコ制）

**音频为主，画面迁就音**——与日本动画主流相反，理由：AI 视频时长是可控参数 [industrial C4.2]；TypeTale 已验证该模式可行 [github-repos §8]。

1. 剧本锁定后即 TTS 逐句定稿（角色音色=锁定资产；`说话人：台词` 显式 speaker 字段，非正则猜测）；
2. `cut.durationSec = sum(该卡台词音频) + 动作余量`，回填镜头表 → 分镜批准时人看到的就是最终时长；
3. i2v 按供应商时长档（5s/10s）生成，尾部静帧延长补齐（漫剧惯例）；
4. 合成时残余误差用 atempo 链（钳位 [0.5,2]）+ apad 双重校准 [LocalMiniDrama]；
5. 口型：MVP 不做精确口型（漫剧惯例轻口型）；情感重头戏可选对口型后置工序（即梦），标注在 cut 上。
6. 非对白行拦截：环境音/音效/旁白标记走各自轨道，不进角色 TTS [Huobao IGNORE_TTS]。

## 9. 合成与交付

- 单卡合成：clip + 该卡音频 + 字幕；集级 concat + BGM 轨（本地曲库目录，MVP 不做 AI 音乐）+ 响度归一。
- **双出口**：① MP4 成片（烧字幕+AIGC 标识）；② **剪映草稿导出**（行业事实标准 [competitors §12]，TypeTale/巨日禄已验证；实现参考开源 draft 格式库）——精修不自研剪辑器。
- 自动 QC（关卡③ 的机器部分）：分辨率 1080×1920、时长∈[60,120]s、每句台词有对应音频、字幕文件存在、封面帧存在、AIGC 标识存在 [industrial C1 Netflix QC 映射]。PSE 闪烁检测记为 v2（anime 高频闪风险 [industrial A6]）。

## 10. 成本管理

- costLedger 逐笔记账（工具/卡/金额），`manju cost` 出单集报表：总额、每分钟成本、抽卡数/镜头。
- KPI：抽卡 ≤4/镜头 [competitors §11]；行业参照：AI 漫剧 800–1000 元/分钟，精品流单集 500–2000 元。
- 模型分档：候选帧=本地（零成本无限抽）；终稿帧可选云端精修；视频=云端。低重要度镜头用便宜档 [Seko/剪映分档思路]。

## 11. 里程碑

- **M0 骨架**（本次交付）：类型+状态机+资产库+CLI+关卡与门禁+stub 供应商 dry-run 全流程。
- **M1 剧本线**：script/femdrama/breakdown/storyboard agents 实调 + 关卡①⓪② 审核页。
- **M2 生成线**：本地出图（ComfyUI/MPS）+ 云端视频适配器 + 供应商小评测（锁定 Vidu/可灵/即梦之一）+ 降级链实测。
- **M3 交付线**：MiniMax TTS + ffmpeg 合成 + 剪映草稿导出 + QC + 第一部片端到端验收。

## 12. 风险与未验证项（诚实清单）

- 云端视频适配器、MiniMax TTS、剪映草稿格式：**代码已写但未实测**（需 API key / 实际验证），在 README 标注。
- 供应商动漫向质量差异大：M2 评测前不锁定，评测表结构已备、数据留空（不填演示数字）。
- 本地出图质量上限（anime SDXL vs 云端 Seedream 5）：M2 实测对比。
- 即梦生态（番茄 IP 90% 分成 [competitors §1]）值得关注但与自用工具不冲突。
