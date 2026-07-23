import type { AppConfig } from '../config.js';
import { ComfyUiImageProvider } from './comfyui.js';
import { MiniMaxTtsProvider, MiniMaxVideoProvider } from './minimax.js';
import { StubImageProvider, StubTtsProvider, StubVideoProvider } from './stub.js';
import type { Providers } from './types.js';

export function createProviders(config: AppConfig): Providers {
  if (config.dryRun) {
    return {
      image: new StubImageProvider(config),
      video: new StubVideoProvider(config),
      tts: new StubTtsProvider(config),
    };
  }
  return {
    image: new ComfyUiImageProvider(config),
    video: new MiniMaxVideoProvider(config),
    tts: new MiniMaxTtsProvider(config),
  };
}

export type {
  GenerationResult,
  ImageProvider,
  Providers,
  ProviderStatus,
  TtsProvider,
  VideoProvider,
} from './types.js';
