import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AppConfig } from '../src/config.js';
import { runDemoWorkflow, seedDemo } from '../src/demo.js';
import { assertMediaTools, probeMedia } from '../src/media/ffmpeg.js';
import { ProjectStore } from '../src/store.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-amntv-verify-'));
const config: AppConfig = {
  projectsRoot: root,
  dryRun: true,
  noOpen: true,
  ffmpeg: process.env.FFMPEG_PATH ?? 'ffmpeg',
  ffprobe: process.env.FFPROBE_PATH ?? 'ffprobe',
  minimaxApiBase: 'https://api.minimaxi.com',
  minimaxTtsModel: 'speech-2.8-hd',
  minimaxVideoModel: 'MiniMax-Hailuo-2.3',
};

try {
  await assertMediaTools(config);
  const store = new ProjectStore(root, 'verification-series');
  seedDemo(store);
  await runDemoWorkflow(config, store);
  const state = store.state('EP01');
  assert.ok(state.gates.script);
  assert.ok(state.gates.cast);
  assert.ok(state.gates.storyboard);
  assert.ok(state.gates.visual);
  assert.ok(state.gates.final);
  assert.ok(state.delivery);
  assert.equal(
    Object.values(state.cuts).every((entry) => entry.stage === 'composited'),
    true,
  );
  const media = await probeMedia(config, state.delivery.finalVideo);
  assert.equal(media.width, 1080);
  assert.equal(media.height, 1920);
  assert.equal(media.fps, 24);
  assert.equal(media.hasAudio, true);
  assert.ok(media.durationSec >= 60 && media.durationSec <= 120);
  assert.ok(fs.existsSync(state.delivery.subtitles));
  assert.ok(fs.existsSync(state.delivery.cover));
  assert.ok(
    fs.existsSync(path.join(state.delivery.jianyingDraft, 'timeline.json')),
  );
  console.log(
    `dry-run verified: ${media.width}x${media.height}, ${media.fps}fps, ${media.durationSec.toFixed(2)}s, ${Object.keys(state.cuts).length} cuts`,
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
