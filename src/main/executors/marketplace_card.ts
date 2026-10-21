import { parseJsonFromLlm } from '../ai/llm';
import type { Settings } from '../../shared/types';
import type { Executor, ExecutorInput, ExecutorOutput } from './types';
import { fileToDataUri, generateImages } from './images';
import {
  estimatePrice,
  formatDialog,
  inputImagePaths,
  packageTextOutput,
  visionChat,
  type VisionContentPart,
} from './shared';

const WB_IMAGE_RULES =
  'На инфографике Wildberries запрещены: цены, скидки, QR-коды, телефоны, призывы купить/заказать. Только товар и преимущества.';
const CARD_ASPECT = '3:4'; // Wildberries / Ozon card: 900×1200

type Slide = { headline: string; callouts: string[]; scene: string };

type CardContent = {
  productPhotos: number[]; // indices of the client's photos that show the product
  referencePhotos: number[]; // example cards the client likes — style only
  style: string; // English: the reference's layout, colours, typography
  title: string;
  description: string;
  characteristics: string[];
  keywords: string[];
  missing: string[]; // facts the client did not give (sizes, materials…) — asked, never invented
  slides: Slide[];
};

// One vision pass over all the client's photos: which is the product, which is an example, what the card says
async function generateCardContent(getSettings: () => Settings, input: ExecutorInput, photos: string[]): Promise<CardContent> {
  const { service, order, history } = input;
  const images = await Promise.all(photos.map((p) => fileToDataUri(p)));
  const parts: VisionContentPart[] = [
    {
      type: 'text',
      text: `Инструкция услуги:\n${service.instructions}\n\nБриф:\n${order.brief}\n\nДиалог:\n${formatDialog(history)}\n\n` +
        `Фото клиента по порядку: ${photos.map((_, i) => `фото ${i}`).join(', ') || 'нет'}.`,
    },
    ...images.map((url) => ({ type: 'image_url' as const, image_url: { url } })),
  ];
  const raw = await visionChat(getSettings, [
    {
      role: 'system',
      content:
        'Ты дизайнер и SEO-копирайтер карточек маркетплейсов. Посмотри все фото клиента: на каких его товар (productPhotos), ' +
        'а какие — пример оформления, который ему нравится (referencePhotos: чужой товар, готовая инфографика с текстами). ' +
        'Ответ — только JSON: {"productPhotos":[…],"referencePhotos":[…],"style":"по-английски: композиция, цвета, шрифты, плашки примера",' +
        '"title":"≤60 символов","description":"…","characteristics":["…"],"keywords":["…"],"missing":["чего не хватает, по-русски"],' +
        '"slides":[{"headline":"заголовок слайда по-русски, 1–4 слова","callouts":["2–4 коротких преимущества по-русски, до 3 слов"],' +
        '"scene":"по-английски: ракурс и что показать — общий вид в интерьере, крупный план детали, размеры со стрелками, материал, функция"}]}. ' +
        'Слайдов — сколько просит клиент (если не сказал — 3, максимум 8), каждый — свой ракурс и своё свойство. ' +
        'Характеристики — только то, что видно на фото или сказано клиентом; неизвестное не выдумывай и не пиши заглушек, а перечисли в missing. ' +
        WB_IMAGE_RULES,
    },
    { role: 'user', content: parts },
  ], service);
  const obj = parseJsonFromLlm(raw) as Partial<CardContent>;
  const idx = (v: unknown) => (Array.isArray(v) ? v.map(Number).filter((n) => n >= 0 && n < photos.length) : []);
  const productPhotos = idx(obj.productPhotos);
  const slides = (Array.isArray(obj.slides) ? obj.slides : []).slice(0, 8).map((x) => ({
    headline: String(x?.headline ?? '').trim(),
    callouts: Array.isArray(x?.callouts) ? x.callouts.map(String).slice(0, 4) : [],
    scene: String(x?.scene ?? 'the whole product, three-quarter view'),
  }));
  return {
    productPhotos: productPhotos.length ? productPhotos : photos.map((_, i) => i).slice(0, 1),
    referencePhotos: idx(obj.referencePhotos).filter((i) => !productPhotos.includes(i)),
    style: String(obj.style ?? ''),
    title: String(obj.title ?? 'Товар').slice(0, 60),
    description: String(obj.description ?? ''),
    characteristics: Array.isArray(obj.characteristics) ? obj.characteristics.map(String).filter((c) => !/уточн/i.test(c)) : [],
    keywords: Array.isArray(obj.keywords) ? obj.keywords.map(String) : [],
    missing: Array.isArray(obj.missing) ? obj.missing.map(String) : [],
    slides: slides.length ? slides : [{ headline: '', callouts: [], scene: 'the whole product, three-quarter view' }],
  };
}

