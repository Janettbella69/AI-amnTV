import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../config.js';
import type { GenerationResult, ImageProvider, ImageRequest } from './types.js';

function replaceTemplate(value: unknown, variables: Record<string, unknown>): unknown {
  if (typeof value === 'string') {
    const exact = value.match(/^\$\{([A-Z0-9_]+)\}$/);
    if (exact && exact[1] && exact[1] in variables) return variables[exact[1]];
    let result = value;
    for (const [key, replacement] of Object.entries(variables)) {
      result = result.replaceAll(`\${${key}}`, String(replacement ?? ''));
    }
    return result;
  }
  if (Array.isArray(value)) return value.map((item) => replaceTemplate(item, variables));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, replaceTemplate(item, variables)]),
    );
  }
  return value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ComfyUiImageProvider implements ImageProvider {
  readonly name = 'comfyui';
  readonly model = 'workflow-configured';
  readonly promptLimit = 20_000;

  constructor(private readonly config: AppConfig) {}

  status() {
    if (!this.config.comfyUrl) return { ready: false, message: '缺少 COMFYUI_URL' };
    if (!this.config.comfyWorkflow || !fs.existsSync(this.config.comfyWorkflow)) {
      return { ready: false, message: '缺少有效的 COMFYUI_WORKFLOW JSON 文件' };
    }
    return { ready: true, message: `${this.config.comfyUrl} + workflow` };
  }

  async generate(request: ImageRequest): Promise<GenerationResult> {
    const status = this.status();
    if (!status.ready) throw new Error(status.message);
    const url = this.config.comfyUrl!;
    const rawText = fs.readFileSync(this.config.comfyWorkflow!, 'utf8');
    if (
      request.referenceImages.length > 0 &&
      !rawText.includes('${REFERENCE_IMAGE_1}') &&
      !rawText.includes('${REFERENCE_IMAGES}')
    ) {
      throw new Error(
        'ComfyUI workflow 未消费参考图；请加入 ${REFERENCE_IMAGE_1} 或 ${REFERENCE_IMAGES} 占位符',
      );
    }
    if (request.referenceImages.length > 0 && !this.config.comfyInputDir) {
      throw new Error('关键帧带参考图时必须配置 COMFYUI_INPUT_DIR');
    }
    const uploadedReferences = request.referenceImages.map((file) => {
      const digest = createHash('sha256').update(path.resolve(file)).digest('hex').slice(0, 12);
      const relative = path.join('ai-amntv', `${digest}-${path.basename(file)}`);
      const target = path.join(this.config.comfyInputDir!, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (!fs.existsSync(target)) fs.copyFileSync(file, target);
      return relative.replaceAll(path.sep, '/');
    });
    const rawWorkflow = JSON.parse(rawText) as unknown;
    const referenceVariables = Object.fromEntries(
      Array.from({ length: 8 }, (_, index) => [
        `REFERENCE_IMAGE_${index + 1}`,
        uploadedReferences[index] ?? '',
      ]),
    );
    const workflow = replaceTemplate(rawWorkflow, {
      PROMPT: request.prompt,
      NEGATIVE_PROMPT: request.negativePrompt,
      SEED: request.seed,
      WIDTH: request.width,
      HEIGHT: request.height,
      REFERENCE_IMAGES: uploadedReferences,
      ...referenceVariables,
    });
    const clientId = `ai-amntv-${process.pid}-${Date.now()}`;
    const created = await fetch(`${url}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: workflow, client_id: clientId }),
    });
    if (!created.ok) throw new Error(`ComfyUI /prompt HTTP ${created.status}: ${await created.text()}`);
    const { prompt_id: promptId } = (await created.json()) as { prompt_id?: string };
    if (!promptId) throw new Error('ComfyUI 没有返回 prompt_id');

    const started = Date.now();
    let image:
      | { filename: string; subfolder?: string; type?: string }
      | undefined;
    while (Date.now() - started < 15 * 60_000) {
      await delay(1_000);
      const response = await fetch(`${url}/history/${promptId}`);
      if (!response.ok) throw new Error(`ComfyUI /history HTTP ${response.status}`);
      const history = (await response.json()) as Record<
        string,
        {
          outputs?: Record<
            string,
            { images?: Array<{ filename: string; subfolder?: string; type?: string }> }
          >;
        }
      >;
      const outputs = history[promptId]?.outputs;
      image = Object.values(outputs ?? {})
        .flatMap((output) => output.images ?? [])
        .at(0);
      if (image) break;
    }
    if (!image) throw new Error('ComfyUI 任务轮询超时（15 分钟）');
    const view = new URL(`${url}/view`);
    view.searchParams.set('filename', image.filename);
    if (image.subfolder) view.searchParams.set('subfolder', image.subfolder);
    if (image.type) view.searchParams.set('type', image.type);
    const result = await fetch(view);
    if (!result.ok) throw new Error(`ComfyUI /view HTTP ${result.status}`);
    fs.mkdirSync(path.dirname(request.outputFile), { recursive: true });
    fs.writeFileSync(request.outputFile, Buffer.from(await result.arrayBuffer()));
    return {
      file: request.outputFile,
      provider: this.name,
      model: this.model,
      metadata: {
        promptId,
        workflow: path.basename(this.config.comfyWorkflow!),
        referenceImageCount: uploadedReferences.length,
      },
    };
  }
}
