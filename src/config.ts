import fs from 'node:fs';
import path from 'node:path';

export interface AppConfig {
  projectsRoot: string;
  dryRun: boolean;
  noOpen: boolean;
  ffmpeg: string;
  ffprobe: string;
  anthropicApiKey?: string;
  minimaxApiKey?: string;
  minimaxApiBase: string;
  minimaxTtsModel: string;
  minimaxVideoModel: string;
  comfyUrl?: string;
  comfyWorkflow?: string;
  comfyInputDir?: string;
  frameUrlManifest?: string;
}

function bool(value: string | undefined, fallback = false): boolean {
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Minimal .env reader. Existing environment variables always win. */
export function loadDotEnv(cwd = process.cwd()): void {
  const file = path.join(cwd, '.env');
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function getConfig(cwd = process.cwd()): AppConfig {
  loadDotEnv(cwd);
  const config: AppConfig = {
    projectsRoot: path.resolve(cwd, process.env.AMNTV_PROJECTS ?? 'projects'),
    dryRun: bool(process.env.AMNTV_DRY_RUN),
    noOpen: bool(process.env.AMNTV_NO_OPEN),
    ffmpeg: process.env.FFMPEG_PATH ?? 'ffmpeg',
    ffprobe: process.env.FFPROBE_PATH ?? 'ffprobe',
    minimaxApiBase: process.env.MINIMAX_API_BASE ?? 'https://api.minimaxi.com',
    minimaxTtsModel: process.env.MINIMAX_TTS_MODEL ?? 'speech-2.8-hd',
    minimaxVideoModel: process.env.MINIMAX_VIDEO_MODEL ?? 'MiniMax-Hailuo-2.3',
  };
  const anthropicApiKey = optional(process.env.ANTHROPIC_API_KEY);
  const minimaxApiKey = optional(process.env.MINIMAX_API_KEY);
  const comfyUrl = optional(process.env.COMFYUI_URL);
  const comfyWorkflow = optional(process.env.COMFYUI_WORKFLOW);
  const comfyInputDir = optional(process.env.COMFYUI_INPUT_DIR);
  const frameUrlManifest = optional(process.env.AMNTV_FRAME_URL_MANIFEST);
  if (anthropicApiKey) config.anthropicApiKey = anthropicApiKey;
  if (minimaxApiKey) config.minimaxApiKey = minimaxApiKey;
  if (comfyUrl) config.comfyUrl = comfyUrl;
  if (comfyWorkflow) config.comfyWorkflow = path.resolve(cwd, comfyWorkflow);
  if (comfyInputDir) config.comfyInputDir = path.resolve(cwd, comfyInputDir);
  if (frameUrlManifest) config.frameUrlManifest = path.resolve(cwd, frameUrlManifest);
  return config;
}
