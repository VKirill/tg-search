// «Статистика»: analyzed messages, requests vs chatter, leads, sends, AI spend and the demand map by category.
// Colors are validated for the dark surface (dataviz validator): requests #3d8bfd, chatter #d0752e.
import { useCallback, useEffect, useState } from 'react';
import type { AiModelStat, Category, StatsDay, StatsReport } from '../../../shared/types';
import { getApi } from '../hooks/useApi';
import { useToast } from './Toast';

const REQ = '#3d8bfd';
const CHAT = '#d0752e';
const KIND_LABEL = { jev: 'Jev', llm: 'LLM', stt: 'Распознавание речи', tts: 'Озвучка', image: 'Изображения' } as const;

const usd = (v: number) => (v >= 1 ? `$${v.toFixed(2)}` : v >= 0.01 ? `$${v.toFixed(3)}` : `$${v.toFixed(4)}`);
const num = (v: number) => v.toLocaleString('ru-RU');
const dayLabel = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });

type Tip = { x: number; y: number; lines: string[] } | null;

function Bars({
  days,
  series,
  tip,
  height = 160,
}: {
  days: StatsDay[];
  series: { key: string; color: string; value: (d: StatsDay) => number }[];
  tip: (d: StatsDay) => string[];
  height?: number;
}) {
  const [hover, setHover] = useState<Tip>(null);
  // No floor of 1: daily spend is a fraction of a dollar
  const max = Math.max(...days.map((d) => series.reduce((s, x) => s + x.value(d), 0))) || 1;
  const slot = 100 / days.length;
  const barW = Math.min(slot * 0.62, 6);
  return (
    <div className="stats-chart" onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" className="stats-chart__svg" style={{ height }}>
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1="0" x2="100" y1={height * f} y2={height * f} className="stats-grid" vectorEffect="non-scaling-stroke" />
        ))}
        {days.map((d, i) => {
          let y = height;
          const cx = i * slot + slot / 2;
          return (
            <g key={d.day}>
              {series.map((s, k) => {
                const h = (s.value(d) / max) * (height - 8);
                if (h <= 0) return null;
                y -= h;
                // 2px surface gap between stacked segments
                const gap = k > 0 ? 1.5 : 0;
                return <rect key={s.key} x={cx - barW / 2} y={y} width={barW} height={Math.max(0, h - gap)} fill={s.color} rx="0.6" />;
              })}
              <rect
                x={i * slot}
                y="0"
                width={slot}
                height={height}
                fill="transparent"
                onMouseMove={(e) => {
                  const box = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
                  setHover({ x: e.clientX - box.left, y: e.clientY - box.top, lines: tip(d) });
                }}
              />
            </g>
          );
        })}
      </svg>
      <div className="stats-axis">
        {days.map((d, i) =>
          days.length <= 7 || i % Math.ceil(days.length / 6) === 0 ? (
            <span key={d.day} style={{ left: `${(i + 0.5) * slot}%` }}>{dayLabel(d.day)}</span>
          ) : null,
        )}
      </div>
      {hover && (
        <div className="stats-tip" style={{ left: hover.x + 12, top: hover.y - 8 }}>
          {hover.lines.map((l, i) => (
            <div key={i} className={i === 0 ? 'stats-tip__head' : undefined}>{l}</div>
          ))}
        </div>
      )}
    </div>
  );
}

function CategoriesEditor({ onChange }: { onChange: () => void }) {
  const api = getApi();
  const toast = useToast();
  const [list, setList] = useState<Category[]>([]);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const load = useCallback(async () => setList(await api.categories.list()), [api]);
  useEffect(() => {
    load().catch(() => {});
  }, [load]);
  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await load();
      onChange();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  return (
    <div className="stats-cats-editor">
      {list.map((c) => (
        <div key={c.id} className="stats-cat-row">
          <input type="checkbox" checked={c.enabled} onChange={(e) => run(() => api.categories.update(c.id, { enabled: e.target.checked }))} title="Учитывать" />
          <div className="stats-cat-row__body">
            <input className="text-input" defaultValue={c.name} onBlur={(e) => e.target.value !== c.name && run(() => api.categories.update(c.id, { name: e.target.value }))} />
            <input className="text-input" defaultValue={c.description} onBlur={(e) => e.target.value !== c.description && run(() => api.categories.update(c.id, { description: e.target.value }))} />
          </div>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => confirm(`Удалить категорию «${c.name}»?`) && run(() => api.categories.remove(c.id))}>Удалить</button>
        </div>
      ))}
      <div className="stats-cat-row">
        <div className="stats-cat-row__body">
          <input className="text-input" placeholder="Новая категория, например «Юридические услуги»" value={name} onChange={(e) => setName(e.target.value)} />
          <input className="text-input" placeholder="Какие запросы сюда относятся — Jev читает это описание" value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <button
          type="button"
          className="btn btn--sm btn--primary"
          disabled={!name.trim()}
          onClick={() => run(async () => { await api.categories.create({ name: name.trim(), description: description.trim() }); setName(''); setDescription(''); })}
        >
          Добавить
        </button>
      </div>
      <div className="crm-muted">Категории применяются к новым сообщениям; уже разобранные не пересчитываются.</div>
    </div>
  );
}

