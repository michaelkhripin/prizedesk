import { useEffect, useRef, useState } from 'react';
import type { AgentAction } from './api';
import { Markdown } from './md';

export type ChatEntry =
  | { role: 'user'; text: string }
  | { role: 'agent'; text: string; actions: AgentAction[]; model?: string };

const SUGGESTIONS = [
  'Draft the Season 7 creator payout: 70% by engaged playtime, 30% by unique players, cap each creator at 25%, minimum payout $10, hold anyone flagged.',
  'Draft the Autumn Cup prizes: 50/30/20, hold flagged teams.',
  'Why is cr_004 on hold?',
  'Check the payout status.',
];

export function AgentPanel(props: { chat: ChatEntry[]; busy: boolean; onAsk: (m: string) => void; model?: string }) {
  const [text, setText] = useState('');
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: 'smooth' });
  }, [props.chat.length, props.busy]);

  const send = (m: string) => {
    if (!m.trim() || props.busy) return;
    props.onAsk(m.trim());
    setText('');
  };

  return (
    <aside className="agent">
      <header>
        <h2>Payout agent</h2>
        <span className="badge">prepares · you approve</span>
      </header>
      <div className="chat">
        {props.chat.length === 0 && (
          <div className="empty">
            <b>Tell me how to split the money.</b>
            <span>I draft the run, check it for fraud and explain every amount. Nothing is paid until a person approves it.</span>
          </div>
        )}
        {props.chat.map((m, i) =>
          m.role === 'user' ? (
            <div key={i} className="msg user">{m.text}</div>
          ) : (
            <div key={i} className="msg agent-msg">
              {m.actions.length > 0 && (
                <div className="actions">
                  {m.actions.map((a, k) => (
                    <span key={k} className={`badge ${a.ok ? 'brand' : 'bad'}`} title={a.summary}>
                      {a.ok ? '⚙' : '⚠'} {a.tool}
                    </span>
                  ))}
                </div>
              )}
              <Markdown text={m.text} />
              {m.model && <div className="model">{m.model}</div>}
            </div>
          ),
        )}
        {props.busy && <div className="msg agent-msg">Working…</div>}
        <div ref={end} />
      </div>
      <div className="suggestions">
        {SUGGESTIONS.map((s) => (
          <button key={s} onClick={() => send(s)} disabled={props.busy} title={s}>
            {s.length > 42 ? `${s.slice(0, 40)}…` : s}
          </button>
        ))}
      </div>
      <div className="composer">
        <textarea
          placeholder="Ask about a payout, or write a split policy…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send(text);
            }
          }}
        />
        <button className="primary" onClick={() => send(text)} disabled={props.busy || !text.trim()}>
          Send
        </button>
      </div>
    </aside>
  );
}