// The product stays exactly as photographed; the example only lends its layout, colours and typography
export function slidePrompt(slide: Slide, style: string, hasReference: boolean): string {
  const text = [slide.headline && `headline «${slide.headline}»`, ...slide.callouts.map((c) => `callout «${c}»`)].filter(Boolean);
  return [
    'Vertical 3:4 marketplace product card slide (Wildberries/Ozon infographic).',
    'The product is exactly the one in the first reference image: keep its shape, colour, materials and every detail unchanged.',
    `Show: ${slide.scene}.`,
    hasReference ? `Design the card like the last reference image (layout, colours, typography, badges) but never copy its product. ${style}` : style,
    text.length ? `Russian text on the slide, spelled exactly: ${text.join('; ')}. Large, clean, readable typography.` : '',
    'Write no other words or numbers: never invent dimensions, materials, fillings, weights or included items.',
    'Only the product is labelled; furniture and decor around it are scenery, never captioned as included.',
    'No prices, discounts, QR codes, phone numbers or calls to buy.',
  ].filter(Boolean).join(' ');
}

function formatCardText(c: CardContent): string {
  const chars = c.characteristics.map((x) => `- ${x}`).join('\n');
  const missing = c.missing.length ? `\n\n**Чтобы дополнить карточку, пришлите:** ${c.missing.join(', ')}` : '';
  return `## ${c.title}\n\n${c.description}\n\n**Характеристики**\n${chars}\n\n**Ключевые слова:** ${c.keywords.join(', ')}${missing}`;
}

async function renderSlide(getSettings: () => Settings, input: ExecutorInput, photos: string[], c: CardContent, i: number, role: 'output' | 'preview') {
  const refs = [...c.productPhotos.map((n) => photos[n]), ...c.referencePhotos.slice(0, 1).map((n) => photos[n])];
  return generateImages(getSettings, input.workDir, {
    prompt: slidePrompt(c.slides[i], c.style, c.referencePhotos.length > 0),
    referencePaths: refs,
    count: 1,
    namePrefix: role === 'preview' ? 'preview-slide' : `slide-${i + 1}`,
    role,
    aspectRatio: CARD_ASPECT,
  });
}

export function createMarketplaceCardExecutor(getSettings: () => Settings): Executor {
  return {
    estimate: (input) => estimatePrice(getSettings, input),

    preview: async (input): Promise<ExecutorOutput> => {
      const photos = inputImagePaths(input);
      const content = await generateCardContent(getSettings, input, photos);
      const files: ExecutorOutput['files'] = [];
      let text = `**${content.title}**\n\n${content.description.split('\n\n')[0] ?? content.description}`;
      if (photos.length) {
        files.push(...(await renderSlide(getSettings, input, photos, content, 0, 'preview')));
        text += '\n\nПревью — первый слайд во вложении.';
      }
      const packed = await packageTextOutput(input.workDir, text, 'preview', 'preview-card');
      return { text: packed.text, files: [...packed.files, ...files] };
    },

    run: async (input): Promise<ExecutorOutput> => {
      const photos = inputImagePaths(input);
      const content = await generateCardContent(getSettings, input, photos);
      const text = formatCardText(content);
      const packed = await packageTextOutput(input.workDir, text, 'output', 'marketplace-card');
      const files = [...packed.files];
      if (photos.length) {
        const slides = await Promise.all(content.slides.map((_, i) => renderSlide(getSettings, input, photos, content, i, 'output')));
        files.push(...slides.flat());
      }
      return {
        text: `${text}\n\n${files.some((f) => f.mime.startsWith('image/')) ? 'Слайды во вложениях.' : ''}`.trim(),
        files,
      };
    },
  };
}
