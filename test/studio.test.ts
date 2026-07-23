import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { AppConfig } from '../src/config.js';
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

  const hiddenDatabase = await app.inject({
    method: 'GET',
    url: '/media/.studio/studio.db',
  });
  assert.notEqual(hiddenDatabase.statusCode, 200);
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
