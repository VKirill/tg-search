import { parseJsonFromLlm } from '../ai/llm';
import type { Settings } from '../../shared/types';
import type { Executor, ExecutorInput, ExecutorOutput } from './types';
import { fileToDataUri } from './images';
import {
  estimatePrice,
  packageTextOutput,
  requireInputPhotos,
  visionChat,
  type VisionContentPart,
} from './shared';

function visionParts(text: string, dataUris: string[]): VisionContentPart[] {
  const parts: VisionContentPart[] = [{ type: 'text', text }];
  for (const url of dataUris) parts.push({ type: 'image_url', image_url: { url } });
  return parts;
}

async function solveHomework(
  getSettings: () => Settings,
  input: ExecutorInput,
  imageDataUris: string[],
  pass: 'solve' | 'resolve',
): Promise<string> {
  const { service, order } = input;
  const langHint = order.brief.match(/english|англ/i) ? 'английском' : 'языке клиента (обычно русский)';
  const intro =
    pass === 'solve'
      ? `Реши задание по фото пошагово на ${langHint}. Формулы — в обычном тексте для Telegram: степени как x², корни как √, дроби как a/b. В конце отдельной строкой «Ответ: …».`
      : `Ещё раз внимательно реши задание по фото на ${langHint} (независимая попытка). Те же правила оформления. В конце «Ответ: …».`;
  return visionChat(
    getSettings,
    [
      {
        role: 'user',
        content: visionParts(`${intro}\n\nКонтекст:\n${order.brief}`, imageDataUris),
      },
    ],
    service,
    'smart', // math and logic: the strongest model that sees the photo, thinking harder
  );
}

async function verifyHomework(
  getSettings: () => Settings,
  input: ExecutorInput,
  imageDataUris: string[],
  solutionA: string,
  solutionB: string,
): Promise<{ agree: boolean; summary: string }> {
  const { service, order } = input;
  const raw = await visionChat(
    getSettings,
    [
      {
        role: 'user',
        content: visionParts(
          `Ты проверяющий. По фото задания сравни два решения и их финальные ответы. ` +
            `Ответь только JSON: {"agree": true|false, "summary": "кратко на русском"}\n\n` +
            `Бриф: ${order.brief}\n\nРешение 1:\n${solutionA}\n\nРешение 2:\n${solutionB}`,
          imageDataUris,
        ),
      },
    ],
    service,
    'smart', // math and logic: the strongest model that sees the photo, thinking harder
  );
  try {
    const obj = parseJsonFromLlm(raw) as { agree?: boolean; summary?: string };
    return { agree: Boolean(obj.agree), summary: String(obj.summary ?? '').trim() };
  } catch {
    return { agree: false, summary: 'Проверка не дала однозначного результата' };
  }
}

export function createHomeworkExecutor(getSettings: () => Settings): Executor {
  return {
    estimate: (input) => estimatePrice(getSettings, input),

    preview: async () => {
      throw new Error('Превью не предусмотрено');
    },

    run: async (input): Promise<ExecutorOutput> => {
      const paths = requireInputPhotos(input, 'Нужна фотография задания');
      const imageDataUris = await Promise.all(paths.map((p) => fileToDataUri(p)));

      const first = await solveHomework(getSettings, input, imageDataUris, 'solve');
      const second = await solveHomework(getSettings, input, imageDataUris, 'resolve');
      let verify = await verifyHomework(getSettings, input, imageDataUris, first, second);
      let solution = second;

      if (!verify.agree) {
        const third = await solveHomework(getSettings, input, imageDataUris, 'resolve');
        verify = await verifyHomework(getSettings, input, imageDataUris, second, third);
        solution = third;
      }

      if (!verify.agree) {
        throw new Error(`Нужна проверка человеком: ${verify.summary || 'решения расходятся'}`);
      }

      const packed = await packageTextOutput(input.workDir, solution, 'output');
      return { text: packed.text, files: packed.files };
    },
  };
}
