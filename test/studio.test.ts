import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';
import type { AppConfig } from '../src/config.js';
import { seedDemo } from '../src/demo.js';
import { ProjectStore } from '../src/store.js';
import { StudioDatabase } from '../src/studio/db.js';
import { buildStudioServer } from '../src/studio/server.js';

function config(root: string): AppConfig {
  return {
    projectsRoot: root,
    dryRun: true,
    noOpen: true,
    ffmpeg: 'ffmpeg',
    ffprobe: 'ffprobe',
    minimaxApiBase: 'https://api.minimaxi.com',
    minimaxTtsModel: 'speech-2.8-hd',
    minimaxVideoModel: 'MiniMax-Hailuo-2.3',
    libtvApiBase: 'https://im.liblib.tv',
    studioHost: '127.0.0.1',
    studioPort: 4317,
    studioDatabase: path.join(root, '.studio', 'studio.db'),
  };
}

test('SQLite queue survives restart without replaying an interrupted job', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-amntv-db-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'studio.db');
  const first = new StudioDatabase(file);
  const queued = first.enqueue({
    seriesId: 'demo',
    episodeId: 'EP01',
    type: 'video',
  });
  assert.equal(queued.status, 'queued');
  assert.equal(first.claimNext()?.status, 'running');
  first.close();

  const reopened = new StudioDatabase(file);
  const recovered = reopened.get(queued.id);
  assert.equal(recovered?.status, 'failed');
  assert.match(recovered?.error ?? '', /进程重启/);
  reopened.close();
});

test('Studio API exposes demo series and aggregated workspace', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-amntv-api-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = await buildStudioServer(config(root));
  context.after(() => app.close());

  const created = await app.inject({
    method: 'POST',
    url: '/api/demo',
    payload: { seriesId: 'web-demo' },
  });
  assert.equal(created.statusCode, 201);

  const series = await app.inject({ method: 'GET', url: '/api/series' });
  assert.equal(series.statusCode, 200);
  assert.equal(series.json().series[0].id, 'web-demo');

  const workspace = await app.inject({
    method: 'GET',
    url: '/api/series/web-demo/episodes/EP01/workspace',
  });
  assert.equal(workspace.statusCode, 200);
  const value = workspace.json();
  assert.equal(value.storyboard.cuts.length, 15);
  assert.equal(value.script.scenes.length, 5);
  assert.equal(value.costs.knownTotalCny, 0);

  const workflow = await app.inject({
    method: 'GET',
    url: '/api/series/web-demo/episodes/EP01/workflow',
  });
  assert.equal(workflow.statusCode, 200);
  assert.equal(workflow.json().stages.length, 10);
  assert.equal(workflow.json().stages[0].id, 'script');
  assert.equal(workflow.json().stages[0].status, 'active');
  assert.equal(
    workflow.json().stages.find((stage: { id: string }) => stage.id === 'cast')
      .status,
    'blocked',
  );

  const hiddenDatabase = await app.inject({
    method: 'GET',
    url: '/media/.studio/studio.db',
  });
  assert.notEqual(hiddenDatabase.statusCode, 200);
});

