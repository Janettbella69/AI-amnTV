export type GateName = 'script' | 'cast' | 'storyboard' | 'visual' | 'final';
export type JobType =
  | 'script'
  | 'cast'
  | 'storyboard'
  | 'audio'
  | 'keyframes'
  | 'video'
  | 'compose';

export interface SeriesSummary {
  id: string;
  title: string;
  genre: string;
  logline: string;
  episodeIds: string[];
  sourceDrafts: Array<{
    episodeId: string;
    filename: string;
    content: string;
  }>;
}

export type ImportKind = 'project' | 'script' | 'outline';

export interface ImportMetadata {
  seriesId: string;
  title: string;
  genre: string;
  logline: string;
  episodeId: string;
}

export type ImportRequest =
  | {
      kind: 'project';
      sourcePath: string;
      targetSeriesId: string;
    }
  | {
      kind: 'script' | 'outline';
      filename: string;
      content: string;
      metadata: ImportMetadata;
    };

export interface ImportPreview {
  kind: ImportKind;
  ready: boolean;
  errors: string[];
  warnings: string[];
  conflict: boolean;
  normalized: ImportMetadata;
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
  kind: ImportKind;
  seriesId: string;
  episodeId?: string;
  alreadyAvailable?: boolean;
}

export interface Dialogue {
  id: string;
  kind: 'dialogue' | 'narration' | 'sfx' | 'ambient';
  speakerId?: string | undefined;
  text: string;
  emotion: string;
  audio?: {
    file: string;
    durationSec: number;
    contentHash: string;
    provider: string;
  };
}

export interface Scene {
  id: string;
  status: 'active' | 'omitted';
  revision: number;
  intExt: 'INT' | 'EXT';
  dayNight: 'DAY' | 'NIGHT' | 'EVENING';
  locationId: string;
  synopsis: string;
  emotionBeat: string;
  dialogue: Dialogue[];
}

export interface ScriptDocument {
  episodeId: string;
  title: string;
  emotionContract: { promise: string; payoff: string };
  scenes: Scene[];
  manifests: Array<Record<string, unknown>>;
  status: 'draft' | 'locked';
  lockedAt?: string;
}

export interface CutState {
  stage: string;
  updatedAt: string;
  selectedKeyframes: string[];
  selectedVideo?: string;
  retakeCount: number;
  staleReasons: string[];
}

export interface Candidate {
  index: number;
  file: string;
  url?: string;
}

export interface Cut {
  id: string;
  sceneId: string;
  durationSec: number;
  shotSize: 'ECU' | 'CU' | 'MS' | 'WS' | 'EWS';
  camera: {
    move: 'STATIC' | 'PAN' | 'ZOOM_IN' | 'ZOOM_OUT' | 'SHAKE';
    note?: string;
  };
  action: string;
  dialogueIds: string[];
  characters: Array<{
    characterId: string;
    outfitId: string;
    expression: string;
  }>;
  soundEffects: string[];
  transition: 'CUT' | 'DISSOLVE' | 'FADE';
  genMode: 'first_frame' | 'first_last' | 'multi_frame' | 'still_pan';
  importance: 'normal' | 'key';
  promptDelta: string;
  tailLink: boolean;
  state?: CutState;
  candidates: Record<string, Candidate[]>;
  selectedKeyframeUrls: string[];
  clipUrls: string[];
  selectedVideoUrl?: string;
}

export interface StoryboardDocument {
  episodeId: string;
  cuts: Cut[];
  status: 'draft' | 'approved';
  approvedAt?: string;
}

export interface CharacterAsset {
  id: string;
  name: string;
  age: string;
  personality: string;
  relationships: Record<string, string>;
  turnaround: string[];
  expressions: Record<string, string>;
  outfits: Record<string, { label: string; referenceImage: string }>;
  palette: {
    normal: string[];
    night: string[];
    evening: string[];
  };
  voice: {
    provider: 'minimax' | 'cosyvoice' | 'stub';
    voiceId: string;
    params: Record<string, unknown>;
  };
  status: 'draft' | 'candidates_ready' | 'locked';
  lockedAt?: string;
  previewUrl?: string;
  turnaroundUrls: string[];
  candidateUrls: string[];
  voiceSampleUrl?: string;
}

export interface LocationAsset {
  id: string;
  name: string;
  referenceImages: string[];
  variants: Record<string, string>;
  status: 'draft' | 'candidates_ready' | 'locked';
  lockedAt?: string;
  previewUrl?: string;
  referenceUrls: string[];
  candidateUrls: string[];
}

export interface CostEntry {
  at: string;
  kind: 'image' | 'video' | 'tts';
  provider: string;
  cutId?: string;
  amountCny?: number;
  unit: string;
  quantity: number;
}

