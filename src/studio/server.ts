import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getConfig, type AppConfig } from '../config.js';
import {
  CharacterSchema,
  LocationSchema,
  ScriptSchema,
  StoryboardSchema,
} from '../domain.js';
import { seedDemo } from '../demo.js';
import {
  approveCast,
  approveFinal,
  approveKeyframes,
  approveScript,
  approveStoryboard,
  initializeSeries,
  requestRetake,
} from '../pipeline/index.js';
import { ProjectStore } from '../store.js';
import { jobTypes, StudioDatabase } from './db.js';
import { StudioEvents } from './events.js';
import { commitImport, previewImport } from './imports.js';
import { listSeries, workspaceView } from './project-view.js';
import { PipelineWorker } from './worker.js';

const SeriesParams = z.object({ series: z.string().min(1) });
const EpisodeParams = z.object({
  series: z.string().min(1),
  episode: z.string().regex(/^EP\d{2,}$/),
});
const CreateSeriesBody = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  title: z.string().min(1),
  genre: z.string().min(1),
  logline: z.string().min(1),
});
const EnqueueBody = z.object({
  type: z.enum(jobTypes),
  payload: z.record(z.string(), z.unknown()).default({}),
});
const PicksBody = z.object({
  picks: z.record(z.string(), z.number().int().positive()).default({}),
});
const RetakeBody = z.object({
  cutId: z.string().min(1),
  stage: z.enum(['keyframe', 'video']),
  instruction: z.string().min(1),
});

function notifyWorkspace(
  events: StudioEvents,
  seriesId: string,
  episodeId: string,
): void {
  events.broadcast('workspace', { seriesId, episodeId });
}

