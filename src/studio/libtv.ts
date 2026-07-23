import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import YAML from 'yaml';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import {
  assertLibTvResultUrl,
  inspectLibTvUpload,
  LibTvClient,
  type LibTvRemoteMessage,
} from '../providers/libtv.js';
import { ProjectStore, writeYaml } from '../store.js';

const iso = z.string().datetime();
const LibTvReferenceSchema = z.object({
  sourceFile: z.string(),
  name: z.string(),
  bytes: z.number().int().positive(),
  mimeType: z.string(),
  remoteUrl: z.string().url().optional(),
});
const LibTvTurnSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(['submitting', 'sent', 'failed', 'orphaned']),
  instruction: z.string(),
  references: z.array(LibTvReferenceSchema),
  createdAt: iso,
  updatedAt: iso,
  error: z.string().optional(),
});
type LibTvTurn = z.infer<typeof LibTvTurnSchema>;
const LibTvMessageSchema = z.object({
  id: z.string(),
  seq: z.number().int().nonnegative().optional(),
  role: z.string(),
  content: z.string(),
});
const LibTvResultSchema = z.object({
  sourceUrl: z.string().url().optional(),
  file: z.string(),
  mimeType: z.string(),
  bytes: z.number().int().positive(),
});
const LibTvSessionSchema = z.object({
  id: z.string().uuid(),
  seriesId: z.string(),
  episodeId: z.string(),
  status: z.enum([
    'submitting',
    'running',
    'ready',
    'failed',
    'orphaned',
  ]),
  instruction: z.string(),
  references: z.array(LibTvReferenceSchema),
  turns: z.array(LibTvTurnSchema).default([]),
  messages: z.array(LibTvMessageSchema),
  resultSources: z.array(z.string().url()),
  results: z.array(LibTvResultSchema),
  projectUuid: z.string().optional(),
  remoteSessionId: z.string().optional(),
  maxSeq: z.number().int().nonnegative().default(0),
  createdAt: iso,
  updatedAt: iso,
  error: z.string().optional(),
});
type LibTvSession = z.infer<typeof LibTvSessionSchema>;

export const CreateLibTvSessionSchema = z.object({
  instruction: z.string().trim().min(3).max(20_000),
  referenceFiles: z.array(z.string().max(4_096)).max(8).default([]),
});
export const PromoteLibTvResultSchema = z.object({
  resultIndex: z.number().int().nonnegative(),
  cutId: z.string().min(1),
  role: z.enum(['first', 'last']),
  replaceExisting: z.boolean().default(false),
});

function now(): string {
  return new Date().toISOString();
}

function save(store: ProjectStore, session: LibTvSession): LibTvSession {
  const value = LibTvSessionSchema.parse(session);
  writeYaml(
    store.paths.libTvSessionFile(value.episodeId, value.id),
    value,
  );
  return value;
}

function read(file: string): LibTvSession {
  return LibTvSessionSchema.parse(YAML.parse(fs.readFileSync(file, 'utf8')));
}

function withinProject(store: ProjectStore, value: string): string {
  const root = path.resolve(store.paths.root);
  const file = path.resolve(
    path.isAbsolute(value) ? value : path.join(root, value),
  );
  const relative = path.relative(root, file);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('LibTV 参考素材必须位于当前系列目录内');
  }
  return file;
}

function references(store: ProjectStore, values: string[]) {
  return values.map((value) => {
    const sourceFile = withinProject(store, value);
    const inspected = inspectLibTvUpload(sourceFile);
    return {
      sourceFile,
      name: path.basename(sourceFile),
      bytes: inspected.bytes,
      mimeType: inspected.mimeType,
    };
  });
}

function textContent(value: unknown): string {
  if (typeof value === 'string') return value.slice(0, 20_000);
  try {
    return JSON.stringify(value).slice(0, 20_000);
  } catch {
    return String(value).slice(0, 20_000);
  }
}

function normalizedMessages(messages: LibTvRemoteMessage[]) {
  return messages.slice(-200).map((message, index) => ({
    id:
      typeof message.id === 'string'
        ? message.id
        : `${typeof message.seq === 'number' ? message.seq : index}-${message.role ?? 'message'}`,
    ...(typeof message.seq === 'number' && message.seq >= 0
      ? { seq: Math.floor(message.seq) }
      : {}),
    role: typeof message.role === 'string' ? message.role : 'unknown',
    content: textContent(message.content),
  }));
}

