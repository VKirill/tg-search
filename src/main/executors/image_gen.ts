import { chatCompletion } from '../ai/llm';
import type { Settings } from '../../shared/types';
import type { Executor, ExecutorInput, ExecutorOutput } from './types';
import { generateImages } from './images';
import { estimatePrice, executorLlmOverride, formatDialog, inputImagePaths, parseCountFromBrief } from './shared';

/** Paths passed to image generation (client avatar only when consented). */
export function imageGenReferencePaths(input: ExecutorInput): string[] {
  const paths = inputImagePaths(input);
  if (input.clientPhotoPath) return [...paths, input.clientPhotoPath];
  return paths;
}

async function buildImagePrompt(getSettings: () => Settings, input: ExecutorInput, count: number): Promise<string> {
  const { service, order, history } = input;
  return chatCompletion(
    getSettings,
    [
      {
        role: 'system',
        content:
          'Сформулируй один промпт на английском для модели генерации изображений: стиль, сцена, освещение. Без цен и текста на картинке. Только промпт, без пояснений.',
      },
      {
        role: 'user',
        content:
          `Нужно ${count} вариант(ов).\nБриф:\n${order.brief}\n\nДиалог:\n${formatDialog(history)}\n\nИнструкция:\n${service.instructions}`,
      },
    ],
    { temperature: 0.4 },
    executorLlmOverride(service),
  );
}

export function createImageGenExecutor(getSettings: () => Settings): Executor {
  return {
    estimate: (input) => estimatePrice(getSettings, input),

    preview: async (input): Promise<ExecutorOutput> => {
      const prompt = await buildImagePrompt(getSettings, input, 1);
      const refs = imageGenReferencePaths(input);
      const files = await generateImages(getSettings, input.workDir, {
        prompt,
        referencePaths: refs.length ? refs : undefined,
        count: 1,
        namePrefix: 'preview',
        role: 'preview',
      });
      return { text: 'Превью — одно изображение во вложении.', files };
    },

    run: async (input): Promise<ExecutorOutput> => {
      const count = parseCountFromBrief(input.order.brief, 4);
      const prompt = await buildImagePrompt(getSettings, input, count);
      const refs = imageGenReferencePaths(input);
      const files = await generateImages(getSettings, input.workDir, {
        prompt,
        referencePaths: refs.length ? refs : undefined,
        count,
        namePrefix: 'image',
        role: 'output',
      });
      return {
        text: `Готово: ${files.length} изображени${files.length === 1 ? 'е' : 'я'} во вложениях.`,
        files,
      };
    },
  };
}
