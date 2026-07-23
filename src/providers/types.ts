import type { GenMode } from '../domain.js';

export interface ProviderStatus {
  ready: boolean;
  message: string;
}

export interface GenerationResult {
  file: string;
  provider: string;
  model: string;
  amountCny?: number;
  metadata: Record<string, unknown>;
}

export interface ImageRequest {
  prompt: string;
  negativePrompt: string;
  referenceImages: string[];
  width: number;
  height: number;
  seed: number;
  outputFile: string;
}

export interface VideoRequest {
  prompt: string;
  mode: GenMode;
  frames: string[];
  durationSec: number;
  outputFile: string;
  onSubmitted?: (providerTaskId: string) => void;
}

export interface TtsRequest {
  text: string;
  voiceId: string;
  emotion: string;
  params: Record<string, unknown>;
  outputFile: string;
}

export interface ImageProvider {
  readonly name: string;
  readonly model: string;
  readonly promptLimit: number;
  status(): ProviderStatus;
  generate(request: ImageRequest): Promise<GenerationResult>;
}

export interface VideoProvider {
  readonly name: string;
  readonly model: string;
  readonly promptLimit: number;
  status(): ProviderStatus;
  supports(mode: GenMode): boolean;
  generate(request: VideoRequest): Promise<GenerationResult>;
}

export interface TtsProvider {
  readonly name: string;
  readonly model: string;
  status(): ProviderStatus;
  synthesize(request: TtsRequest): Promise<GenerationResult>;
}

export interface Providers {
  image: ImageProvider;
  video: VideoProvider;
  tts: TtsProvider;
}
