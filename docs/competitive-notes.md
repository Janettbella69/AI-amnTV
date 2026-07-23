# 竞品参考边界

核对日期：2026-07-24。

本项目没有复制即梦或可灵的 UI、提示词或私有实现，只吸收了可验证、适合本地制片工具的产品模式。

| 参考 | 可验证能力/方向 | AI-amnTV 的落法 |
|---|---|---|
| 即梦 | 文生/图生视频、首尾帧控制、偏中文的创作入口 | `first_frame` / `first_last` 模式；中文八段式 prompt；视频付费前检查参考帧 |
| 即梦智能画布 | 生成后继续扩图、局部编辑、消除等迭代方式 | `revise keyframe/video` 单卡局部重做；旧 round/take 永不覆盖 |
| 可灵 | 作为用户指定的对照产品与未来云视频候选 | 通过 `VideoProvider` 保持可替换；未在缺少可核验官方接口资料时伪造适配器 |

资料：

- [即梦官网](https://www.jimeng.com/)
- [即梦（剪映域名入口）](https://jimeng.jianying.com/)
- [火山引擎：即梦图生视频首尾帧 API](https://www.volcengine.com/docs/85621/1791184?lang=zh)
- [火山引擎：即梦图生视频 API](https://www.volcengine.com/docs/85621/1802721?lang=zh)

由于可灵官方开发者页面在本次环境中无法可靠读取，本仓库只保留标准 provider 扩展点，不写未经
核实的模型名、价格、参数或接口路径。