export async function buildStudioServer(
  config: AppConfig,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });
  const database = new StudioDatabase(config.studioDatabase);
  const events = new StudioEvents();
  const worker = new PipelineWorker(config, database, events);
  worker.start();

  app.setErrorHandler((error, _request, reply) => {
    const normalized =
      error instanceof Error ? error : new Error(String(error));
    const statusCode = normalized.name === 'ZodError' ? 400 : 500;
    void reply.status(statusCode).send({
      error: normalized.message,
      ...(statusCode === 500 ? { kind: normalized.name } : {}),
    });
  });

  app.get('/api/health', async () => ({
    ok: true,
    projectsRoot: config.projectsRoot,
    dryRun: config.dryRun,
    database: config.studioDatabase,
  }));

  app.get('/api/series', async () => ({ series: listSeries(config) }));

  app.post('/api/imports/preview', async (request) =>
    previewImport(config, request.body),
  );

  app.post('/api/imports', async (request, reply) => {
    const result = commitImport(config, request.body);
    events.broadcast('series', { id: result.seriesId });
    return reply.status(201).send(result);
  });

  app.post('/api/series', async (request, reply) => {
    const body = CreateSeriesBody.parse(request.body);
    const store = new ProjectStore(config.projectsRoot, body.id);
    const series = initializeSeries(store, body);
    events.broadcast('series', { id: series.id });
    return reply.status(201).send(series);
  });

  app.post('/api/demo', async (request, reply) => {
    if (!config.dryRun) {
      throw new Error('只有 AMNTV_DRY_RUN=1 时才能从工作台创建样例');
    }
    const body = z
      .object({
        seriesId: z
          .string()
          .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
          .default('demo-series'),
      })
      .parse(request.body ?? {});
    const store = new ProjectStore(config.projectsRoot, body.seriesId);
    seedDemo(store);
    events.broadcast('series', { id: body.seriesId });
    return reply.status(201).send({ seriesId: body.seriesId, episodeId: 'EP01' });
  });

  app.get('/api/series/:series/episodes/:episode/workspace', async (request) => {
    const params = EpisodeParams.parse(request.params);
    return workspaceView(config, params.series, params.episode);
  });

  app.put('/api/series/:series/episodes/:episode/script', async (request) => {
    const params = EpisodeParams.parse(request.params);
    const script = ScriptSchema.parse(request.body);
    if (script.episodeId !== params.episode) {
      throw new Error('剧本 episodeId 与 URL 不一致');
    }
    const store = new ProjectStore(config.projectsRoot, params.series);
    store.saveScript(script);
    notifyWorkspace(events, params.series, params.episode);
    return { ok: true };
  });

  app.put(
    '/api/series/:series/episodes/:episode/storyboard',
    async (request) => {
      const params = EpisodeParams.parse(request.params);
      const storyboard = StoryboardSchema.parse(request.body);
      if (storyboard.episodeId !== params.episode) {
        throw new Error('分镜 episodeId 与 URL 不一致');
      }
      const store = new ProjectStore(config.projectsRoot, params.series);
      store.saveStoryboard(storyboard);
      store.initCuts(params.episode, storyboard.cuts);
      notifyWorkspace(events, params.series, params.episode);
      return { ok: true };
    },
  );

  app.put('/api/series/:series/characters/:asset', async (request) => {
    const params = SeriesParams.extend({ asset: z.string().min(1) }).parse(
      request.params,
    );
    const character = CharacterSchema.parse(request.body);
    if (character.id !== params.asset) throw new Error('角色 ID 与 URL 不一致');
    new ProjectStore(config.projectsRoot, params.series).saveCharacter(character);
    events.broadcast('series', { id: params.series });
    return { ok: true };
  });

  app.put('/api/series/:series/locations/:asset', async (request) => {
    const params = SeriesParams.extend({ asset: z.string().min(1) }).parse(
      request.params,
    );
    const location = LocationSchema.parse(request.body);
    if (location.id !== params.asset) throw new Error('场景 ID 与 URL 不一致');
    new ProjectStore(config.projectsRoot, params.series).saveLocation(location);
    events.broadcast('series', { id: params.series });
    return { ok: true };
  });

  app.post('/api/series/:series/episodes/:episode/jobs', async (request, reply) => {
    const params = EpisodeParams.parse(request.params);
    const body = EnqueueBody.parse(request.body);
    const job = database.enqueue({
      seriesId: params.series,
      episodeId: params.episode,
      type: body.type,
      payload: body.payload,
    });
    events.broadcast('job', job);
    return reply.status(202).send(job);
  });

  app.get('/api/jobs', async (request) => {
    const query = z
      .object({
        seriesId: z.string().optional(),
        episodeId: z.string().optional(),
        limit: z.coerce.number().int().positive().max(200).optional(),
      })
      .parse(request.query);
    return {
      jobs: database.list({
        ...(query.seriesId ? { seriesId: query.seriesId } : {}),
        ...(query.episodeId ? { episodeId: query.episodeId } : {}),
        ...(query.limit ? { limit: query.limit } : {}),
      }),
    };
  });

  app.post('/api/jobs/:id/cancel', async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const job = database.cancel(id);
    events.broadcast('job', job);
    return job;
  });

  app.post(
    '/api/series/:series/episodes/:episode/approve/:gate',
    async (request) => {
      const params = EpisodeParams.extend({
        gate: z.enum(['script', 'cast', 'storyboard', 'keyframes', 'final']),
      }).parse(request.params);
      const body = PicksBody.parse(request.body ?? {});
      const store = new ProjectStore(config.projectsRoot, params.series);
      if (params.gate === 'script') {
        await approveScript(config, store, params.episode);
      } else if (params.gate === 'cast') {
        approveCast(store, params.episode, body.picks);
      } else if (params.gate === 'storyboard') {
        approveStoryboard(store, params.episode);
      } else if (params.gate === 'keyframes') {
        approveKeyframes(store, params.episode, body.picks);
      } else {
        approveFinal(store, params.episode);
      }
      notifyWorkspace(events, params.series, params.episode);
      return { ok: true, gate: params.gate };
    },
  );

  app.post(
    '/api/series/:series/episodes/:episode/retakes',
    async (request) => {
      const params = EpisodeParams.parse(request.params);
      const body = RetakeBody.parse(request.body);
      const store = new ProjectStore(config.projectsRoot, params.series);
      requestRetake(
        store,
        params.episode,
        body.cutId,
        body.stage,
        body.instruction,
      );
      notifyWorkspace(events, params.series, params.episode);
      return { ok: true };
    },
  );

  app.get('/api/events', async (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const unsubscribe = events.subscribe(reply.raw);
    const keepAlive = setInterval(() => reply.raw.write(': keep-alive\n\n'), 15_000);
    request.raw.on('close', () => {
      clearInterval(keepAlive);
      unsubscribe();
    });
  });

  await app.register(fastifyStatic, {
    root: config.projectsRoot,
    prefix: '/media/',
    index: false,
    dotfiles: 'deny',
  });

  const webRoot = path.resolve(process.cwd(), 'dist-web');
  if (fs.existsSync(path.join(webRoot, 'index.html'))) {
    await app.register(fastifyStatic, {
      root: webRoot,
      prefix: '/',
      decorateReply: false,
      wildcard: false,
    });
  }

  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith('/api/') || request.url.startsWith('/media/')) {
      return reply.status(404).send({ error: 'Not found' });
    }
    if (fs.existsSync(path.join(webRoot, 'index.html'))) {
      return reply.sendFile('index.html', webRoot);
    }
    return reply.status(404).send({
      error: 'Web 工作台尚未构建；开发模式请运行 npm run studio:dev',
    });
  });

  app.addHook('onClose', async () => {
    worker.stop();
    events.close();
    database.close();
  });
  return app;
}

export async function startStudioServer(
  config: AppConfig,
): Promise<FastifyInstance> {
  const app = await buildStudioServer(config);
  await app.listen({ host: config.studioHost, port: config.studioPort });
  const url = `http://${config.studioHost}:${config.studioPort}`;
  console.log(`[AI-amnTV] Studio 已启动: ${url}`);
  if (!config.noOpen) {
    execFile(
      process.platform === 'win32' ? 'cmd' : 'open',
      process.platform === 'win32' ? ['/c', 'start', '', url] : [url],
      () => undefined,
    );
  }
  return app;
}

const currentFile = fileURLToPath(import.meta.url);
const entryFile = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (entryFile && pathToFileURL(entryFile).href === pathToFileURL(currentFile).href) {
  startStudioServer(getConfig()).catch((caught) => {
    const error = caught instanceof Error ? caught : new Error(String(caught));
    console.error(`[AI-amnTV] Studio 启动失败: ${error.message}`);
    process.exitCode = 1;
  });
}
