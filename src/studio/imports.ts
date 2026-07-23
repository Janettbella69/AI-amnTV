import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import {
  CharacterSchema,
  EpisodeStateSchema,
  LocationSchema,
  ScriptSchema,
  SeriesSchema,
  StoryboardSchema,
  type Character,
  type Location,
  type Script,
  type Series,
  type Storyboard,
} from '../domain.js';
import {
  referencedAssets,
  validateScript,
  validateStoryboard,
} from '../pipeline/validation.js';
import { ProjectStore, writeYaml } from '../store.js';

const safeId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const metadataSchema = z.object({
  seriesId: z.union([safeId, z.literal('')]).default(''),
  title: z.string().max(200).default(''),
  genre: z.string().max(100).default(''),
  logline: z.string().max(2_000).default(''),
  episodeId: z
    .union([z.string().regex(/^EP\d{2,}$/), z.literal('')])
    .default(''),
});

export const ImportRequestSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('project'),
    sourcePath: z.string().trim().min(1).max(4_096),
    targetSeriesId: z.union([safeId, z.literal('')]).default(''),
  }),
  z.object({
    kind: z.literal('script'),
    filename: z.string().trim().min(1).max(255),
    content: z.string().min(1).max(1_500_000),
    metadata: metadataSchema,
  }),
  z.object({
    kind: z.literal('outline'),
    filename: z.string().trim().min(1).max(255),
    content: z
      .string()
      .min(1)
      .max(1_500_000)
      .refine((value) => value.trim().length >= 20, '正文至少需要 20 个字符'),
    metadata: metadataSchema,
  }),
]);

export type ImportRequest = z.infer<typeof ImportRequestSchema>;

export interface ImportPreview {
  kind: ImportRequest['kind'];
  ready: boolean;
  errors: string[];
  warnings: string[];
  conflict: boolean;
  normalized: {
    seriesId: string;
    title: string;
    genre: string;
    logline: string;
    episodeId: string;
  };
  summary: {
    source: string;
    episodes: number;
    scenes: number;
    cuts: number;
    characters: number;
    locations: number;
    bytes: number;
    files?: number;
    requiresAgent?: boolean;
    alreadyAvailable?: boolean;
  };
}

export interface ImportResult {
  ok: true;
  kind: ImportRequest['kind'];
  seriesId: string;
  episodeId?: string;
  alreadyAvailable?: boolean;
}

interface ScriptBundle {
  series?: Series;
  script: Script;
  storyboard?: Storyboard;
  characters: Character[];
  locations: Location[];
}

interface ProjectInspection {
  sourceRoot: string;
  targetSeriesId: string;
  series: Series;
  episodeIds: string[];
  scenes: number;
  cuts: number;
  characters: number;
  locations: number;
  bytes: number;
  files: number;
  destination: string;
  sameAsDestination: boolean;
}

function defaultSeries(
  id: string,
  metadata: ImportPreview['normalized'],
): Series {
  return {
    id,
    title: metadata.title,
    genre: metadata.genre || 'AI 漫剧',
    logline: metadata.logline,
    spec: {
      width: 1080,
      height: 1920,
      fps: 24,
      episodeDurationSec: [60, 120],
      targetCuts: [15, 25],
    },
    style: {
      prompt:
        'anime, clean line art, cinematic cel shading, consistent character design',
      negativePrompt:
        'photorealistic, 3d render, text, logo, watermark, extra fingers, deformed face',
      referenceImages: [],
      imageModel: '配置 COMFYUI_WORKFLOW 或使用 AMNTV_DRY_RUN=1',
    },
  };
}

function parseStructured(filename: string, content: string): unknown {
  const clean = content.replace(/^\uFEFF/, '');
  if (filename.toLowerCase().endsWith('.json')) return JSON.parse(clean);
  return YAML.parse(clean);
}

function parseScriptBundle(filename: string, content: string): ScriptBundle {
  const value = parseStructured(filename, content);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('结构化文件必须是剧本对象，或包含 series/script 的项目对象');
  }
  const object = value as Record<string, unknown>;
  const script = ScriptSchema.parse(object.script ?? object);
  return {
    ...(object.series ? { series: SeriesSchema.parse(object.series) } : {}),
    script,
    ...(object.storyboard
      ? { storyboard: StoryboardSchema.parse(object.storyboard) }
      : {}),
    characters: z
      .array(CharacterSchema)
      .default([])
      .parse(object.characters),
    locations: z.array(LocationSchema).default([]).parse(object.locations),
  };
}

