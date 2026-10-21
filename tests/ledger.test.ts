import { describe, expect, it } from 'vitest';
import { Db } from '../src/main/db';
import { createLedger, currentJob, withJob } from '../src/main/opencode/ledger';
import { parseVerdict, verifyPrompt } from '../src/main/opencode/verify';

describe('model ledger', () => {
  it('counts each model\'s record per job: accepted, rejected by the verifier, sent back, corrected by the client', () => {
    const ledger = createLedger(new Db(':memory:'));
    const free = 'openrouter/nvidia/nemotron-3-ultra-550b-a55b:free';
    const sub = 'router9/ag/gemini-3.8-flash-high';
    const a = ledger.record({ model: free, agent: 'solver', outcome: 'ok', taskId: 1, ms: 60_000 });
    ledger.verdict(a, { ok: false, score: 0.4, note: 'неверный ответ', verifier: sub });
    const b = ledger.record({ model: sub, agent: 'solver', outcome: 'ok', taskId: 1, ms: 30_000 });
    ledger.verdict(b, { ok: true, score: 0.9, note: '', verifier: 'openrouter/google/gemini-4-argon' });
    ledger.review(1, 'accepted');
    ledger.record({ model: sub, agent: 'solver', outcome: 'ok', taskId: 2 });
    ledger.review(2, 'redo');
    ledger.record({ model: sub, agent: 'homework', outcome: 'ok', orderId: 7 });
    ledger.clientFix(7);
    ledger.record({ model: free, agent: 'solver', outcome: 'timeout', taskId: 3 });

    const stat = (model: string, agent: string) => ledger.stats().find((s) => s.model === model && s.agent === agent)!;
    expect(stat(free, 'solver')).toMatchObject({ runs: 2, ok: 0, rejected: 1, failed: 1, avgScore: 0.4 });
    expect(stat(sub, 'solver')).toMatchObject({ runs: 2, ok: 1, redone: 1 });
    expect(stat(sub, 'homework')).toMatchObject({ runs: 1, ok: 0, clientFixes: 1 });

    const trust = ledger.reliability('solver');
    expect(trust.get(free)).toBeCloseTo(1 / 4); // 0 good of 2, with the neutral prior
    expect(trust.get(sub)).toBeCloseTo(2 / 4);
    expect(ledger.reliability('copywriter').size).toBe(0); // no history: the router treats every model as 0.5
  });

  it('the job context follows async calls, so the model requests of an order are recorded under it', async () => {
    expect(currentJob()).toBeUndefined();
    const seen = await withJob({ agent: 'homework', orderId: 9 }, async () => {
      await new Promise((r) => setTimeout(r, 1));
      return currentJob();
    });
    expect(seen).toEqual({ agent: 'homework', orderId: 9 });
  });
});

describe('verifier', () => {
  it('reads the verdict; a low score or ok:false fails; garbage passes (the primary agent still reviews)', () => {
    expect(parseVerdict('{"score": 0.92, "ok": true, "issues": ""}')).toEqual({ ok: true, score: 0.92, note: '' });
    expect(parseVerdict('```json\n{"score": 0.5, "ok": true, "issues": "ответ 2444 м неверен"}\n```').ok).toBe(false);
    expect(parseVerdict('{"score": 0.9, "ok": false, "issues": "x"}').ok).toBe(false);
    expect(parseVerdict('не знаю').ok).toBe(true);
  });

  it('the prompt carries the base checks and the agent\'s own', () => {
    const p = verifyPrompt('реши задачу', 'Ответ: 3', 'пересчитай каждое вычисление; единицы верны');
    expect(p).toContain('- нет выдумок');
    expect(p).toContain('- пересчитай каждое вычисление');
    expect(p).toContain('- единицы верны');
  });
});
