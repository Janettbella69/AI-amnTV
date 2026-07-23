#!/usr/bin/env node
import fs from 'node:fs';
import { getConfig } from './config.js';
import {
  automaticAssetPicks,
  automaticKeyframePicks,
  runDemoWorkflow,
  seedDemo,
} from './demo.js';
import {
  approveCast,
  approveFinal,
  approveKeyframes,
  approveScript,
  approveStoryboard,
  audioStage,
  castingStage,
  composeStage,
  costReport,
  initializeSeries,
  keyframeStage,
  requestRetake,
  reviewPath,
  scriptStage,
  statusReport,
  storyboardStage,
  videoStage,
} from './pipeline/index.js';
import { createProviders } from './providers/index.js';
import { openReview } from './review/html.js';
import { ProjectStore } from './store.js';
import { assertMediaTools } from './media/ffmpeg.js';

const help = `AI-amnTV · 本地优先 AI 漫剧生产 CLI

创建与生成
  amntv init <series> --title <标题> --genre <类型> --logline <一句话故事>
  amntv script <series> <EP01> <outline.txt>
  amntv cast <series> <EP01>
  amntv storyboard <series> <EP01>
  amntv audio <series> <EP01>
  amntv keyframes <series> <EP01>
  amntv generate <series> <EP01>
  amntv compose <series> <EP01>

四关卡
  amntv approve script <series> <EP01>
  amntv approve cast <series> <EP01> --pick CH-01=1,LOC-01=2
  amntv approve storyboard <series> <EP01>
  amntv approve keyframes <series> <EP01> --pick EP01_S01_C001:first=1,...
  amntv approve final <series> <EP01>
  amntv review script|cast|storyboard|keyframes|final <series> <EP01>

局部调整（保留旧 take，不整集重跑）
  amntv revise keyframe <series> <EP01> <cut-id> --prompt <调整指令>
  amntv revise video <series> <EP01> <cut-id> --prompt <调整指令>

运维与验证
  amntv status <series> <EP01>
  amntv cost <series> <EP01>
  amntv recover <series> <EP01>
  amntv doctor
  amntv demo [series]
  amntv demo-run [series]          # 仅 dry-run 自动关卡，用于 CI/验收
`;

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function parsePicks(value: string | undefined): Record<string, number> {
  if (!value?.trim()) return {};
  return Object.fromEntries(
    value.split(',').map((pair) => {
      const separator = pair.lastIndexOf('=');
      if (separator < 1) throw new Error(`圈选格式错误: ${pair}`);
      const key = pair.slice(0, separator).trim();
      const pick = Number(pair.slice(separator + 1));
      if (!Number.isInteger(pick) || pick < 1) throw new Error(`圈选序号错误: ${pair}`);
      return [key, pick];
    }),
  );
}

function requireValue(value: string | undefined, label: string): string {
  if (!value) throw new Error(`缺少 ${label}\n\n${help}`);
  return value;
}