function normalizedScriptMetadata(
  request: Extract<ImportRequest, { kind: 'script' }>,
  bundle: ScriptBundle,
): ImportPreview['normalized'] {
  const title = request.metadata.title.trim() || bundle.series?.title || bundle.script.title;
  return {
    seriesId:
      request.metadata.seriesId ||
      bundle.series?.id ||
      path.basename(request.filename, path.extname(request.filename)),
    title,
    genre: request.metadata.genre.trim() || bundle.series?.genre || 'AI 漫剧',
    logline:
      request.metadata.logline.trim() ||
      bundle.series?.logline ||
      bundle.script.emotionContract.promise,
    episodeId: bundle.script.episodeId,
  };
}

function normalizedOutlineMetadata(
  request: Extract<ImportRequest, { kind: 'outline' }>,
): ImportPreview['normalized'] {
  const stem = path.basename(request.filename, path.extname(request.filename));
  return {
    seriesId: request.metadata.seriesId || stem,
    title: request.metadata.title.trim() || stem,
    genre: request.metadata.genre.trim() || 'AI 漫剧',
    logline:
      request.metadata.logline.trim() ||
      request.content.replace(/\s+/g, ' ').slice(0, 120),
    episodeId: request.metadata.episodeId || 'EP01',
  };
}

function expandHome(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith(`~${path.sep}`)) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function projectSourceRoot(value: string): string {
  const resolved = path.resolve(expandHome(value.trim()));
  if (!fs.existsSync(resolved)) throw new Error(`找不到项目路径：${resolved}`);
  const stat = fs.statSync(resolved);
  const root = stat.isFile() && path.basename(resolved) === 'series.yaml'
    ? path.dirname(resolved)
    : resolved;
  if (!fs.statSync(root).isDirectory()) throw new Error('项目来源必须是目录');
  if (!fs.existsSync(path.join(root, 'series.yaml'))) {
    throw new Error('所选目录缺少 series.yaml，不是 AI-amnTV 项目');
  }
  return root;
}

function parseYamlFile<T>(file: string, schema: z.ZodType<T>): T {
  return schema.parse(YAML.parse(fs.readFileSync(file, 'utf8')));
}

function isHiddenImportPath(relative: string): boolean {
  return relative
    .split(path.sep)
    .filter(Boolean)
    .some((part) => part.startsWith('.'));
}

function scanTree(root: string): { bytes: number; files: number } {
  let bytes = 0;
  let files = 0;
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const file = path.join(directory, entry.name);
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) {
        throw new Error(`项目包含符号链接，出于安全原因不能导入：${file}`);
      }
      if (stat.isDirectory()) {
        visit(file);
      } else if (stat.isFile()) {
        files += 1;
        bytes += stat.size;
        if (files > 100_000) throw new Error('项目文件超过 100,000 个，不能直接导入');
        if (bytes > 50 * 1024 * 1024 * 1024) {
          throw new Error('项目体积超过 50GB，不能直接导入');
        }
      }
    }
  };
  visit(root);
  return { bytes, files };
}

function inspectProject(
  config: AppConfig,
  request: Extract<ImportRequest, { kind: 'project' }>,
): ProjectInspection {
  const sourceRoot = projectSourceRoot(request.sourcePath);
  const series = parseYamlFile(path.join(sourceRoot, 'series.yaml'), SeriesSchema);
  const targetSeriesId = request.targetSeriesId || series.id;
  safeId.parse(targetSeriesId);
  const episodesRoot = path.join(sourceRoot, 'episodes');
  const episodeIds = fs.existsSync(episodesRoot)
    ? fs
        .readdirSync(episodesRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^EP\d{2,}$/.test(entry.name))
        .map((entry) => entry.name)
        .sort()
    : [];
  let scenes = 0;
  let cuts = 0;
  for (const episodeId of episodeIds) {
    const root = path.join(episodesRoot, episodeId);
    const scriptFile = path.join(root, 'script.yaml');
    const storyboardFile = path.join(root, 'storyboard.yaml');
    const stateFile = path.join(root, 'state.yaml');
    if (fs.existsSync(scriptFile)) {
      scenes += parseYamlFile(scriptFile, ScriptSchema).scenes.length;
    }
    if (fs.existsSync(storyboardFile)) {
      cuts += parseYamlFile(storyboardFile, StoryboardSchema).cuts.length;
    }
    if (fs.existsSync(stateFile)) parseYamlFile(stateFile, EpisodeStateSchema);
  }
  const charactersRoot = path.join(sourceRoot, 'assets', 'characters');
  const locationsRoot = path.join(sourceRoot, 'assets', 'locations');
  const profileCount = <T>(
    root: string,
    filename: string,
    schema: z.ZodType<T>,
  ): number => {
    if (!fs.existsSync(root)) return 0;
    let count = 0;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = path.join(root, entry.name, filename);
      if (!fs.existsSync(file)) continue;
      parseYamlFile(file, schema);
      count += 1;
    }
    return count;
  };
  const characters = profileCount(
    charactersRoot,
    'profile.yaml',
    CharacterSchema,
  );
  const locations = profileCount(locationsRoot, 'profile.yaml', LocationSchema);
  const { bytes, files } = scanTree(sourceRoot);
  const destination = new ProjectStore(
    config.projectsRoot,
    targetSeriesId,
  ).paths.root;
  return {
    sourceRoot,
    targetSeriesId,
    series,
    episodeIds,
    scenes,
    cuts,
    characters,
    locations,
    bytes,
    files,
    destination,
    sameAsDestination: path.resolve(sourceRoot) === path.resolve(destination),
  };
}

