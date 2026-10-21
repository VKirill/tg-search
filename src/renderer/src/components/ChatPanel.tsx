import { useEffect, useRef, useState } from 'react';
import type { AgentStep, ChatMessage, Lead, Project, Source } from '../../../shared/types';
import { formatLeadDate, formatShortTime } from '../utils/format';
import { getApi } from '../hooks/useApi';
import { useToast } from './Toast';
import { AudioPlayer } from './AudioPlayer';
import { AgentTraceSteps, stepsForAutoTurn } from './AgentTraceSteps';

function traceMsgFromHash(): number | null {
  if (typeof location === 'undefined') return null;
  const m = location.hash.match(/traceMsg=(\d+)/);
  return m ? Number(m[1]) : null;
}

type ChatPanelProps = {
  lead: Lead | null;
  source: Source | null;
  project: Project | null;
  onLeadChange: (lead: Lead) => void;
  onOpenPublication?: (lead: Lead) => void;
  onMarkSpam?: (lead: Lead) => void;
};

export function ChatPanel({ lead, source, project, onLeadChange, onOpenPublication, onMarkSpam }: ChatPanelProps) {
  const toast = useToast();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [text, setText] = useState('');
  const [where, setWhere] = useState<'dm' | 'chat'>('dm');
  const [noteMode, setNoteMode] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recSec, setRecSec] = useState(0);
  const [transcribing, setTranscribing] = useState(false);
  const [collapsedTranscript, setCollapsedTranscript] = useState<Set<number>>(new Set());
  const [agentTrace, setAgentTrace] = useState<AgentStep[]>([]);
  const [shotTraceMsg] = useState(() => traceMsgFromHash());
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const streamsRef = useRef<MediaStream[]>([]);

  useEffect(() => {
    if (!lead) {
      setMessages([]);
      return;
    }
    getApi()
      .messages.list(lead.id)
      .then(setMessages)
      .catch((e) => toast(e instanceof Error ? e.message : String(e)));
  }, [lead?.id, toast]);

  useEffect(() => {
    if (!lead) return;
    const off = getApi().onEvent((e) => {
      if (e.type === 'message:new' && e.message.leadId === lead.id) {
        setMessages((prev) => [...prev, e.message]);
      }
    });
    return off;
  }, [lead?.id]);

  useEffect(() => {
    if (!lead) {
      setAgentTrace([]);
      return;
    }
    getApi()
      .agent.trace(lead.id, 100)
      .then(setAgentTrace)
      .catch((e) => toast(e instanceof Error ? e.message : String(e)));
    const off = getApi().onEvent((e) => {
      if (e.type === 'agent:step' && e.step.leadId === lead.id) {
        setAgentTrace((prev) => (prev.some((s) => s.id === e.step.id) ? prev : [...prev, e.step]));
      }
    });
    return off;
  }, [lead?.id, toast]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && lead && text.trim()) {
        e.preventDefault();
        send();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const send = async () => {
    if (!lead || !text.trim()) return;
    setSendError(null);
    try {
      if (noteMode) {
        await getApi().crm.addNote(lead.id, text.trim());
        setText('');
        setNoteMode(false);
        return;
      }
      await getApi().messages.send(lead.id, text.trim(), where);
      setText('');
    } catch (e) {
      setSendError(e instanceof Error ? e.message : String(e));
    }
  };

  const draft = async () => {
    if (!lead) return;
    setDrafting(true);
    try {
      setText(await getApi().messages.draft(lead.id));
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setDrafting(false);
    }
  };

  const voicePreview = async () => {
    if (!text.trim()) return;
    try {
      const path = await getApi().voice.preview(text.trim());
      new Audio(path).play();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };

  const voiceSend = async () => {
    if (!lead || !text.trim()) return;
    try {
      await getApi().voice.send(lead.id, text.trim(), where);
      setText('');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };

  const toggleHandoff = async () => {
    if (!lead) return;
    try {
      const l = await getApi().leads.setHandoff(lead.id, !lead.handoff);
      onLeadChange(l);
      if (l.handoff && lead.authorName) {
        toast(`Диалог передан вам: ${lead.authorName}`);
        if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
          new Notification('TG Search', { body: `Диалог передан вам: ${lead.authorName}` });
        }
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };

  const stopStreams = () => {
    streamsRef.current.forEach((s) => s.getTracks().forEach((t) => t.stop()));
    streamsRef.current = [];
    if (recTimerRef.current) clearInterval(recTimerRef.current);
  };

  const startRecording = async () => {
    if (!lead) return;
    try {
      const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
      let displayStream: MediaStream;
      try {
        displayStream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
        displayStream.getVideoTracks().forEach((t) => t.stop());
      } catch {
        toast('Разрешите запись экрана и системного звука в настройках macOS (Screen & System Audio Recording).');
        mic.getTracks().forEach((t) => t.stop());
        return;
      }
      const ctx = new AudioContext();
      const dest = ctx.createMediaStreamDestination();
      ctx.createMediaStreamSource(mic).connect(dest);
      const dispAudio = displayStream.getAudioTracks()[0];
      if (dispAudio) ctx.createMediaStreamSource(new MediaStream([dispAudio])).connect(dest);
      streamsRef.current = [mic, displayStream];
      const rec = new MediaRecorder(dest.stream, { mimeType: 'audio/webm;codecs=opus' });
      chunksRef.current = [];
      rec.ondataavailable = (e) => { if (e.data.size) chunksRef.current.push(e.data); };
      rec.onstop = async () => {
        stopStreams();
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
        const buf = new Uint8Array(await blob.arrayBuffer());
        setTranscribing(true);
        try {
          await getApi().calls.save(lead.id, buf, 'audio/webm', recSec);
        } catch (e) {
          toast(e instanceof Error ? e.message : String(e));
        } finally {
          setTranscribing(false);
        }
      };
      recorderRef.current = rec;
      rec.start();
      setRecording(true);
      setRecSec(0);
      recTimerRef.current = setInterval(() => setRecSec((s) => s + 1), 1000);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Нет доступа к микрофону');
    }
  };

  const stopRecording = () => {
    recorderRef.current?.stop();
    setRecording(false);
  };

  const markSpam = async () => {
    if (!lead) return;
    if (!confirm('Пометить текст как спам? Лид скроется из входящих.')) return;
    try {
      const l = await getApi().spam.markSpam(lead.id);
      onLeadChange(l);
      onMarkSpam?.(l);
      toast('Помечено как спам');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };

  if (!lead) {
    return (
      <section className="panel panel--chat">
        <div className="empty-state">Выберите диалог</div>
      </section>
    );
  }

  const noAuthor = lead.authorUserId == null;
  const chainLabel = project && lead.sequenceStep > 0
    ? `Цепочка: шаг ${lead.sequenceStep}/${project.sequence.length}`
    : null;

  return (
    <section className="panel panel--chat">
      <div className="chat-header">
        <div className="chat-header__row">
          <div>
            <div className="chat-header__title">{lead.authorName ?? 'Лид'}</div>
            <div className="chat-header__sub">
              {lead.authorUsername ? `@${lead.authorUsername} · ` : ''}{source?.title ?? 'Источник'}
            </div>
          </div>
          <div className="chat-header__actions no-drag">
            {chainLabel && <span className="tag">{chainLabel}</span>}
            <button type="button" className="btn btn--sm" onClick={toggleHandoff}>
              {lead.handoff ? 'Вернуть ИИ-менеджеру' : 'Взять на себя'}
            </button>
            <button type="button" className="btn btn--sm btn--ghost" onClick={markSpam}>Спам</button>
            {!recording ? (
              <button type="button" className="btn btn--sm" onClick={startRecording}>Записать созвон</button>
            ) : (
              <button type="button" className="btn btn--sm btn--danger" onClick={stopRecording}>Стоп · {recSec} с</button>
            )}
          </div>
        </div>
        {recording && <div className="recording-pill">● Запись {recSec} с</div>}
        {transcribing && <div className="activity-line">Расшифровываю…</div>}
      </div>
      <div className="chat-body">
        <div className="quote-card">
          <div className="quote-card__text">{lead.text}</div>
          <div className="quote-card__meta"><span>{formatLeadDate(lead.date)}</span></div>
          <div className="quote-card__actions no-drag">
            {lead.link && (
              <>
                <button type="button" className="btn btn--sm btn--primary" onClick={() => onOpenPublication?.(lead)}>
                  Открыть публикацию
                </button>
              </>
            )}
          </div>
        </div>
        {messages.map((m, idx) => {
          const prev = messages.slice(0, idx).filter((x) => x.kind !== 'note').pop();
          const prevDate = prev?.date ?? lead.date - 1;
          if (idx === 0 && m.kind === 'text' && m.direction === 'in' && m.text === lead.text) return null;
          if (m.kind === 'note') {
            return (
              <div key={m.id} className="bubble bubble--note">
                <div className="bubble__note-label">Заметка · видно только вам</div>
                {m.text}
              </div>
            );
          }
          const autoLabel = m.auto ? 'автопилот' : m.kind === 'voice' && m.direction === 'out' ? 'ИИ-менеджер' : null;
          if (m.kind === 'voice' || m.kind === 'call') {
            const collapsed = collapsedTranscript.has(m.id);
            return (
              <div key={m.id} className={`bubble bubble--${m.direction === 'in' ? 'in' : 'out'}`}>
                {m.kind === 'call' && <div className="call-card-title">Созвон {formatShortTime(m.date)}</div>}
                {autoLabel && <div className="bubble__auto">{autoLabel}</div>}
                {m.mediaPath && <AudioPlayer src={m.mediaPath} durationSec={m.durationSec} />}
                {m.text && (
                  <>
                    <button type="button" className="transcript-toggle" onClick={() => {
                      setCollapsedTranscript((prev) => {
                        const n = new Set(prev);
                        if (n.has(m.id)) n.delete(m.id); else n.add(m.id);
                        return n;
                      });
                    }}>
                      {collapsed ? 'Показать расшифровку' : 'Скрыть расшифровку'}
                    </button>
                    {!collapsed && <p className="transcript">{m.text}</p>}
                  </>
                )}
              </div>
            );
          }
          const turnSteps = m.auto && m.direction === 'out' ? stepsForAutoTurn(agentTrace, m.date, prevDate) : [];
          return (
            <div key={m.id} className={`bubble bubble--${m.direction === 'in' ? 'in' : 'out'}`}>
              {autoLabel && <div className="bubble__auto">{autoLabel}</div>}
              {m.text}
              <div className="lead-card__date" style={{ marginTop: 4 }}>{formatShortTime(m.date)}</div>
              {turnSteps.length > 0 && (
                <AgentTraceSteps
                  steps={turnSteps}
                  defaultOpen={shotTraceMsg === m.id}
                />
              )}
            </div>
          );
        })}
        {lead.handoff && lead.handoffReason && (
          <div className="handoff-divider">Диалог передан вам · {lead.handoffReason}</div>
        )}
      </div>
      <div className="composer no-drag">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={noteMode ? 'Приватная заметка…' : 'Сообщение…'}
          aria-label="Текст сообщения"
        />
        <div className="composer__row">
          <div className="segmented">
            <button type="button" className={where === 'dm' ? 'button--active' : ''} disabled={noAuthor || noteMode} onClick={() => setWhere('dm')}>Лично</button>
            <button type="button" className={where === 'chat' ? 'button--active' : ''} disabled={noteMode} onClick={() => setWhere('chat')}>В чате</button>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className={`btn btn--sm${noteMode ? ' btn--primary' : ''}`} onClick={() => setNoteMode(!noteMode)}>Заметка</button>
            <button type="button" className="btn btn--sm" onClick={draft} disabled={drafting || noteMode}>{drafting ? '…' : 'ИИ-черновик'}</button>
            <button type="button" className="btn btn--sm" onClick={voicePreview} disabled={noteMode || !text.trim()}>Прослушать</button>
            <button type="button" className="btn btn--sm" onClick={voiceSend} disabled={noteMode || !text.trim()}>Озвучить</button>
            <button type="button" className="btn btn--sm btn--primary" onClick={send} disabled={!text.trim()}>Отправить ⌘↩</button>
          </div>
        </div>
        {sendError && <div className="composer__error">{sendError}</div>}
      </div>
    </section>
  );
}
