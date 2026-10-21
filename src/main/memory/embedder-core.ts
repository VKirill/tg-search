import { env, AutoProcessor, AutoModel, RawImage } from '@huggingface/transformers';

const MODEL_ID = 'onnx-community/embeddinggemma-2-ONNX';
// Long inputs cost memory and add nothing to retrieval; the model context is 8K tokens anyway
const MAX_CHARS = 6000;
const clip = (s: string) => (s.length > MAX_CHARS ? s.slice(0, MAX_CHARS) : s);

let processor: Awaited<ReturnType<typeof AutoProcessor.from_pretrained>> | null = null;
let model: Awaited<ReturnType<typeof AutoModel.from_pretrained>> | null = null;

export function setEmbedderCacheDir(cacheDir: string) {
  env.cacheDir = cacheDir;
}

export async function loadEmbedderModel(): Promise<void> {
  if (processor && model) return;
  processor = await AutoProcessor.from_pretrained(MODEL_ID);
  model = await AutoModel.from_pretrained(MODEL_ID, {
    device: 'cpu',
    dtype: 'q4',
    // onnxruntime's CPU arena keeps the largest buffers ever seen; with inputs of varying length it only grows
    session_options: { enableCpuMemArena: false, enableMemPattern: false },
  });
}

export async function unloadEmbedderModel(): Promise<void> {
  const m = model;
  processor = null;
  model = null;
  await m?.dispose(); // release the native onnxruntime sessions, not just the JS references
}

function toArray(tensor: { data: Float32Array | number[] }): Float32Array {
  const d = tensor.data;
  return d instanceof Float32Array ? d : new Float32Array(d as number[]);
}

export async function embedQueryText(text: string): Promise<Float32Array> {
  await loadEmbedderModel();
  const prefixed = `task: search result | query: ${clip(text)}`;
  const inputs = await processor!(prefixed);
  const out = await model!(inputs);
  return toArray(out.sentence_embedding);
}

export async function embedDocumentText(text: string, title?: string): Promise<Float32Array> {
  const doc = `title: ${title?.trim() || 'none'} | text: ${clip(text)}`;
  await loadEmbedderModel();
  const inputs = await processor!(doc);
  const out = await model!(inputs);
  return toArray(out.sentence_embedding);
}

export async function embedImagePath(path: string): Promise<Float32Array> {
  await loadEmbedderModel();
  const image = await RawImage.read(path);
  const inputs = await processor!(null, image);
  const out = await model!(inputs);
  return toArray(out.sentence_embedding);
}