function blankPreview(
  kind: ImportRequest['kind'],
  source: string,
): ImportPreview {
  return {
    kind,
    ready: false,
    errors: [],
    warnings: [],
    conflict: false,
    normalized: {
      seriesId: '',
      title: '',
      genre: '',
      logline: '',
      episodeId: '',
    },
    summary: {
      source,
      episodes: 0,
      scenes: 0,
      cuts: 0,
      characters: 0,
      locations: 0,
      bytes: 0,
    },
  };
}

function previewProject(
  config: AppConfig,
  request: Extract<ImportRequest, { kind: 'project' }>,
): ImportPreview {
  const inspection = inspectProject(config, request);
  const conflict =
    fs.existsSync(inspection.destination) && !inspection.sameAsDestination;
  return {
    kind: request.kind,
    ready: !conflict,
    errors: conflict ? [`目标系列已存在：${inspection.targetSeriesId}`] : [],
    warnings: [
      ...(inspection.episodeIds.length === 0 ? ['项目中没有可识别的分集'] : []),
      ...(inspection.sameAsDestination ? ['该项目已经位于当前项目库中'] : []),
    ],
    conflict,
    normalized: {
      seriesId: inspection.targetSeriesId,
      title: inspection.series.title,
      genre: inspection.series.genre,
      logline: inspection.series.logline,
      episodeId: inspection.episodeIds[0] ?? '',
    },
    summary: {
      source: inspection.sourceRoot,
      episodes: inspection.episodeIds.length,
      scenes: inspection.scenes,
      cuts: inspection.cuts,
      characters: inspection.characters,
      locations: inspection.locations,
      bytes: inspection.bytes,
      files: inspection.files,
      alreadyAvailable: inspection.sameAsDestination,
    },
  };
}

function previewScript(
  config: AppConfig,
  request: Extract<ImportRequest, { kind: 'script' }>,
): ImportPreview {
  const bundle = parseScriptBundle(request.filename, request.content);
  const normalized = normalizedScriptMetadata(request, bundle);
  safeId.parse(normalized.seriesId);
  const store = new ProjectStore(config.projectsRoot, normalized.seriesId);
  const scriptValidation = validateScript(bundle.script);
  const storyboardValidation =
    bundle.storyboard && bundle.series
      ? validateStoryboard(bundle.series, bundle.script, bundle.storyboard)
      : undefined;
  const referenced = referencedAssets(bundle.script, bundle.storyboard);
  const suppliedCharacters = new Set(bundle.characters.map((item) => item.id));
  const suppliedLocations = new Set(bundle.locations.map((item) => item.id));
  const missingCharacters = referenced.characterIds.filter(
    (id) => !suppliedCharacters.has(id),
  );
  const missingLocations = referenced.locationIds.filter(
    (id) => !suppliedLocations.has(id),
  );
  const conflict = fs.existsSync(store.paths.root);
  const errors = [
    ...(!normalized.title ? ['缺少系列名称'] : []),
    ...(!normalized.logline ? ['缺少一句话故事'] : []),
    ...(conflict ? [`目标系列已存在：${normalized.seriesId}`] : []),
  ];
  return {
    kind: request.kind,
    ready: errors.length === 0,
    errors,
    warnings: [
      ...scriptValidation.errors,
      ...(storyboardValidation?.errors ?? []),
      ...(missingCharacters.length
        ? [`将为 ${missingCharacters.join('、')} 创建待完善角色档案`]
        : []),
      ...(missingLocations.length
        ? [`将为 ${missingLocations.join('、')} 创建待完善场景档案`]
        : []),
      ...(bundle.script.status === 'locked'
        ? ['导入后仍需在本工作台重新批准剧本关卡']
        : []),
    ],
    conflict,
    normalized,
    summary: {
      source: request.filename,
      episodes: 1,
      scenes: bundle.script.scenes.length,
      cuts: bundle.storyboard?.cuts.length ?? 0,
      characters: new Set([
        ...referenced.characterIds,
        ...bundle.characters.map((item) => item.id),
      ]).size,
      locations: new Set([
        ...referenced.locationIds,
        ...bundle.locations.map((item) => item.id),
      ]).size,
      bytes: Buffer.byteLength(request.content),
    },
  };
}

