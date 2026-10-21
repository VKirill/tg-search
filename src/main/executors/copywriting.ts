import { chatCompletion } from '../ai/llm';
import type { Settings } from '../../shared/types';
import type { Executor, ExecutorInput, ExecutorOutput } from './types';
import { generateImages } from './images';
import {
  briefWantsCovers,
  briefWantsContentPlan,
  estimatePrice,
  executorLlmOverride,
  formatDialog,
  packageTextOutput,
} from './shared';

async function writeCopy(
  getSettings: () => Settings,
  input: ExecutorInput,
  mode: 'full' | 'preview',
): Promise<string> {
  const { service, order, history } = input;
  const plan = briefWantsContentPlan(order.brief) || /instagram|соцсет|smm/i.test(order.brief);
  const previewDays = mode === 'preview' ? '2–3 дня' : plan ? '7 дней (неделя)' : 'по брифу';

  return chatCompletion(
    getSettings,
    [
      {
        role: 'system',
        content:
          'Ты копирайтер. В начале текста кратко перечисли допущения о нише и аудитории (если клиент не дал бриф). ' +
          (plan
            ? `Сделай контент-план на ${previewDays}: для каждого дня — тема, формат, хук, короткий черновик поста, CTA.`
            : 'Напиши тексты по брифу.') +
          ' Язык — русский, живой стиль для Telegram/Instagram.',
      },
      {
        role: 'user',
        content: `Инструкция:\n${service.instructions}\n\nБриф:\n${order.brief}\n\nДиалог:\n${formatDialog(history)}`,
      },
    ],
    { temperature: 0.5 },
    executorLlmOverride(service),
  );
}

export function createCopywritingExecutor(getSettings: () => Settings): Executor {
  return {
    estimate: (input) => estimatePrice(getSettings, input),

    preview: async (input): Promise<ExecutorOutput> => {
      const text = await writeCopy(getSettings, input, 'preview');
      const packed = await packageTextOutput(input.workDir, text, 'preview', 'preview-copy');
      const files = [...packed.files];

      const canCover = input.clientPhotoPath != null || briefWantsCovers(input.order.brief);
      if (canCover) {
        const refs = input.clientPhotoPath ? [input.clientPhotoPath] : undefined;
        const prompt = input.clientPhotoPath
          ? 'Social media post cover, warm coffee shop aesthetic, Kazan vibe, no price text'
          : 'Minimal abstract social media cover for a coffee shop, warm tones, no text';
        const imgs = await generateImages(getSettings, input.workDir, {
          prompt,
          referencePaths: refs,
          count: 1,
          namePrefix: 'preview-cover',
          role: 'preview',
        });
        files.push(...imgs);
      }

      return { text: packed.text, files };
    },

    run: async (input): Promise<ExecutorOutput> => {
      const text = await writeCopy(getSettings, input, 'full');
      const packed = await packageTextOutput(input.workDir, text, 'output', 'copywriting');
      const files = [...packed.files];

      if (briefWantsCovers(input.order.brief)) {
        const refs: string[] = [];
        if (input.clientPhotoPath) refs.push(input.clientPhotoPath);
        const coverCount = refs.length ? 2 : 3;
        for (let i = 0; i < coverCount; i++) {
          const imgs = await generateImages(getSettings, input.workDir, {
            prompt: `Social media post cover variant ${i + 1}, on-brand, no price or CTA text on image`,
            referencePaths: refs.length ? refs : undefined,
            count: 1,
            namePrefix: `cover-${i + 1}`,
            role: 'output',
          });
          files.push(...imgs);
        }
      }

      return { text: packed.text, files };
    },
  };
}
