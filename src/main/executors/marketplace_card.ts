import { chatCompletion, parseJsonFromLlm } from '../ai/llm';
import type { Settings } from '../../shared/types';
import type { Executor, ExecutorInput, ExecutorOutput } from './types';
import { generateImages } from './images';
import {
  estimatePrice,
  executorLlmOverride,
  formatDialog,
  inputImagePaths,
  packageTextOutput,
} from './shared';

const WB_IMAGE_RULES =
  'На инфографике Wildberries запрещены: цены, скидки, QR-коды, телефоны, призывы купить/заказать. Только товар и преимущества.';

type CardContent = {
  title: string;
  description: string;
  characteristics: string[];
  keywords: string[];
  slideCount: number;
  slidePrompts: string[];
};

async function generateCardContent(getSettings: () => Settings, input: ExecutorInput): Promise<CardContent> {
  const { service, order, history } = input;
  const raw = await chatCompletion(
    getSettings,
    [
      {
        role: 'system',
        content:
          'Ты SEO-копирайтер карточек маркетплейсов. Ответ — только JSON с полями: title (≤60 символов для WB), description, characteristics (массив строк), keywords (массив), slideCount (1–3), slidePrompts (массив промптов для инфографики на английском для image-модели). ' +
          WB_IMAGE_RULES,
      },
      {
        role: 'user',
        content: `Инструкция услуги:\n${service.instructions}\n\nБриф:\n${order.brief}\n\nДиалог:\n${formatDialog(history)}`,
      },
    ],
    { jsonObject: true },
    executorLlmOverride(service),
  );
  const obj = parseJsonFromLlm(raw) as Partial<CardContent>;
  const slideCount = Math.min(3, Math.max(1, Number(obj.slideCount) || 2));
  const slidePrompts = Array.isArray(obj.slidePrompts) ? obj.slidePrompts.map(String) : [];
  while (slidePrompts.length < slideCount) {
    slidePrompts.push(`Clean marketplace infographic slide for the product, no text overlays with prices. ${WB_IMAGE_RULES}`);
  }
  return {
    title: String(obj.title ?? 'Товар').slice(0, 60),
    description: String(obj.description ?? ''),
    characteristics: Array.isArray(obj.characteristics) ? obj.characteristics.map(String) : [],
    keywords: Array.isArray(obj.keywords) ? obj.keywords.map(String) : [],
    slideCount,
    slidePrompts: slidePrompts.slice(0, slideCount),
  };
}

function formatCardText(c: CardContent): string {
  const chars = c.characteristics.map((x) => `• ${x}`).join('\n');
  const kw = c.keywords.join(', ');
  return `**${c.title}**\n\n${c.description}\n\n**Характеристики:**\n${chars}\n\n**Ключевые слова:** ${kw}`;
}

export function createMarketplaceCardExecutor(getSettings: () => Settings): Executor {
  return {
    estimate: (input) => estimatePrice(getSettings, input),

    preview: async (input): Promise<ExecutorOutput> => {
      const content = await generateCardContent(getSettings, input);
      const photos = inputImagePaths(input);
      const files: ExecutorOutput['files'] = [];
      let text = `**${content.title}**\n\n${content.description.split('\n\n')[0] ?? content.description}`;

      if (photos.length && content.slidePrompts[0]) {
        const imgs = await generateImages(getSettings, input.workDir, {
          prompt: `${content.slidePrompts[0]}. ${WB_IMAGE_RULES}`,
          referencePaths: [photos[0]],
          count: 1,
          namePrefix: 'preview-slide',
          role: 'preview',
        });
        files.push(...imgs);
        text += '\n\nПревью — один слайд инфографики во вложении.';
      }

      const packed = await packageTextOutput(input.workDir, text, 'preview', 'preview-card');
      return { text: packed.text, files: [...packed.files, ...files] };
    },

    run: async (input): Promise<ExecutorOutput> => {
      const content = await generateCardContent(getSettings, input);
      const photos = inputImagePaths(input);
      const text = formatCardText(content);
      const packed = await packageTextOutput(input.workDir, text, 'output', 'marketplace-card');

      const files = [...packed.files];
      if (photos.length) {
        for (let i = 0; i < content.slidePrompts.length; i++) {
          const imgs = await generateImages(getSettings, input.workDir, {
            prompt: `${content.slidePrompts[i]}. ${WB_IMAGE_RULES}`,
            referencePaths: [photos[0]],
            count: 1,
            namePrefix: `slide-${i + 1}`,
            role: 'output',
          });
          files.push(...imgs);
        }
      }

      return {
        text: `${text}\n\n${files.some((f) => f.mime.startsWith('image/')) ? 'Инфографика во вложениях.' : ''}`.trim(),
        files,
      };
    },
  };
}
