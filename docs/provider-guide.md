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
