import { z } from 'zod';

const iso = z.string().datetime();
const safeId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const sceneId = z.string().regex(/^S\d{2,}[A-Z]?$/);
const characterId = z.string().regex(/^CH-\d{2,}[A-Z]?$/);
const locationId = z.string().regex(/^LOC-\d{2,}[A-Z]?$/);
const cutId = z.string().regex(/^EP\d{2,}_S\d{2,}[A-Z]?_C\d{3,}[A-Z]?$/);

export const SeriesSchema = z.object({
  id: safeId,
  title: z.string().min(1),
  genre: z.string().min(1),
  logline: z.string().min(1),
  spec: z.object({
    width: z.literal(1080),
    height: z.literal(1920),
    fps: z.number().int().min(20).max(60),
    episodeDurationSec: z.tuple([z.literal(60), z.literal(120)]),
    targetCuts: z.tuple([z.number().int().min(15), z.number().int().max(25)]),
  }),
  style: z.object({
    prompt: z.string().min(1),
    negativePrompt: z.string(),
    referenceImages: z.array(z.string()),
    imageModel: z.string().min(1),
  }),
});
export type Series = z.infer<typeof SeriesSchema>;

export const CharacterSchema = z.object({
  id: characterId,
  name: z.string().min(1),
  age: z.string(),
  personality: z.string().min(1),
  relationships: z.record(z.string(), z.string()),
  turnaround: z.array(z.string()),
  expressions: z.record(z.string(), z.string()),
  outfits: z.record(
    z.string(),
    z.object({ label: z.string(), referenceImage: z.string() }),
  ),
  palette: z.object({
    normal: z.array(z.string()),
    night: z.array(z.string()),
    evening: z.array(z.string()),
  }),
  voice: z.object({
    provider: z.enum(['minimax', 'cosyvoice', 'stub']),
    voiceId: z.string().min(1),
    params: z.record(z.string(), z.unknown()),
  }),
  status: z.enum(['draft', 'candidates_ready', 'locked']),
  lockedAt: iso.optional(),
});
export type Character = z.infer<typeof CharacterSchema>;

export const LocationSchema = z.object({
  id: locationId,
  name: z.string().min(1),
  referenceImages: z.array(z.string()),
  variants: z.record(z.string(), z.string()),
  status: z.enum(['draft', 'candidates_ready', 'locked']),
  lockedAt: iso.optional(),
});
export type Location = z.infer<typeof LocationSchema>;

export const DialogueSchema = z.object({
  id: z.string().regex(/^D\d{3,}$/),
  kind: z.enum(['dialogue', 'narration', 'sfx', 'ambient']),
  speakerId: characterId.optional(),
  text: z.string().min(1),
  emotion: z.string(),
  audio: z
    .object({
      file: z.string(),
      durationSec: z.number().positive(),
      contentHash: z.string(),
      provider: z.string(),
    })
    .optional(),
});
export type Dialogue = z.infer<typeof DialogueSchema>;

export const SceneSchema = z.object({
  id: sceneId,
  status: z.enum(['active', 'omitted']),
  revision: z.number().int().positive(),
  intExt: z.enum(['INT', 'EXT']),
  dayNight: z.enum(['DAY', 'NIGHT', 'EVENING']),
  locationId,
  synopsis: z.string(),
  emotionBeat: z.string(),
  dialogue: z.array(DialogueSchema),
});
export type Scene = z.infer<typeof SceneSchema>;

export const ScriptSchema = z.object({
  episodeId: z.string().regex(/^EP\d{2,}$/),
  title: z.string().min(1),
  emotionContract: z.object({ promise: z.string(), payoff: z.string() }),
  scenes: z.array(SceneSchema).min(1),
  manifests: z.array(
    z.object({
      sceneId,
      characters: z.array(characterId),
      locations: z.array(locationId),
      props: z.array(z.string()),
      wardrobe: z.array(z.object({ characterId, outfitId: z.string() })),
      vfxNotes: z.array(z.string()),
    }),
  ),
  status: z.enum(['draft', 'locked']),
  lockedAt: iso.optional(),
});
export type Script = z.infer<typeof ScriptSchema>;

export const GenModeSchema = z.enum([
  'first_frame',
  'first_last',
  'multi_frame',
  'still_pan',
]);
export type GenMode = z.infer<typeof GenModeSchema>;