function findResultUrls(value: unknown, found = new Set<string>()): Set<string> {
  if (typeof value === 'string') {
    const candidates = value.match(/https:\/\/libtv-res\.liblib\.art\/[^\s"'<>\\]+/g) ?? [];
    for (const candidate of candidates) {
      try {
        assertLibTvResultUrl(candidate);
        found.add(candidate);
      } catch {
        // Ignore URLs outside the approved LibTV result host.
      }
    }
    return found;
  }
  if (Array.isArray(value)) {
    value.slice(0, 500).forEach((item) => findResultUrls(item, found));
    return found;
  }
  if (value && typeof value === 'object') {
    Object.values(value)
      .slice(0, 500)
      .forEach((item) => findResultUrls(item, found));
  }
  return found;
}

function mediaUrl(config: AppConfig, file: string): string | undefined {
  const root = path.resolve(config.projectsRoot);
  const resolved = path.resolve(file);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
  return `/media/${relative
    .split(path.sep)
    .map((part) => encodeURIComponent(part))
    .join('/')}`;
}

function view(config: AppConfig, session: LibTvSession) {
  return {
    ...session,
    ...(session.status === 'ready' &&
    session.projectUuid &&
    !session.projectUuid.startsWith('dry-run-')
      ? {
          projectUrl: `https://www.liblib.tv/canvas?projectId=${encodeURIComponent(
            session.projectUuid,
          )}`,
        }
      : {}),
    results: session.results.map((result) => ({
      ...result,
      url: mediaUrl(config, result.file),
    })),
  };
}

async function dryRunPreview(file: string, session: LibTvSession): Promise<void> {
  const title = session.instruction.replace(/[<>&]/g, '').slice(0, 42);
  const svg = Buffer.from(`
    <svg width="720" height="1280" xmlns="http://www.w3.org/2000/svg">
      <rect width="720" height="1280" fill="#0d1117"/>
      <rect x="44" y="44" width="632" height="1192" fill="none" stroke="#f0b35a" stroke-width="2"/>
      <text x="72" y="120" fill="#f0b35a" font-family="sans-serif" font-size="22" letter-spacing="4">LIBTV CANVAS · DRY RUN</text>
      <text x="72" y="590" fill="#f5f2ea" font-family="sans-serif" font-size="36">${title}</text>
      <text x="72" y="650" fill="#9da7b3" font-family="sans-serif" font-size="22">未调用云端模型 · 本地流程验收图</text>
      <text x="72" y="1160" fill="#9da7b3" font-family="monospace" font-size="18">${session.seriesId} / ${session.episodeId}</text>
    </svg>
  `);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await sharp(svg).png().toFile(file);
}

export class LibTvStudioService {
  private readonly client: LibTvClient;

  constructor(private readonly config: AppConfig) {
    this.client = new LibTvClient(config);
  }

  status() {
    if (this.config.dryRun) {
      return {
        ready: true,
        mode: 'dry-run' as const,
        message: '本地演示模式；不会调用 LibTV 或产生费用',
      };
    }
    return {
      ...this.client.status(),
      mode: 'live' as const,
    };
  }

  list(store: ProjectStore, episodeId: string) {
    const root = store.paths.libTvSessionsDir(episodeId);
    if (!fs.existsSync(root)) return [];
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.yaml'))
      .flatMap((entry) => {
        try {
          const session = read(path.join(root, entry.name));
          const submittingTooLong =
            session.status === 'submitting' &&
            Date.now() - Date.parse(session.updatedAt) > 5 * 60 * 1_000;
          if (submittingTooLong) {
            session.status = 'orphaned';
            session.error =
              'Studio 在远端会话 ID 落盘前中断；未自动重提以避免重复费用';
            session.updatedAt = now();
            save(store, session);
          }
          for (const turn of session.turns) {
            if (
              turn.status === 'submitting' &&
              Date.now() - Date.parse(turn.updatedAt) > 5 * 60 * 1_000
            ) {
              turn.status = 'orphaned';
              turn.error =
                'Studio 在续写返回前中断；未自动重发，以避免重复生成和费用';
              turn.updatedAt = now();
              session.updatedAt = turn.updatedAt;
              save(store, session);
            }
          }
          return [view(this.config, session)];
        } catch {
          return [];
        }
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  private get(
    store: ProjectStore,
    episodeId: string,
    id: string,
  ): LibTvSession {
    const file = store.paths.libTvSessionFile(episodeId, id);
    if (!fs.existsSync(file)) throw new Error('LibTV 会话不存在');
    const session = read(file);
    if (session.seriesId !== store.seriesId || session.episodeId !== episodeId) {
      throw new Error('LibTV 会话不属于当前分集');
    }
    return session;
  }

  async create(
    store: ProjectStore,
    episodeId: string,
    input: unknown,
  ) {
    const body = CreateLibTvSessionSchema.parse(input);
    const provider = this.status();
    if (!provider.ready) throw new Error(provider.message);
    const at = now();
    const preparedReferences = references(store, body.referenceFiles);
    const firstTurn: LibTvTurn = {
      id: randomUUID(),
      status: 'submitting',
      instruction: body.instruction,
      references: preparedReferences,
      createdAt: at,
      updatedAt: at,
    };
    let session: LibTvSession = {
      id: randomUUID(),
      seriesId: store.seriesId,
      episodeId,
      status: 'submitting',
      instruction: body.instruction,
      references: preparedReferences,
      turns: [firstTurn],
      messages: [],
      resultSources: [],
      results: [],
      maxSeq: 0,
      createdAt: at,
      updatedAt: at,
    };
    save(store, session);
    try {
      if (this.config.dryRun) {
        const file = path.join(
          store.paths.libTvResultsDir(episodeId, session.id),
          'canvas-preview.png',
        );
        await dryRunPreview(file, session);
        session = {
          ...session,
          status: 'ready',
          projectUuid: `dry-run-${session.id}`,
          remoteSessionId: `dry-run-${session.id}`,
          messages: [
            {
              id: `local-user-${firstTurn.id}`,
              role: 'user',
              content: body.instruction,
            },
            {
              id: 'dry-run-result',
              role: 'assistant',
              content: '本地 dry-run 已完成；未向外部服务发送任何资料。',
            },
          ],
          results: [
            {
              file,
              mimeType: 'image/png',
              bytes: fs.statSync(file).size,
            },
          ],
          updatedAt: now(),
        };
        session.turns[0]!.status = 'sent';
        session.turns[0]!.updatedAt = session.updatedAt;
        save(store, session);
        return view(this.config, session);
      }
      for (let index = 0; index < session.references.length; index += 1) {
        const reference = session.references[index]!;
        reference.remoteUrl = await this.client.uploadFile(reference.sourceFile);
        session.turns[0]!.references[index]!.remoteUrl = reference.remoteUrl;
        session.updatedAt = now();
        session.turns[0]!.updatedAt = session.updatedAt;
        save(store, session);
      }
      const referenceText = session.references
        .flatMap((reference) =>
          reference.remoteUrl ? [`参考素材：${reference.remoteUrl}`] : [],
        )
        .join('\n');
      const created = await this.client.createSession(
        [session.instruction, referenceText].filter(Boolean).join('\n'),
      );
      session = {
        ...session,
        status: 'running',
        projectUuid: created.projectUuid,
        remoteSessionId: created.sessionId,
        messages: [
          {
            id: `local-user-${firstTurn.id}`,
            role: 'user',
            content: body.instruction,
          },
        ],
        updatedAt: now(),
      };
      session.turns[0]!.status = 'sent';
      session.turns[0]!.updatedAt = session.updatedAt;
      save(store, session);
      return view(this.config, session);
    } catch (caught) {
      const error = caught instanceof Error ? caught : new Error(String(caught));
      session.status = 'failed';
      session.error = error.message;
      session.updatedAt = now();
      session.turns[0]!.status = 'failed';
      session.turns[0]!.error = error.message;
      session.turns[0]!.updatedAt = session.updatedAt;
      save(store, session);
      throw error;
    }
  }

  async continue(
    store: ProjectStore,
    episodeId: string,
    id: string,
    input: unknown,
  ) {
    const body = CreateLibTvSessionSchema.parse(input);
    const provider = this.status();
    if (!provider.ready) throw new Error(provider.message);
    let session = this.get(store, episodeId, id);
    if (!this.config.dryRun && !session.remoteSessionId) {
      throw new Error('LibTV 会话缺少远端 sessionId，不能续写');
    }
    const at = now();
    const turn: LibTvTurn = {
      id: randomUUID(),
      status: 'submitting',
      instruction: body.instruction,
      references: references(store, body.referenceFiles),
      createdAt: at,
      updatedAt: at,
    };
    session.turns.push(turn);
    session.updatedAt = at;
    delete session.error;
    save(store, session);
    try {
      if (this.config.dryRun) {
        const file = path.join(
          store.paths.libTvResultsDir(episodeId, session.id),
          `canvas-preview-${String(session.turns.length).padStart(2, '0')}.png`,
        );
        await dryRunPreview(file, { ...session, instruction: body.instruction });
        const updatedAt = now();
        turn.status = 'sent';
        turn.updatedAt = updatedAt;
        session = {
          ...session,
          status: 'ready',
          messages: [
            ...session.messages,
            {
              id: `local-user-${turn.id}`,
              role: 'user',
              content: body.instruction,
            },
            {
              id: `dry-run-result-${turn.id}`,
              role: 'assistant',
              content: '本地 dry-run 续写已完成；未向外部服务发送任何资料。',
            },
          ],
          results: [
            ...session.results,
            {
              file,
              mimeType: 'image/png',
              bytes: fs.statSync(file).size,
            },
          ],
          updatedAt,
        };
        save(store, session);
        return view(this.config, session);
      }
      for (let index = 0; index < turn.references.length; index += 1) {
        const reference = turn.references[index]!;
        reference.remoteUrl = await this.client.uploadFile(reference.sourceFile);
        turn.updatedAt = now();
        session.updatedAt = turn.updatedAt;
        save(store, session);
      }
      const referenceText = turn.references
        .flatMap((reference) =>
          reference.remoteUrl ? [`参考素材：${reference.remoteUrl}`] : [],
        )
        .join('\n');
      const created = await this.client.createSession(
        [turn.instruction, referenceText].filter(Boolean).join('\n'),
        session.remoteSessionId,
      );
      const updatedAt = now();
      turn.status = 'sent';
      turn.updatedAt = updatedAt;
      session = {
        ...session,
        status: 'running',
        projectUuid: created.projectUuid,
        remoteSessionId: created.sessionId,
        messages: [
          ...session.messages,
          {
            id: `local-user-${turn.id}`,
            role: 'user',
            content: turn.instruction,
          },
        ],
        updatedAt,
      };
      save(store, session);
      return view(this.config, session);
    } catch (caught) {
      const error = caught instanceof Error ? caught : new Error(String(caught));
      turn.status = 'failed';
      turn.error = error.message;
      turn.updatedAt = now();
      session.error = error.message;
      session.updatedAt = turn.updatedAt;
      save(store, session);
      throw error;
    }
  }

  async refresh(store: ProjectStore, episodeId: string, id: string) {
    let session = this.get(store, episodeId, id);
    if (this.config.dryRun || session.status === 'orphaned') {
      return view(this.config, session);
    }
    if (!session.remoteSessionId) {
      throw new Error('LibTV 会话缺少远端 sessionId，不能查询');
    }
    try {
      const remote = await this.client.querySession(
        session.remoteSessionId,
        session.maxSeq,
      );
      const incoming = normalizedMessages(remote);
      const known = new Set(session.messages.map((message) => message.id));
      session.messages.push(
        ...incoming.filter((message) => !known.has(message.id)),
      );
      const maxSeq = incoming.reduce(
        (maximum, message) => Math.max(maximum, message.seq ?? 0),
        session.maxSeq,
      );
      const sources = new Set(session.resultSources);
      findResultUrls(remote).forEach((url) => sources.add(url));
      session = {
        ...session,
        status: sources.size > 0 ? 'ready' : 'running',
        maxSeq,
        resultSources: [...sources],
        updatedAt: now(),
      };
      delete session.error;
      save(store, session);
      return view(this.config, session);
    } catch (caught) {
      const error = caught instanceof Error ? caught : new Error(String(caught));
      session.error = error.message;
      session.updatedAt = now();
      save(store, session);
      throw error;
    }
  }

  async collect(store: ProjectStore, episodeId: string, id: string) {
    let session = this.get(store, episodeId, id);
    if (this.config.dryRun) return view(this.config, session);
    session = LibTvSessionSchema.parse(
      await this.refresh(store, episodeId, id),
    );
    const resultDir = store.paths.libTvResultsDir(episodeId, id);
    fs.mkdirSync(resultDir, { recursive: true });
    for (const sourceUrl of session.resultSources) {
      if (session.results.some((result) => result.sourceUrl === sourceUrl)) {
        continue;
      }
      const downloaded = await this.client.downloadResult(sourceUrl);
      let index = session.results.length + 1;
      let file = path.join(
        resultDir,
        `${String(index).padStart(2, '0')}${downloaded.extension}`,
      );
      while (fs.existsSync(file)) {
        index += 1;
        file = path.join(
          resultDir,
          `${String(index).padStart(2, '0')}${downloaded.extension}`,
        );
      }
      fs.writeFileSync(file, downloaded.bytes, { flag: 'wx' });
      session.results.push({
        sourceUrl,
        file,
        mimeType: downloaded.mimeType,
        bytes: downloaded.bytes.length,
      });
      session.updatedAt = now();
      save(store, session);
    }
    return view(this.config, session);
  }

  async promote(
    store: ProjectStore,
    episodeId: string,
    id: string,
    input: unknown,
  ) {
    const body = PromoteLibTvResultSchema.parse(input);
    const session = this.get(store, episodeId, id);
    const result = session.results[body.resultIndex];
    if (!result) throw new Error('LibTV 本地结果不存在');
    if (!result.mimeType.startsWith('image/')) {
      throw new Error('只有图片结果可以晋升为关键帧候选');
    }
    if (!fs.existsSync(result.file)) throw new Error('LibTV 本地结果文件缺失');
    const storyboard = store.storyboard(episodeId);
    const cut = storyboard.cuts.find((item) => item.id === body.cutId);
    if (!cut) throw new Error(`分镜中不存在卡 ${body.cutId}`);
    const roles =
      cut.genMode === 'first_last' || cut.genMode === 'multi_frame'
        ? ['first', 'last']
        : ['first'];
    if (!roles.includes(body.role)) {
      throw new Error(`${cut.id} 的 ${cut.genMode} 模式不需要 ${body.role} 帧`);
    }
    let state = store.state(episodeId);
    const entry = state.cuts[cut.id];
    if (!entry) throw new Error(`状态表不存在卡 ${cut.id}`);
    const advanced = [
      'keyframe_selected',
      'video_generating',
      'video_ready',
      'sakkan_pass',
      'composited',
      'failed',
    ].includes(entry.stage);
    if (advanced && !body.replaceExisting) {
      throw new Error('该镜头已有下游结果；确认替换后才会创建新 round 并撤销下游状态');
    }
    let round = entry.retakeCount;
    if (advanced) {
      round = store.resetCutForRetake(
        episodeId,
        cut.id,
        'audio_ready',
        `LibTV 结果 ${session.id.slice(0, 8)} 晋升为关键帧候选`,
      );
      state = store.state(episodeId);
    }
    const root = path.join(
      store.paths.cut(episodeId, cut.id).keyframeCandidates,
      body.role,
      `round-${String(round).padStart(2, '0')}`,
    );
    fs.mkdirSync(root, { recursive: true });
    const existing = fs
      .readdirSync(root)
      .map((name) => /^candidate-(\d+)\.png$/.exec(name)?.[1])
      .filter((value): value is string => Boolean(value))
      .map(Number);
    const candidateIndex = Math.max(0, ...existing) + 1;
    const file = path.join(root, `candidate-${candidateIndex}.png`);
    const temporary = `${file}.tmp-${randomUUID()}.png`;
    await sharp(result.file).png().toFile(temporary);
    fs.renameSync(temporary, file);
    writeYaml(
      path.join(
        store.paths.cut(episodeId, cut.id).meta,
        `libtv-promotion-${Date.now()}.yaml`,
      ),
      {
        source: 'libtv',
        sessionId: session.id,
        remoteSessionId: session.remoteSessionId,
        resultIndex: body.resultIndex,
        sourceFile: result.file,
        cutId: cut.id,
        role: body.role,
        round,
        candidateIndex,
        file,
        promotedAt: now(),
      },
    );
    if (state.cuts[cut.id]?.stage === 'audio_ready') {
      store.transition(episodeId, cut.id, 'keyframes_ready');
    }
    return {
      ok: true as const,
      cutId: cut.id,
      role: body.role,
      round,
      candidateIndex,
      file,
    };
  }
}
