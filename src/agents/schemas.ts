import { z } from 'zod';
import { CutSchema, SceneSchema } from '../domain.js';

export const ScriptAgentOutputSchema = z.object({
  title: z.string(),
  emotionContract: z.object({ promise: z.string(), payoff: z.string() }),
  scenes: z.array(SceneSchema.omit({ revision: true })).min(1),
  newCharacters: z.array(
    z.object({
      id: z.string().regex(/^CH-\d{2,}[A-Z]?$/),
      name: z.string(),
      age: z.string(),
      personality: z.string(),
    }),
  ),
  newLocations: z.array(
    z.object({
      id: z.string().regex(/^LOC-\d{2,}[A-Z]?$/),
      name: z.string(),
      brief: z.string(),
    }),
  ),
});
export type ScriptAgentOutput = z.infer<typeof ScriptAgentOutputSchema>;

export const ScriptReviewSchema = z.object({
  emotionContractOk: z.boolean(),
  heroineAgencyOk: z.boolean(),
  pacingOk: z.boolean(),
  issues: z.array(
    z.object({
      severity: z.enum(['A', 'B', 'C']),
      sceneId: z.string(),
      problem: z.string(),
      fix: z.string(),
    }),
  ),
  verdict: z.enum(['pass', 'revise']),
});
export type ScriptReview = z.infer<typeof ScriptReviewSchema>;

export const BreakdownSchema = z.object({
  manifests: z.array(
    z.object({
      sceneId: z.string().regex(/^S\d{2,}[A-Z]?$/),
      characters: z.array(z.string().regex(/^CH-\d{2,}[A-Z]?$/)),
      locations: z.array(z.string().regex(/^LOC-\d{2,}[A-Z]?$/)),
      props: z.array(z.string()),
      wardrobe: z.array(
        z.object({
          characterId: z.string().regex(/^CH-\d{2,}[A-Z]?$/),
          outfitId: z.string(),
        }),
      ),
      vfxNotes: z.array(z.string()),
    }),
  ),
});

export const StoryboardAgentOutputSchema = z.object({
  cuts: z.array(CutSchema).min(15).max(25),
});

export const FailurePlanSchema = z.object({
  category: z.enum(['network', 'moderation', 'quality', 'quota', 'unknown']),
  action: z.enum([
    'retry',
    'rewrite_prompt',
    'reseed',
    'simplify',
    'still_pan',
    'split_cut',
    'human',
  ]),
  reason: z.string(),
  rewrittenPrompt: z.string().optional(),
});
export type FailurePlan = z.infer<typeof FailurePlanSchema>;

export const SakkanSchema = z.object({
  identityScore: z.number().min(0).max(1),
  pass: z.boolean(),
  problems: z.array(z.string()),
  stageToRedo: z.enum(['keyframe', 'video', 'composite']).optional(),
  instruction: z.string().optional(),
});
export type SakkanResult = z.infer<typeof SakkanSchema>;