async function main(): Promise<void> {
  const config = getConfig();
  const [command, ...args] = process.argv.slice(2);
  if (!command || ['help', '--help', '-h'].includes(command)) {
    console.log(help);
    return;
  }
  if (command === 'doctor') {
    await assertMediaTools(config);
    const providers = createProviders(config);
    console.log(
      [
        `projects: ${config.projectsRoot}`,
        `dry-run: ${config.dryRun}`,
        `image: ${JSON.stringify(providers.image.status())}`,
        `video: ${JSON.stringify(providers.video.status())}`,
        `tts: ${JSON.stringify(providers.tts.status())}`,
        'ffmpeg/ffprobe: ready',
      ].join('\n'),
    );
    return;
  }
  if (command === 'init') {
    const seriesId = requireValue(args[0], 'series');
    initializeSeries(new ProjectStore(config.projectsRoot, seriesId), {
      title: requireValue(flag(args, '--title'), '--title'),
      genre: requireValue(flag(args, '--genre'), '--genre'),
      logline: requireValue(flag(args, '--logline'), '--logline'),
    });
    return;
  }
  if (command === 'demo' || command === 'demo-run') {
    if (!config.dryRun) throw new Error(`${command} 只允许在 AMNTV_DRY_RUN=1 下运行`);
    const seriesId = args[0] ?? 'demo-series';
    const store = new ProjectStore(config.projectsRoot, seriesId);
    seedDemo(store);
    if (command === 'demo-run') {
      await runDemoWorkflow(config, store);
      console.log(statusReport(store, 'EP01'));
    } else {
      console.log(
        `样例已创建。先执行 amntv approve script ${seriesId} EP01，再按四关卡推进。`,
      );
    }
    return;
  }
  if (command === 'approve') {
    const [gate, seriesId, episodeId] = args;
    const store = new ProjectStore(
      config.projectsRoot,
      requireValue(seriesId, 'series'),
    );
    const ep = requireValue(episodeId, 'episode');
    if (gate === 'script') await approveScript(config, store, ep);
    else if (gate === 'cast') {
      const picks =
        args.includes('--auto') && config.dryRun
          ? automaticAssetPicks(store)
          : parsePicks(flag(args, '--pick'));
      approveCast(store, ep, picks);
    } else if (gate === 'storyboard') approveStoryboard(store, ep);
    else if (gate === 'keyframes') {
      const picks =
        args.includes('--auto') && config.dryRun
          ? automaticKeyframePicks(store, ep)
          : parsePicks(flag(args, '--pick'));
      approveKeyframes(store, ep, picks);
    } else if (gate === 'final') approveFinal(store, ep);
    else throw new Error(`未知关卡 ${gate}\n\n${help}`);
    return;
  }
  if (command === 'review') {
    const [gate, seriesId, episodeId] = args;
    if (!['script', 'cast', 'storyboard', 'keyframes', 'final'].includes(gate ?? '')) {
      throw new Error(`未知审核页 ${gate}`);
    }
    const store = new ProjectStore(
      config.projectsRoot,
      requireValue(seriesId, 'series'),
    );
    const file = reviewPath(
      store,
      requireValue(episodeId, 'episode'),
      gate as 'script' | 'cast' | 'storyboard' | 'keyframes' | 'final',
    );
    if (!fs.existsSync(file)) throw new Error(`审核页尚未生成: ${file}`);
    openReview(config, file);
    console.log(file);
    return;
  }
  if (command === 'revise') {
    const [stage, seriesId, episodeId, cutId] = args;
    if (stage !== 'keyframe' && stage !== 'video') {
      throw new Error(`局部调整阶段必须是 keyframe 或 video\n\n${help}`);
    }
    const store = new ProjectStore(
      config.projectsRoot,
      requireValue(seriesId, 'series'),
    );
    requestRetake(
      store,
      requireValue(episodeId, 'episode'),
      requireValue(cutId, 'cut-id'),
      stage,
      requireValue(flag(args, '--prompt'), '--prompt'),
    );
    return;
  }

  const seriesId = requireValue(args[0], 'series');
  const episodeId = requireValue(args[1], 'episode');
  const store = new ProjectStore(config.projectsRoot, seriesId);
  if (command === 'script') {
    const outline = fs.readFileSync(requireValue(args[2], 'outline file'), 'utf8');
    await scriptStage(config, store, episodeId, outline);
  } else if (command === 'cast') await castingStage(config, store, episodeId);
  else if (command === 'storyboard') await storyboardStage(config, store, episodeId);
  else if (command === 'audio') await audioStage(config, store, episodeId);
  else if (command === 'keyframes') await keyframeStage(config, store, episodeId);
  else if (command === 'generate') await videoStage(config, store, episodeId);
  else if (command === 'compose') await composeStage(config, store, episodeId);
  else if (command === 'status') console.log(statusReport(store, episodeId));
  else if (command === 'cost') console.log(costReport(store, episodeId));
  else if (command === 'recover') {
    console.log(`标记 ${store.recoverOrphanedVideoTasks(episodeId)} 个孤儿视频任务`);
  } else {
    throw new Error(`未知命令 ${command}\n\n${help}`);
  }
}

main().catch((caught) => {
  const error = caught instanceof Error ? caught : new Error(String(caught));
  console.error(`[AI-amnTV] 错误: ${error.message}`);
  process.exitCode = 1;
});