test('Studio keeps LibTV dry-run sessions and results inside the project', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-amntv-libtv-api-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = await buildStudioServer(config(root));
  context.after(() => app.close());
  await app.inject({
    method: 'POST',
    url: '/api/demo',
    payload: { seriesId: 'libtv-demo' },
  });

  const created = await app.inject({
    method: 'POST',
    url: '/api/series/libtv-demo/episodes/EP01/libtv/sessions',
    payload: {
      instruction: '生成一个保持角色一致的竖屏情绪镜头',
      referenceFiles: [],
    },
  });
  assert.equal(created.statusCode, 201);
  const session = created.json();
  assert.equal(session.status, 'ready');
  assert.equal(session.projectUrl, undefined);
  assert.equal(session.results.length, 1);
  assert.equal(session.turns.length, 1);
  assert.match(session.results[0].url, /^\/media\//);
  assert.equal(
    session.messages.some((message: { content: string }) =>
      message.content.includes('未向外部服务发送'),
    ),
    true,
  );
  assert.equal(fs.existsSync(session.results[0].file), true);

  const continued = await app.inject({
    method: 'POST',
    url: `/api/series/libtv-demo/episodes/EP01/libtv/sessions/${session.id}/continue`,
    payload: {
      instruction: '保持构图，只把女主眼神调整得更坚定',
      referenceFiles: [],
    },
  });
  assert.equal(continued.statusCode, 200);
  assert.equal(continued.json().turns.length, 2);
  assert.equal(continued.json().results.length, 2);
  assert.equal(continued.json().turns[1].status, 'sent');

  const store = new ProjectStore(root, 'libtv-demo');
  const cutId = store.storyboard('EP01').cuts[0]!.id;
  store.transition('EP01', cutId, 'audio_ready');
  const promoted = await app.inject({
    method: 'POST',
    url: `/api/series/libtv-demo/episodes/EP01/libtv/sessions/${session.id}/promote`,
    payload: {
      resultIndex: 0,
      cutId,
      role: 'first',
      replaceExisting: false,
    },
  });
  assert.equal(promoted.statusCode, 200);
  assert.equal(promoted.json().candidateIndex, 1);
  assert.equal(fs.existsSync(promoted.json().file), true);
  assert.equal(store.state('EP01').cuts[cutId]!.stage, 'keyframes_ready');

  const candidates = await app.inject({
    method: 'GET',
    url: '/api/series/libtv-demo/episodes/EP01/benchmarks/candidates',
  });
  assert.equal(candidates.statusCode, 200);
  assert.equal(candidates.json().candidates.length >= 2, true);
  const benchmarkCandidates = candidates.json().candidates.slice(0, 2);
  const benchmark = await app.inject({
    method: 'POST',
    url: '/api/series/libtv-demo/episodes/EP01/benchmarks',
    payload: {
      title: 'LibTV dry-run 产物对比',
      ratings: benchmarkCandidates.map(
        (candidate: { id: string }, index: number) => ({
          candidateId: candidate.id,
          criteria: {
            identity: 80 + index,
            composition: 78 + index,
            cameraLanguage: 76 + index,
            artifacts: 82 + index,
          },
          note: `候选 ${index + 1} 的人工证据`,
        }),
      ),
    },
  });
  assert.equal(benchmark.statusCode, 201);
  assert.equal(benchmark.json().items.length, 2);
  assert.equal(benchmark.json().items[0].rank, 1);
  assert.equal(benchmark.json().items[0].technical.width, 720);
  assert.equal(benchmark.json().items[0].technical.height, 1280);

  const listed = await app.inject({
    method: 'GET',
    url: '/api/series/libtv-demo/episodes/EP01/libtv/sessions',
  });
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.json().status.mode, 'dry-run');
  assert.equal(listed.json().sessions[0].id, session.id);
  assert.equal(listed.json().sessions[0].projectUrl, undefined);
});

test('Studio persists evidence-based evaluations and marks stale reports', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-amntv-evaluation-api-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = await buildStudioServer(config(root));
  context.after(() => app.close());
  await app.inject({
    method: 'POST',
    url: '/api/demo',
    payload: { seriesId: 'evaluation-demo' },
  });

  const created = await app.inject({
    method: 'POST',
    url: '/api/series/evaluation-demo/episodes/EP01/evaluations',
    payload: {
      scope: 'story',
      manualRatings: [
        {
          dimension: 'narrative',
          score: 86,
          note: '开场冲突成立，但第二场还可减少解释性台词。',
        },
      ],
    },
  });
  assert.equal(created.statusCode, 201);
  const report = created.json();
  assert.equal(report.scope, 'story');
  assert.equal(report.dimensions.length, 4);
  assert.equal(report.humanCoverage, 30);
  assert.equal(report.stale, false);
  assert.equal(
    report.dimensions.find(
      (dimension: { id: string }) => dimension.id === 'narrative',
    ).source,
    'hybrid',
  );

  const store = new ProjectStore(root, 'evaluation-demo');
  const script = store.script('EP01');
  script.title = '修改后的标题';
  store.saveScript(script);
  const listed = await app.inject({
    method: 'GET',
    url: '/api/series/evaluation-demo/episodes/EP01/evaluations',
  });
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.json().evaluations[0].id, report.id);
  assert.equal(listed.json().evaluations[0].stale, true);
});

test('Studio API validates script writes through the domain schema', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-amntv-api-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = await buildStudioServer(config(root));
  context.after(() => app.close());
  await app.inject({
    method: 'POST',
    url: '/api/demo',
    payload: { seriesId: 'write-demo' },
  });

  const response = await app.inject({
    method: 'PUT',
    url: '/api/series/write-demo/episodes/EP01/script',
    payload: { episodeId: 'EP01', title: '' },
  });
  assert.equal(response.statusCode, 400);
});