function previewOutline(
  config: AppConfig,
  request: Extract<ImportRequest, { kind: 'outline' }>,
): ImportPreview {
  const normalized = normalizedOutlineMetadata(request);
  safeId.parse(normalized.seriesId);
  const conflict = fs.existsSync(
    new ProjectStore(config.projectsRoot, normalized.seriesId).paths.root,
  );
  const errors = [
    ...(!normalized.title ? ['缺少系列名称'] : []),
    ...(!normalized.logline ? ['缺少一句话故事'] : []),
    ...(conflict ? [`目标系列已存在：${normalized.seriesId}`] : []),
  ];
  return {
    kind: request.kind,
    ready: errors.length === 0,
    errors,
    warnings: ['导入后将进入编剧 Agent；真实生成需要 ANTHROPIC_API_KEY'],
    conflict,
    normalized,
    summary: {
      source: request.filename,
      episodes: 1,
      scenes: 0,
      cuts: 0,
      characters: 0,
      locations: 0,
      bytes: Buffer.byteLength(request.content),
      requiresAgent: true,
    },
  };
}

export function previewImport(config: AppConfig, input: unknown): ImportPreview {
  let request: ImportRequest;
  try {
    request = ImportRequestSchema.parse(input);
  } catch (caught) {
    const error = caught instanceof Error ? caught : new Error(String(caught));
    return {
      ...blankPreview('script', '未知来源'),
      errors: [error.message],
    };
  }
  try {
    if (request.kind === 'project') return previewProject(config, request);
    if (request.kind === 'script') return previewScript(config, request);
    return previewOutline(config, request);
  } catch (caught) {
    const error = caught instanceof Error ? caught : new Error(String(caught));
    return {
      ...blankPreview(
        request.kind,
        request.kind === 'project' ? request.sourcePath : request.filename,
      ),
      errors: [error.message],
    };
  }
}

function placeholderCharacter(id: string): Character {
  return {
    id,
    name: id,
    age: '',
    personality: '导入后待完善',
    relationships: {},
    turnaround: [],
    expressions: {},
    outfits: {
      'OF-01-a': { label: '默认服装（待完善）', referenceImage: '' },
    },
    palette: {
      normal: ['#808080'],
      night: ['#404050'],
      evening: ['#806050'],
    },
    voice: { provider: 'stub', voiceId: `import-${id}`, params: {} },
    status: 'draft',
  };
}

function placeholderLocation(id: string): Location {
  return {
    id,
    name: id,
    referenceImages: [],
    variants: {},
    status: 'draft',
  };
}

function withStagedProject<T>(
  config: AppConfig,
  seriesId: string,
  write: (store: ProjectStore) => T,
): T {
  fs.mkdirSync(config.projectsRoot, { recursive: true });
  const destination = new ProjectStore(config.projectsRoot, seriesId).paths.root;
  if (fs.existsSync(destination)) throw new Error(`目标系列已存在：${seriesId}`);
  const stagingParent = fs.mkdtempSync(
    path.join(config.projectsRoot, '.import-'),
  );
  const store = new ProjectStore(stagingParent, seriesId);
  try {
    const result = write(store);
    fs.renameSync(store.paths.root, destination);
    return result;
  } finally {
    fs.rmSync(stagingParent, { recursive: true, force: true });
  }
}

function rebaseValue(value: unknown, sourceRoot: string, targetRoot: string): unknown {
  if (typeof value === 'string' && path.isAbsolute(value)) {
    const relative = path.relative(sourceRoot, value);
    if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
      return path.join(targetRoot, relative);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => rebaseValue(item, sourceRoot, targetRoot));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        rebaseValue(item, sourceRoot, targetRoot),
      ]),
    );
  }
  return value;
}

