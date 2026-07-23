# 架构与数据约束

## 原则

1. 文件系统是唯一事实源；HTML 审核页和报告都是可重建视图。
2. TypeScript 状态机负责顺序、幂等、校验和付费门禁；Agent 不直接改状态。
3. 角色、场景、服装和音色先锁定，镜头只引用资产 ID。
4. 剧本锁定后，既有场号与台词 ID 只能保留；删场用 `omitted`，插入用字母后缀。
5. 分镜批准后，既有卡号不可删除或重排。
6. 云视频先记任务再提交；进程中断后标记 `orphaned`，不自动重提。

## 目录

```text
projects/<series>/
├── series.yaml
├── assets/
│   ├── characters/<CH-ID>/
│   │   ├── profile.yaml
│   │   ├── turnaround/main.png
│   │   └── candidates/
│   └── locations/<LOC-ID>/
├── episodes/<EP-ID>/
│   ├── script.yaml
│   ├── storyboard.yaml
│   ├── state.yaml
│   ├── review/
│   ├── cuts/<CUT-ID>/
│   │   ├── audio/
│   │   ├── keyframes/candidates/<role>/round-<NN>/
│   │   ├── keyframes/selected/
│   │   ├── clips/
│   │   ├── tickets/
│   │   └── meta/
│   └── final/
```

生成元数据保存 provider、model、seed、prompt hash、参考图、输出路径和已知成本。候选 take 带
round，不会因局部重做被覆盖。

## 卡状态

```text
pending
  → audio_ready
  → keyframes_ready
  → keyframe_selected
  → video_generating
  → video_ready
  → sakkan_pass
  → composited
```

失败进入 `failed`。局部关键帧重做回到 `audio_ready`；只重做视频回到
`keyframe_selected`。这两种操作都会清除旧成片批准和交付记录。

## 视频付费门禁

每卡提交视频前同时验证：

- 剧本已锁定
- 本集引用资产已锁定
- 分镜已批准
- 关键帧已圈选
- 音频时长已回填
- prompt 非空且不超过供应商上限
- 参考帧数量符合模式
- provider 已就绪并支持模式
- 没有同卡进行中的视频任务

## 降级与成本

瞬时错误（429、5xx、超时、连接重置）最多重试 3 次。云视频最终失败时保留错误任务记录并生成
retake ticket，然后用本地 still-pan 生成可剪辑兜底片段。成本报告不会猜测供应商价格：接口未返回
费用时明确记为未知。

## 交付 QC

自动检查分辨率、时长、帧率、音轨、逐句音频、字幕、封面、AIGC 标识、镜头数、所有卡合成状态
和剪映时间线。只有自动 QC 通过后，关卡③才允许人工批准。