export function StatsView() {
  const api = getApi();
  const toast = useToast();
  const [period, setPeriod] = useState<StatsReport['period']>('week');
  const [report, setReport] = useState<StatsReport | null>(null);
  const [openCat, setOpenCat] = useState<number | null | undefined>(undefined);
  const [editCats, setEditCats] = useState(false);

  const load = useCallback(async () => {
    setReport(await api.stats.report(period));
  }, [api, period]);

  useEffect(() => {
    load().catch((e) => toast(e.message));
    const t = setInterval(() => load().catch(() => {}), 60_000);
    return () => clearInterval(t);
  }, [load, toast]);

  if (!report) return <div className="page-view"><div className="crm-muted">Загружаю статистику…</div></div>;
  const t = report.totals;
  const reqShare = t.analyzed ? Math.round((t.requests / t.analyzed) * 100) : 0;
  const maxReq = Math.max(1, ...report.categories.filter((c) => c.categoryId != null).map((c) => c.requests));

  return (
    <div className="page-view stats-view">
      <div className="page-view__head">
        <h1 className="page-title">Статистика</h1>
        <div className="segmented no-drag">
          {(['day', 'week', 'month'] as const).map((p) => (
            <button key={p} type="button" className={period === p ? 'button--active' : ''} onClick={() => setPeriod(p)}>
              {p === 'day' ? 'Сегодня' : p === 'week' ? '7 дней' : '30 дней'}
            </button>
          ))}
        </div>
      </div>

      <div className="stats-tiles">
        <div className="stats-tile"><div className="stats-tile__label">Проанализировано</div><div className="stats-tile__value">{num(t.analyzed)}</div><div className="stats-tile__sub">сообщений</div></div>
        <div className="stats-tile"><div className="stats-tile__label">Запросы на услуги</div><div className="stats-tile__value">{num(t.requests)}</div><div className="stats-tile__sub">{reqShare}% · болтовня {num(t.chatter)}</div></div>
        <div className="stats-tile"><div className="stats-tile__label">Лиды по тематикам</div><div className="stats-tile__value">{num(t.leads)}</div><div className="stats-tile__sub">отправлено сообщений: {num(t.sent)}</div></div>
        <div className="stats-tile"><div className="stats-tile__label">Расходы на ИИ</div><div className="stats-tile__value">{usd(t.costUsd)}</div><div className="stats-tile__sub">Jev {usd(t.costByKind.jev)} · LLM {usd(t.costByKind.llm)}</div></div>
        <div className="stats-tile"><div className="stats-tile__label">Цена лида</div><div className="stats-tile__value">{t.leads ? usd(t.costUsd / t.leads) : '—'}</div><div className="stats-tile__sub">расходы / лиды</div></div>
      </div>

      <div className="stats-grid2">
        <section className="stats-card">
          <div className="stats-card__head">
            <h2 className="section-title">Сообщения по дням</h2>
            <div className="stats-legend">
              <span><i style={{ background: REQ }} />Запросы</span>
              <span><i style={{ background: CHAT }} />Болтовня</span>
            </div>
          </div>
          <Bars
            days={report.days}
            series={[
              { key: 'req', color: REQ, value: (d) => d.requests },
              { key: 'chat', color: CHAT, value: (d) => d.chatter },
            ]}
            tip={(d) => [dayLabel(d.day), `Всего: ${num(d.analyzed)}`, `Запросы: ${num(d.requests)}`, `Болтовня: ${num(d.chatter)}`, `Лиды: ${num(d.leads)}`]}
          />
        </section>
        <section className="stats-card">
          <div className="stats-card__head">
            <h2 className="section-title">Расходы по дням</h2>
          </div>
          <Bars
            days={report.days}
            series={[{ key: 'cost', color: REQ, value: (d) => d.costUsd }]}
            tip={(d) => [
              dayLabel(d.day), `Итого: ${usd(d.costUsd)}`,
              ...(['jev', 'llm', 'stt', 'tts', 'image'] as const).filter((k) => d.costByKind[k] > 0).map((k) => `${KIND_LABEL[k]}: ${usd(d.costByKind[k])}`),
            ]}
          />
        </section>
      </div>

      <section className="stats-card">
        <div className="stats-card__head">
          <h2 className="section-title">Спрос по категориям</h2>
          <button type="button" className="btn btn--sm" onClick={() => setEditCats((v) => !v)}>{editCats ? 'Готово' : 'Настроить категории'}</button>
        </div>
        {editCats && <CategoriesEditor onChange={() => load().catch(() => {})} />}
        <div className="stats-cats">
          {report.categories.filter((c) => c.categoryId != null).map((c) => (
            <div key={c.categoryId} className="stats-cat">
              <button type="button" className="stats-cat__row" onClick={() => setOpenCat(openCat === c.categoryId ? undefined : c.categoryId)}>
                <span className="stats-cat__name">{c.name}</span>
                <span className="stats-cat__bar"><span style={{ width: `${(c.requests / maxReq) * 100}%`, background: REQ }} /></span>
                <span className="stats-cat__num">{num(c.requests)} запросов</span>
                <span className="stats-cat__total">из {num(c.messages)}</span>
              </button>
              {openCat === c.categoryId && (
                <div className="stats-cat__examples">
                  {c.examples.length ? c.examples.map((e, i) => (
                    <div key={i} className="stats-example">
                      <span className="stats-example__prob">{Math.round(e.prob * 100)}%</span>
                      <span className="stats-example__text">{e.text}</span>
                      {e.link && <button type="button" className="chats-reply" onClick={() => api.shell.openExternal(e.link!)}>открыть</button>}
                    </div>
                  )) : <div className="crm-muted">Запросов в этой категории пока нет</div>}
                </div>
              )}
            </div>
          ))}
          {report.categories.filter((c) => c.categoryId == null).map((c) => (
            <div key="none" className="crm-muted stats-cat-none">Без категории: {num(c.messages)} сообщений (болтовня и темы вне списка)</div>
          ))}
          {!report.categories.length && <div className="crm-muted">Сообщения ещё не разбирались за этот период</div>}
        </div>
      </section>

      <ModelRecords days={period === 'day' ? 1 : period === 'week' ? 7 : 30} />

      <section className="stats-card">
        <h2 className="section-title">Расходы по моделям</h2>
        <table className="stats-table">
          <thead>
            <tr><th>Сервис</th><th>Модель</th><th>Вызовов</th><th>Токены (вход / выход)</th><th>Объём</th><th>Стоимость</th></tr>
          </thead>
          <tbody>
            {report.usage.map((u) => (
              <tr key={`${u.kind}-${u.model}`}>
                <td>{KIND_LABEL[u.kind]}</td>
                <td>{u.model}</td>
                <td>{num(u.calls)}</td>
                <td>{u.inputTokens || u.outputTokens ? `${num(u.inputTokens)} / ${num(u.outputTokens)}` : '—'}</td>
                <td>{u.kind === 'jev' ? `${num(u.units)} вопросов` : u.kind === 'image' ? `${num(u.units)} изобр.` : u.kind === 'llm' ? '—' : `${Math.round(u.units / 60)} мин`}</td>
                <td>{usd(u.costUsd)}</td>
              </tr>
            ))}
            {!report.usage.length && (
              <tr><td colSpan={6} className="crm-muted">Расходов за период нет</td></tr>
            )}
          </tbody>
        </table>
        <div className="crm-muted">Jev и речь — оценка по ценам из настроек; LLM через OpenRouter — точная стоимость из ответа.</div>
      </section>
    </div>
  );
}

