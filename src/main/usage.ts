// One sink for AI spend: clients report raw usage, the app stores it with a cost for «Статистика».
// Jev and speech costs are estimates from the prices in Settings; OpenRouter reports the exact cost.

import type { Settings, UsageKind } from '../shared/types';
import { todayLocal } from './pipeline/limiter';

export interface UsageEvent {
  kind: UsageKind;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  units?: number; // questions for jev, audio seconds for stt/tts, images for image
  costUsd?: number; // exact cost when the provider reports it
}

type Sink = (u: { day: string; kind: UsageKind; model: string; inputTokens: number; outputTokens: number; units: number; costUsd: number }) => void;

let sink: Sink | null = null;
let getSettings: (() => Settings) | null = null;

export function setUsageSink(fn: Sink, settings: () => Settings) {
  sink = fn;
  getSettings = settings;
}

export function recordUsage(e: UsageEvent) {
  if (!sink || !getSettings) return;
  const s = getSettings();
  let cost = e.costUsd ?? 0;
  if (e.costUsd === undefined) {
    if (e.kind === 'jev') cost = ((e.inputTokens ?? 0) / 1e6) * Number(s.jevPricePerMTok || 0);
    if (e.kind === 'stt') cost = ((e.units ?? 0) / 60) * Number(s.sttPricePerMin || 0);
    if (e.kind === 'tts') cost = ((e.units ?? 0) / 60) * Number(s.ttsPricePerMin || 0);
    if (e.kind === 'image') cost = (e.units ?? 0) * Number(s.imagePricePerImage || 0);
  }
  try {
    sink({
      day: todayLocal(Date.now()), kind: e.kind, model: e.model, inputTokens: e.inputTokens ?? 0,
      outputTokens: e.outputTokens ?? 0, units: e.units ?? 0, costUsd: cost,
    });
  } catch (err) {
    console.error('usage sink', err); // statistics must never break the pipeline
  }
}