export const CutSchema = z.object({
  id: cutId,
  sceneId,
  durationSec: z.number().min(1).max(12),
  shotSize: z.enum(['ECU', 'CU', 'MS', 'WS', 'EWS']),
  camera: z.object({
    move: z.enum(['STATIC', 'PAN', 'ZOOM_IN', 'ZOOM_OUT', 'SHAKE']),
    note: z.string().optional(),
  }),
  action: z.string().min(1),
  dialogueIds: z.array(z.string().regex(/^D\d{3,}$/)),
  characters: z.array(
    z.object({
      characterId,
      outfitId: z.string(),
      expression: z.string(),
    }),
  ),
  soundEffects: z.array(z.string()),
  transition: z.enum(['CUT', 'DISSOLVE', 'FADE']),
  genMode: GenModeSchema,
  importance: z.enum(['normal', 'key']),
  promptDelta: z.string(),
  tailLink: z.boolean().default(false),
});
export type Cut = z.infer<typeof CutSchema>;

export const StoryboardSchema = z.object({
  episodeId: z.string().regex(/^EP\d{2,}$/),
  cuts: z.array(CutSchema).min(1),
  status: z.enum(['draft', 'approved']),
  approvedAt: iso.optional(),
});
export type Storyboard = z.infer<typeof StoryboardSchema>;

export const CutStageSchema = z.enum([
  'pending',
  'audio_ready',
  'keyframes_ready',
  'keyframe_selected',
  'video_generating',
  'video_ready',
  'sakkan_pass',
  'composited',
  'failed',
]);
export type CutStage = z.infer<typeof CutStageSchema>;

export const ApprovalSchema = z.object({
  at: iso,
  by: z.literal('human'),
  note: z.string().optional(),
});

export const EpisodeStateSchema = z.object({
  episodeId: z.string().regex(/^EP\d{2,}$/),
  gates: z.object({
    script: ApprovalSchema.optional(),
    cast: ApprovalSchema.optional(),
    storyboard: ApprovalSchema.optional(),
    visual: ApprovalSchema.optional(),
    final: ApprovalSchema.optional(),
  }),
  cuts: z.record(
    z.string(),
    z.object({
      stage: CutStageSchema,
      updatedAt: iso,
      selectedKeyframes: z.array(z.string()).default([]),
      selectedVideo: z.string().optional(),
      retakeCount: z.number().int().nonnegative().default(0),
      staleReasons: z.array(z.string()).default([]),
    }),
  ),
  tasks: z.array(
    z.object({
      id: z.string(),
      cutId,
      provider: z.string(),
      kind: z.enum(['image', 'video', 'tts']),
      status: z.enum(['submitted', 'polling', 'success', 'failed', 'orphaned']),
      providerTaskId: z.string().optional(),
      submittedAt: iso,
      updatedAt: iso,
      error: z.string().optional(),
    }),
  ),
  costLedger: z.array(
    z.object({
      at: iso,
      kind: z.enum(['image', 'video', 'tts']),
      provider: z.string(),
      cutId: cutId.optional(),
      amountCny: z.number().nonnegative().optional(),
      unit: z.string(),
      quantity: z.number().nonnegative(),
    }),
  ),
  delivery: z
    .object({
      finalVideo: z.string(),
      subtitles: z.string(),
      cover: z.string(),
      aigcLabel: z.literal('burned'),
      jianyingDraft: z.string(),
      durationSec: z.number().positive(),
      qcPassedAt: iso,
    })
    .optional(),
});
export type EpisodeState = z.infer<typeof EpisodeStateSchema>;

export const GenerationMetaSchema = z.object({
  takeId: z.string(),
  cutId,
  kind: z.enum(['keyframe', 'video']),
  provider: z.string(),
  model: z.string(),
  seed: z.number().int().optional(),
  prompt: z.string(),
  promptHash: z.string(),
  referenceImages: z.array(z.string()),
  outputFile: z.string(),
  amountCny: z.number().nonnegative().optional(),
  createdAt: iso,
});
export type GenerationMeta = z.infer<typeof GenerationMetaSchema>;

export interface ReadinessCheck {
  key: string;
  ok: boolean;
  message: string;
}
