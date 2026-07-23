import { query } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { Script } from '../domain.js';
import * as P from './prompts.js';
import {
  BreakdownSchema,
  FailurePlanSchema,
  SakkanSchema,
  ScriptAgentOutputSchema,
  ScriptReviewSchema,
  StoryboardAgentOutputSchema,
} from './schemas.js';

async function runStructured<S extends z.ZodType>(
  config: AppConfig,
  systemPrompt: string,
  userPrompt: string,
  schema: S,
  allowedTools: string[] = [],
): Promise<z.infer<S>> {
  if (!config.anthropicApiKey && !process.env.ANTHROPIC_API_KEY) {
    throw new Error('Agent 节点未配置：缺少 ANTHROPIC_API_KEY');
  }
  const stream = query({
    prompt: userPrompt,
    options: {
      systemPrompt,
      allowedTools,
      maxTurns: 8,
      permissionMode: 'default',
      outputFormat: {
        type: 'json_schema',
        schema: z.toJSONSchema(schema) as Record<string, unknown>,
      },
    },
  });
  for await (const message of stream) {
    if (message.type !== 'result') continue;
    if (message.subtype !== 'success' || !('structured_output' in message)) {
      throw new Error(`Agent 运行失败: ${message.subtype}`);
    }
    return schema.parse(
      (message as unknown as { structured_output: unknown }).structured_output,
    );
  }
  throw new Error('Agent 会话结束但没有结构化结果');
}

export function writeScript(
  config: AppConfig,
  context: string,
  revisionRequest?: string,
) {
  const revision = revisionRequest ? `\n\n必须落实以下修订意见：\n${revisionRequest}` : '';
  return runStructured(
    config,
    P.SCRIPT_WRITER,
    `${context}${revision}`,
    ScriptAgentOutputSchema,
  );
}

export function reviewScript(config: AppConfig, script: unknown) {
  return runStructured(
    config,
    P.FEMDRAMA_REVIEWER,
    JSON.stringify(script, null, 2),
    ScriptReviewSchema,
  );
}

export function tagBreakdown(config: AppConfig, script: Script) {
  return runStructured(
    config,
    P.BREAKDOWN_TAGGER,
    JSON.stringify(script, null, 2),
    BreakdownSchema,
  );
}

export function drawStoryboard(config: AppConfig, context: unknown) {
  return runStructured(
    config,
    P.STORYBOARD_ARTIST,
    JSON.stringify(context, null, 2),
    StoryboardAgentOutputSchema,
  );
}

export function diagnoseFailure(config: AppConfig, context: unknown) {
  return runStructured(
    config,
    P.FAILURE_DOCTOR,
    JSON.stringify(context, null, 2),
    FailurePlanSchema,
  );
}

export function checkSakkan(config: AppConfig, context: unknown) {
  return runStructured(
    config,
    P.SAKKAN,
    JSON.stringify(context, null, 2),
    SakkanSchema,
    ['Read'],
  );
}

export type {
  FailurePlan,
  SakkanResult,
  ScriptAgentOutput,
  ScriptReview,
} from './schemas.js';