export interface Workspace {
  series: Omit<SeriesSummary, 'episodeIds' | 'sourceDrafts'> & {
    spec: {
      width: 1080;
      height: 1920;
      fps: number;
      episodeDurationSec: [60, 120];
      targetCuts: [number, number];
    };
  };
  episodeIds: string[];
  episodeId: string;
  script: ScriptDocument;
  storyboard: StoryboardDocument;
  state: {
    episodeId: string;
    gates: Partial<
      Record<GateName, { at: string; by: 'human'; note?: string }>
    >;
    cuts: Record<string, CutState>;
    tasks: Array<Record<string, unknown>>;
    costLedger: CostEntry[];
    delivery?: {
      finalVideo: string;
      subtitles: string;
      cover: string;
      aigcLabel: 'burned';
      jianyingDraft: string;
      durationSec: number;
      qcPassedAt: string;
      finalVideoUrl?: string;
      subtitlesUrl?: string;
      coverUrl?: string;
    };
  };
  assets: {
    characters: CharacterAsset[];
    locations: LocationAsset[];
  };
  costs: {
    knownTotalCny: number;
    unknownEntries: number;
    imageDrawsPerCut: number;
    byProvider: Array<{
      provider: string;
      calls: number;
      knownAmountCny: number;
      unknown: number;
    }>;
    ledger: CostEntry[];
  };
  providers: Record<
    'image' | 'video' | 'tts',
    { name: string; ready: boolean; message: string }
  >;
}

export interface StudioJob {
  id: string;
  seriesId: string;
  episodeId: string;
  type: JobType;
  payload: Record<string, unknown>;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  progress: number;
  message: string;
  error?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  updatedAt: string;
}

export interface LibTvStatus {
  ready: boolean;
  mode: 'dry-run' | 'live';
  message: string;
}

export interface LibTvSession {
  id: string;
  seriesId: string;
  episodeId: string;
  status: 'submitting' | 'running' | 'ready' | 'failed' | 'orphaned';
  instruction: string;
  references: Array<{
    sourceFile: string;
    name: string;
    bytes: number;
    mimeType: string;
    remoteUrl?: string;
  }>;
  turns: Array<{
    id: string;
    status: 'submitting' | 'sent' | 'failed' | 'orphaned';
    instruction: string;
    references: Array<{
      sourceFile: string;
      name: string;
      bytes: number;
      mimeType: string;
      remoteUrl?: string;
    }>;
    createdAt: string;
    updatedAt: string;
    error?: string;
  }>;
  messages: Array<{
    id: string;
    seq?: number;
    role: string;
    content: string;
  }>;
  resultSources: string[];
  results: Array<{
    sourceUrl?: string;
    file: string;
    mimeType: string;
    bytes: number;
    url?: string;
  }>;
  projectUuid?: string;
  remoteSessionId?: string;
  maxSeq: number;
  createdAt: string;
  updatedAt: string;
  error?: string;
  projectUrl?: string;
}

export interface LibTvSessionsResponse {
  status: LibTvStatus;
  sessions: LibTvSession[];
}

export interface WorkflowStage {
  id: string;
  code: string;
  label: string;
  detail: string;
  status: 'complete' | 'active' | 'ready' | 'blocked' | 'optional';
  progress: number;
  blockers: string[];
  optional: boolean;
  action: {
    kind: 'open' | 'job';
    label: string;
    tab: StudioTab;
    jobType?: JobType;
  };
}

export interface WorkflowView {
  seriesId: string;
  episodeId: string;
  overallProgress: number;
  completedRequired: number;
  totalRequired: number;
  nextStageId?: string;
  stages: WorkflowStage[];
}

export type EvaluationScope = 'story' | 'dailies' | 'final';
export type EvaluationDimensionId =
  | 'narrative'
  | 'character'
  | 'storyboard'
  | 'visual'
  | 'audio'
  | 'continuity'
  | 'platform'
  | 'delivery';

export interface EvaluationCheck {
  id: string;
  label: string;
  status: 'pass' | 'warn' | 'fail';
  score: number;
  maxScore: number;
  evidence: string;
  evidenceKind: 'direct' | 'proxy' | 'missing';
}

export interface EvaluationDimension {
  id: EvaluationDimensionId;
  label: string;
  weight: number;
  score: number;
  automaticScore: number;
  manualScore?: number;
  manualNote?: string;
  source: 'automatic' | 'hybrid';
  confidence: number;
  summary: string;
  checks: EvaluationCheck[];
}

export interface EvaluationReport {
  id: string;
  version: 1;
  seriesId: string;
  episodeId: string;
  scope: EvaluationScope;
  title: string;
  inputHash: string;
  overallScore: number;
  evidenceCoverage: number;
  humanCoverage: number;
  verdict: 'pass' | 'revise' | 'needs_human_review';
  dimensions: EvaluationDimension[];
  createdAt: string;
  stale: boolean;
}

export type BenchmarkCriterion =
  | 'identity'
  | 'composition'
  | 'cameraLanguage'
  | 'motion'
  | 'artifacts'
  | 'voicePerformance';

export interface BenchmarkCandidate {
  id: string;
  source: 'libtv' | 'pipeline';
  kind: 'image' | 'video';
  label: string;
  file: string;
  url?: string;
  provider: string;
  model?: string;
  costCny?: number;
  costKnown: boolean;
}

export interface BenchmarkReport {
  id: string;
  version: 1;
  seriesId: string;
  episodeId: string;
  title: string;
  rubric: 'amnTV-perceptual-v1';
  items: Array<{
    candidate: BenchmarkCandidate;
    criteria: Partial<Record<BenchmarkCriterion, number>>;
    score: number;
    rank: number;
    note: string;
    technical: {
      bytes: number;
      width: number;
      height: number;
      durationSec?: number;
      fps?: number;
      hasAudio?: boolean;
    };
  }>;
  createdAt: string;
}

export type StudioTab =
  | 'import'
  | 'overview'
  | 'workflow'
  | 'script'
  | 'storyboard'
  | 'canvas'
  | 'keyframes'
  | 'assets'
  | 'evaluation'
  | 'tasks'
  | 'costs'
  | 'delivery';
