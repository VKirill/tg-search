import { useEffect, useState } from 'react';
import type { AgentDef, AiRoute } from '../../../shared/types';
import { MODEL_SKILLS } from '../../../shared/types';
import { getApi } from '../hooks/useApi';
import { useToast } from './Toast';

const ROLE: Record<string, string> = { chat: 'основная', fast: 'быстрая', vision: 'со зрением', smart: 'умная' };

// «Кому достанется задача»: the routing a real task of the agent would get — Jev's probabilities and the attempts order
export function RouteCheck() {
  const toast = useToast();
  const [agents, setAgents] = useState<AgentDef[]>([]);
  const [agent, setAgent] = useState('solver');
  const [task, setTask] = useState('Реши задачу: катер прошёл 36 км по течению за 2 часа, а против течения за 3 часа. Найди скорость течения.');
  const [route, setRoute] = useState<AiRoute | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getApi().agents.list().then((list) => setAgents(list.filter((a) => a.mode === 'subagent')), () => {});
  }, []);

  const check = async () => {
    setBusy(true);
    try {
      setRoute(await getApi().ai.route(agent, task));
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const skill = (k: string) => MODEL_SKILLS[k as keyof typeof MODEL_SKILLS] ?? k;
  return (
    <section className="settings-card">
      <h2 className="settings-card__title">Кому достанется задача</h2>
      <p className="field-hint">Jev читает задачу и описания моделей и выбирает, кому её отдать. Здесь можно проверить это на своём примере.</p>
      <div className="route-check">
        <select value={agent} onChange={(e) => setAgent(e.target.value)}>
          {agents.map((a) => <option key={a.name} value={a.name}>{a.name} — {a.description.slice(0, 50)}</option>)}
        </select>
        <textarea className="text-input" rows={2} value={task} onChange={(e) => setTask(e.target.value)} />
        <button type="button" className="btn btn--sm" disabled={busy || !task.trim()} onClick={check}>{busy ? 'Jev думает…' : 'Проверить'}</button>
      </div>
      {route && (
        <div className="route-result">
          <p className="field-hint">
            Роль: {ROLE[route.role] ?? route.role} · нужно от модели: {route.needs.map(skill).join(', ')}
          </p>
          <ul className="route-ranked">
            {route.ranked.map((r) => (
              <li key={r.ref}>
                <span className="route-ranked__bar" style={{ width: `${Math.round((r.p ?? 0) * 100)}%` }} />
                <span className="route-ranked__name">{r.name}</span>
                <span className="crm-muted">{r.p == null ? '—' : `${Math.round(r.p * 100)}%`}</span>
              </li>
            ))}
          </ul>
          <p className="field-hint">
            Порядок попыток: {route.order.map((r, i) => <span key={r}>{i ? ' → ' : ''}<code>{r.split('/').slice(1).join('/')}</code></span>)}
          </p>
        </div>
      )}
    </section>
  );
}