const JOB_LABEL: Record<string, string> = {
  solver: 'решатель', copywriter: 'копирайтер', researcher: 'исследователь', analyst: 'аналитик', directologist: 'директолог',
  homework: 'заказ: задачи', copywriting: 'заказ: тексты', marketplace_card: 'заказ: карточки', image_gen: 'заказ: картинки', assistant: 'ассистент',
  gateway: 'служебное', consultant: 'консультант в группе',
};

// How each model did each kind of job: accepted, turned down by the verifier, sent back by the agent, fixed for the client
function ModelRecords({ days }: { days: number }) {
  const [rows, setRows] = useState<AiModelStat[]>([]);
  useEffect(() => {
    getApi().ai.stats(days).then(setRows, () => setRows([]));
  }, [days]);
  const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '—');
  return (
    <section className="stats-card">
      <h2 className="section-title">Модели в работе</h2>
      <table className="stats-table">
        <thead>
          <tr><th>Модель</th><th>Работа</th><th>Задач</th><th>Принято</th><th>Отклонил проверяющий</th><th>Переделка</th><th>Правки клиента</th><th>Сбои</th><th>Оценка</th><th>Время</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.model}-${r.agent}`}>
              <td>{r.model.split('/').slice(1).join('/')}</td>
              <td>{JOB_LABEL[r.agent] ?? r.agent}</td>
              <td>{num(r.runs)}</td>
              <td>{pct(r.ok, r.runs)}</td>
              <td>{r.rejected || '—'}</td>
              <td>{r.redone || '—'}</td>
              <td>{r.clientFixes || '—'}</td>
              <td>{r.failed || '—'}</td>
              <td>{r.avgScore == null ? '—' : r.avgScore.toFixed(2)}</td>
              <td>{Math.round(r.avgMs / 1000)} с</td>
            </tr>
          ))}
          {!rows.length && <tr><td colSpan={10} className="crm-muted">Поручений моделям за период не было</td></tr>}
        </tbody>
      </table>
      <div className="crm-muted">По этим данным маршрутизатор понижает модели, которые часто ошибаются на этой работе, и поднимает надёжные.</div>
    </section>
  );
}
