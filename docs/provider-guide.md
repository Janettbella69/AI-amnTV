# 供应商接入

所有生成服务都实现 `src/providers/types.ts` 中的小接口。新增供应商不应修改状态机，只需实现
provider 并在 `createProviders` 中选择。

## ComfyUI 出图

配置：

```dotenv
COMFYUI_URL=http://127.0.0.1:8188
COMFYUI_WORKFLOW=./workflows/anime-api.json
COMFYUI_INPUT_DIR=/absolute/path/to/ComfyUI/input
```

请从 ComfyUI 导出 **API format** 工作流，并在 JSON 中使用这些占位符：

- `${PROMPT}`
- `${NEGATIVE_PROMPT}`
- `${SEED}`
- `${WIDTH}` / `${HEIGHT}`
- `${REFERENCE_IMAGE_1}` … `${REFERENCE_IMAGE_8}`
- `${REFERENCE_IMAGES}`：当整个字段正好是该占位符时，会替换成字符串数组

关键帧生成一旦带参考图，适配器会把它们复制到 `COMFYUI_INPUT_DIR/ai-amntv/`。工作流若没有消费
参考图占位符，任务会在调用前失败，避免“看似传了角色图，实际模型没用”的静默错误。

## MiniMax TTS

```dotenv
MINIMAX_API_KEY=...
MINIMAX_API_BASE=https://api.minimaxi.com
MINIMAX_TTS_MODEL=speech-2.8-hd
```

角色 `profile.yaml` 中的 `voice.voiceId` 必须换成账号可用的音色 ID。音频内容 hash 包含文本、
音色、情绪和参数；任一变化都会使旧音频失效并重新计算时长。

## MiniMax 视频

```dotenv
MINIMAX_API_KEY=...
MINIMAX_VIDEO_MODEL=MiniMax-Hailuo-2.3
AMNTV_FRAME_URL_MANIFEST=./frame-urls.json
```

云接口需要 HTTPS 参考帧。manifest 支持用绝对路径、本地原路径或文件名作为 key：

```json
{
  "/absolute/path/to/first.png": "https://cdn.example.com/first.png",
  "last.png": "https://cdn.example.com/last.png"
}
```

当前适配器支持首帧和首尾帧；`multi_frame` 会明确降级为首尾帧并写入生成元数据，
`still_pan` 走本地 FFmpeg。任务采用提交、轮询、取文件三段式，轮询上限 30 分钟。

## 接入即梦或可灵

实现 `VideoProvider` 的 `status`、`supports` 和 `generate` 即可。`generate` 必须在供应商返回任务
ID 后立即调用 `onSubmitted`，这样进程崩溃时才能识别孤儿任务并避免重复扣费。不要把供应商轮询
逻辑放进 Agent。

## LibTV 外部创作台

LibTV 不是 `ImageProvider` 或 `VideoProvider` 的替代实现，而是 Studio 中一个可选的外部创作会话。
AI-amnTV 仍是剧本、分镜、资产、审核关卡和交付的事实源。

```dotenv
AMNTV_DRY_RUN=0
LIBTV_ACCESS_KEY=...
```

“画布”页的实时流程是：

1. 用户写本次指令并显式选择最多 8 个项目内素材。
2. Studio 先写本地 `submitting` 记录，再逐一上传素材。
3. 返回 `projectUuid` 和 `sessionId` 后立即落盘，状态变为 `running`。
4. 用户手动查询增量消息；发现结果地址后，状态变为 `ready`。
5. 用户手动回收，文件以不覆盖方式写入当前会话的 `results/`。
6. 用户可在原 session 中继续发送追问；每个 turn 先落盘且永不自动补发。
7. 回收图片可显式加入某个 cut 的首帧/尾帧候选；已有下游结果时默认拒绝，只有明确允许才新开
   retake round 并撤销该卡下游状态。

安全边界：

- API 地址固定为 `https://im.liblib.tv`，不能用环境变量改到任意主机。
- 访问密钥只通过 Bearer header 发送，不写入 YAML、日志或前端响应。
- 上传前验证真实文件签名和 200MB 上限，仅允许 PNG、JPEG、WebP、MP4、WebM。
- 只允许当前系列目录内的本地参考素材，拒绝路径穿越和跨项目读取。
- 只从精确主机 `https://libtv-res.liblib.art` 回收结果，拒绝凭证、端口和相似域名。
- 下载上限 500MB，且只接受图片或视频 MIME；已有文件不会覆盖。
- `submitting` 中断不会自动重提，避免无法确认远端状态时重复扣费。

由于实时调用需要账户密钥且可能产生费用，自动测试只覆盖 mock 请求和 dry-run 完整链路。正式启用
前请用隔离项目和最小素材做一次人工端到端验收。

回收结果不会自动获得“质量通过”结论。Studio 的“评测”页可以把 LibTV 结果与本地关键帧、视频
take 或成片放入同一人工量表；报告会保留技术参数和已知费用，但 dry-run 占位图只用于验证工作流，
不能用于评价真实供应商质量。详见 [评测系统](evaluation-system.md)。