test('Studio imports a structured script after preflight', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-amntv-import-api-'));
  const sourceRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ai-amntv-import-source-'),
  );
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  context.after(() => fs.rmSync(sourceRoot, { recursive: true, force: true }));
  const source = new ProjectStore(sourceRoot, 'source-series');
  seedDemo(source);
  const content = YAML.stringify({
    series: source.series(),
    script: source.script('EP01'),
    storyboard: source.storyboard('EP01'),
  });
  const app = await buildStudioServer(config(root));
  context.after(() => app.close());
  const payload = {
    kind: 'script',
    filename: 'episode.yaml',
    content,
    metadata: {
      seriesId: 'imported-series',
      title: '',
      genre: '',
      logline: '',
      episodeId: '',
    },
  };

  const preview = await app.inject({
    method: 'POST',
    url: '/api/imports/preview',
    payload,
  });
  assert.equal(preview.statusCode, 200);
  assert.equal(preview.json().ready, true);
  assert.equal(preview.json().summary.scenes, 5);
  assert.equal(preview.json().summary.cuts, 15);

  const imported = await app.inject({
    method: 'POST',
    url: '/api/imports',
    payload,
  });
  assert.equal(imported.statusCode, 201);
  assert.equal(imported.json().seriesId, 'imported-series');

  const workspace = await app.inject({
    method: 'GET',
    url: '/api/series/imported-series/episodes/EP01/workspace',
  });
  assert.equal(workspace.statusCode, 200);
  assert.equal(workspace.json().assets.characters.length, 2);
  assert.equal(workspace.json().assets.locations.length, 2);
});

test('Studio preserves an imported outline as a prefilled source draft', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-amntv-outline-api-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const app = await buildStudioServer(config(root));
  context.after(() => app.close());
  const sourceContent =
    '\n第一集：女主在雨夜回到旧宅，发现母亲留下的账本。她决定从订婚宴开始反击，并在结尾收到匿名警告。\n';
  const payload = {
    kind: 'outline',
    filename: '她从雨夜归来.md',
    content: sourceContent,
    metadata: {
      seriesId: 'rain-return',
      title: '她从雨夜归来',
      genre: '女性向复仇',
      logline: '她带着母亲留下的账本回城复仇。',
      episodeId: 'EP01',
    },
  };

  const preview = await app.inject({
    method: 'POST',
    url: '/api/imports/preview',
    payload,
  });
  assert.equal(preview.json().ready, true);
  assert.equal(preview.json().summary.requiresAgent, true);

  const imported = await app.inject({
    method: 'POST',
    url: '/api/imports',
    payload,
  });
  assert.equal(imported.statusCode, 201);

  const series = await app.inject({ method: 'GET', url: '/api/series' });
  const draft = series.json().series[0].sourceDrafts[0];
  assert.equal(draft.episodeId, 'EP01');
  assert.equal(draft.filename, '她从雨夜归来.md');
  assert.equal(draft.content, sourceContent);
});

test('Studio imports an existing AI-amnTV project directory without overwriting', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-amntv-project-api-'));
  const sourceRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ai-amntv-project-source-'),
  );
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  context.after(() => fs.rmSync(sourceRoot, { recursive: true, force: true }));
  const source = new ProjectStore(sourceRoot, 'portable-series');
  seedDemo(source);
  fs.writeFileSync(path.join(source.paths.root, '.env'), 'SECRET=not-imported\n');
  fs.mkdirSync(path.join(source.paths.root, 'episodes', '.studio'), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(source.paths.root, 'episodes', '.studio', 'private.db'),
    'not-imported',
  );
  const app = await buildStudioServer(config(root));
  context.after(() => app.close());
  const payload = {
    kind: 'project',
    sourcePath: source.paths.root,
    targetSeriesId: 'portable-copy',
  };

  const preview = await app.inject({
    method: 'POST',
    url: '/api/imports/preview',
    payload,
  });
  assert.equal(preview.json().ready, true);
  assert.equal(preview.json().summary.episodes, 1);
  assert.ok(preview.json().summary.files > 0);

  const imported = await app.inject({
    method: 'POST',
    url: '/api/imports',
    payload,
  });
  assert.equal(imported.statusCode, 201);
  assert.equal(imported.json().seriesId, 'portable-copy');
  assert.equal(fs.existsSync(path.join(root, 'portable-copy', '.env')), false);
  assert.equal(
    fs.existsSync(path.join(root, 'portable-copy', 'episodes', '.studio')),
    false,
  );

  const duplicate = await app.inject({
    method: 'POST',
    url: '/api/imports/preview',
    payload,
  });
  assert.equal(duplicate.json().ready, false);
  assert.equal(duplicate.json().conflict, true);
});