function rebaseStructuredFiles(
  root: string,
  sourceRoot: string,
  targetRoot: string,
): void {
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(file);
        continue;
      }
      if (!entry.isFile() || fs.statSync(file).size > 20 * 1024 * 1024) continue;
      const extension = path.extname(file).toLowerCase();
      try {
        if (extension === '.yaml' || extension === '.yml') {
          const value = YAML.parse(fs.readFileSync(file, 'utf8'));
          writeYaml(file, rebaseValue(value, sourceRoot, targetRoot));
        } else if (extension === '.json') {
          const value = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
          fs.writeFileSync(
            file,
            JSON.stringify(rebaseValue(value, sourceRoot, targetRoot), null, 2),
          );
        }
      } catch {
        // Non-structured sidecar files are copied unchanged.
      }
    }
  };
  visit(root);
}

function importProject(
  config: AppConfig,
  request: Extract<ImportRequest, { kind: 'project' }>,
): ImportResult {
  const inspection = inspectProject(config, request);
  if (inspection.sameAsDestination) {
    return {
      ok: true,
      kind: request.kind,
      seriesId: inspection.targetSeriesId,
      ...(inspection.episodeIds[0]
        ? { episodeId: inspection.episodeIds[0] }
        : {}),
      alreadyAvailable: true,
    };
  }
  if (fs.existsSync(inspection.destination)) {
    throw new Error(`目标系列已存在：${inspection.targetSeriesId}`);
  }
  return withStagedProject(config, inspection.targetSeriesId, (store) => {
    fs.cpSync(inspection.sourceRoot, store.paths.root, {
      recursive: true,
      preserveTimestamps: true,
      filter: (source) => {
        const relative = path.relative(inspection.sourceRoot, source);
        return !isHiddenImportPath(relative);
      },
    });
    rebaseStructuredFiles(
      store.paths.root,
      inspection.sourceRoot,
      inspection.destination,
    );
    store.saveSeries({ ...store.series(), id: inspection.targetSeriesId });
    return {
      ok: true,
      kind: request.kind,
      seriesId: inspection.targetSeriesId,
      ...(inspection.episodeIds[0]
        ? { episodeId: inspection.episodeIds[0] }
        : {}),
    };
  });
}

function importScript(
  config: AppConfig,
  request: Extract<ImportRequest, { kind: 'script' }>,
): ImportResult {
  const bundle = parseScriptBundle(request.filename, request.content);
  const normalized = normalizedScriptMetadata(request, bundle);
  return withStagedProject(config, normalized.seriesId, (store) => {
    const series = bundle.series
      ? SeriesSchema.parse({
          ...bundle.series,
          id: normalized.seriesId,
          title: normalized.title,
          genre: normalized.genre,
          logline: normalized.logline,
        })
      : defaultSeries(normalized.seriesId, normalized);
    store.saveSeries(series);
    for (const character of bundle.characters) store.saveCharacter(character);
    for (const location of bundle.locations) store.saveLocation(location);
    const referenced = referencedAssets(bundle.script, bundle.storyboard);
    for (const id of referenced.characterIds) {
      if (!store.character(id)) store.saveCharacter(placeholderCharacter(id));
    }
    for (const id of referenced.locationIds) {
      if (!store.location(id)) store.saveLocation(placeholderLocation(id));
    }
    store.saveScript(bundle.script);
    if (bundle.storyboard) {
      store.saveStoryboard(bundle.storyboard);
      store.initCuts(bundle.script.episodeId, bundle.storyboard.cuts);
    }
    return {
      ok: true,
      kind: request.kind,
      seriesId: normalized.seriesId,
      episodeId: bundle.script.episodeId,
    };
  });
}

function importOutline(
  config: AppConfig,
  request: Extract<ImportRequest, { kind: 'outline' }>,
): ImportResult {
  const normalized = normalizedOutlineMetadata(request);
  return withStagedProject(config, normalized.seriesId, (store) => {
    store.saveSeries(defaultSeries(normalized.seriesId, normalized));
    const sourceFile = store.paths.sourceFile(normalized.episodeId);
    fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
    fs.writeFileSync(sourceFile, request.content, 'utf8');
    writeYaml(store.paths.sourceMetaFile(normalized.episodeId), {
      filename: request.filename,
      importedAt: new Date().toISOString(),
    });
    return {
      ok: true,
      kind: request.kind,
      seriesId: normalized.seriesId,
      episodeId: normalized.episodeId,
    };
  });
}

export function commitImport(config: AppConfig, input: unknown): ImportResult {
  const request = ImportRequestSchema.parse(input);
  const preview = previewImport(config, request);
  if (!preview.ready) {
    throw new Error(`导入预检未通过：${preview.errors.join('；')}`);
  }
  if (request.kind === 'project') return importProject(config, request);
  if (request.kind === 'script') return importScript(config, request);
  return importOutline(config, request);
}
