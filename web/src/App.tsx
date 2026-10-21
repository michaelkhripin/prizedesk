import { useCallback, useEffect, useState } from 'react';
import { AgentPanel, type ChatEntry } from './AgentPanel';
import { api, usd, type DeskState, type PublicConfig } from './api';
import { Audit } from './Audit';
import { PayoutCalendar } from './Calendar';
import { Fund } from './Fund';
import { Ledger } from './Ledger';

type Tab = 'ledger' | 'calendar' | 'fund' | 'audit';

export function App() {
  const [config, setConfig] = useState<PublicConfig>();
  const [state, setState] = useState<DeskState>();
  const [runId, setRunId] = useState<string>();
  const [tab, setTab] = useState<Tab>('ledger');
  const [chat, setChat] = useState<ChatEntry[]>([]);
  const [sessionId, setSessionId] = useState<string>();
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const s = await api.state();
    setState(s);
    setRunId((cur) => (cur && s.runs.some((r) => r.id === cur) ? cur : s.runs.at(-1)?.id));
  }, []);

  useEffect(() => {
    api.config().then(setConfig);
    refresh();
  }, [refresh]);

  const ask = useCallback(
    async (message: string) => {
      setChat((c) => [...c, { role: 'user', text: message }]);
      setBusy(true);
      try {
        const res = await api.agent(message, sessionId);
        setSessionId(res.sessionId);
        setChat((c) => [...c, { role: 'agent', text: res.reply, actions: res.actions, model: res.model }]);
        const before = state?.runs.length ?? 0;
        const s = await api.state();
        setState(s);
        if (s.runs.length > before) setRunId(s.runs.at(-1)!.id);
      } catch (e) {
        setChat((c) => [...c, { role: 'agent', text: `Something went wrong: ${(e as Error).message}`, actions: [] }]);
      } finally {
        setBusy(false);
      }
    },
    [sessionId, state?.runs.length],
  );

  const run = state?.runs.find((r) => r.id === runId);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="logo">P</div>
          <div>
            PrizeDesk <small>creator revenue share and prize payouts on PayPal</small>
          </div>
        </div>
        <div className="pools">
          {state?.pools.map((p) => {
            const available = p.fundedCents - p.paidOutCents;
            return (
              <div className="pool" key={p.id}>
                <div className="name">{p.name}</div>
                <div className="amount">
                  {usd(available)} <span style={{ color: 'var(--muted)', fontWeight: 400 }}>available</span>
                </div>
                <div className="bar">
                  <span style={{ width: `${Math.min(100, (p.paidOutCents / Math.max(1, p.fundedCents)) * 100)}%` }} />
                </div>
              </div>
            );
          })}
        </div>
        <div className="modes">
          <span className={`badge ${config?.paypalConfigured ? 'brand' : ''}`}>
            PayPal {config?.paypalConfigured ? 'sandbox' : 'off'}
          </span>
          <span className="badge">AI: {config?.llm ?? '…'}</span>
          {config?.demo && (
            <button
              className="badge"
              title="Your demo desk is private to you. Start over with fresh data."
              onClick={async () => {
                await api.reset();
                setChat([]);
                setSessionId(undefined);
                await refresh();
              }}
            >
              Reset demo
            </button>
          )}
        </div>
      </header>

      <main className="main">
        <nav className="tabs">
          {(
            [
              ['ledger', 'Payout run'],
              ['calendar', 'Payout calendar'],
              ['fund', 'Fund'],
              ['audit', 'Audit log'],
            ] as const
          ).map(([id, label]) => (
            <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </nav>
        {state && tab === 'ledger' && (
          <Ledger state={state} run={run} onSelectRun={setRunId} onChanged={refresh} onAsk={ask} maxBatchUsd={config?.maxBatchUsd} />
        )}
        {state && tab === 'calendar' && <PayoutCalendar state={state} run={run} />}
        {state && tab === 'fund' && <Fund state={state} config={config} onChanged={refresh} />}
        {state && tab === 'audit' && <Audit state={state} />}
      </main>

      <AgentPanel chat={chat} busy={busy} onAsk={ask} model={config?.llm} />
    </div>
  );
}
