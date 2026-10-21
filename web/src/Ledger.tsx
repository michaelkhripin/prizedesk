import { AllCommunityModule, ModuleRegistry, themeQuartz, type ColDef, type RowClassParams } from 'ag-grid-community';
import { AgGridReact } from 'ag-grid-react';
import { useMemo, useState } from 'react';
import { api, usd, type DeskState, type RunView } from './api';

ModuleRegistry.registerModules([AllCommunityModule]);

const theme = themeQuartz.withParams({
  fontFamily: 'inherit',
  headerFontWeight: 600,
  accentColor: '#224cd6',
  borderColor: '#e3e6ec',
  rowHoverColor: '#f3f6fe',
  wrapperBorderRadius: 10,
});

interface Row {
  id: string;
  handle: string;
  email: string;
  sharePct: number;
  amountCents: number;
  status: string;
  flags: string[];
  paypal: string;
}

const STATUS_CLASS: Record<string, string> = {
  payable: 'ok',
  held: 'bad',
  below_minimum: '',
  SUCCESS: 'ok',
  PENDING: 'brand',
  UNCLAIMED: 'warn',
  FAILED: 'bad',
  RETURNED: 'bad',
  NOT_SENT: '',
};

const Badge = ({ value }: { value: string }) =>
  value ? <span className={`badge ${STATUS_CLASS[value] ?? ''}`}>{value.replace('_', ' ')}</span> : null;

export function Ledger(props: {
  state: DeskState;
  run?: RunView;
  onSelectRun: (id: string) => void;
  onChanged: () => Promise<void>;
  onAsk: (m: string) => void;
  maxBatchUsd?: number;
}) {
  const { state, run } = props;
  const [approver, setApprover] = useState(() => {
    try {
      return localStorage.getItem('prizedesk.approver') ?? '';
    } catch {
      return '';
    }
  });
  const [error, setError] = useState<string>();
  const [working, setWorking] = useState(false);

  const rows = useMemo<Row[]>(() => {
    if (!run) return [];
    const handle = (id: string) =>
      state.season.creators.find((c) => c.id === id)?.handle ??
      state.tournament.players.find((p) => p.id === id)?.handle ??
      id;
    const teamOf = (id: string) => state.tournament.players.find((p) => p.id === id)?.teamId;
    return run.allocations.map((a) => ({
      id: a.recipientId,
      handle: handle(a.recipientId),
      email: a.payoutEmail,
      sharePct: a.shareBps / 100,
      amountCents: a.amountCents,
      status: a.status,
      flags: run.flags
        .filter((f) => f.subjectId === a.recipientId || f.subjectId === teamOf(a.recipientId))
        .map((f) => `${f.severity === 'high' ? '●' : '○'} ${f.kind.replaceAll('_', ' ')}`),
      paypal: run.items[a.recipientId]?.status ?? '',
    }));
  }, [run, state]);

  const columns = useMemo<ColDef<Row>[]>(
    () => [
      { field: 'handle', headerName: 'Recipient', flex: 1.1, minWidth: 140 },
      { field: 'id', headerName: 'ID', width: 80, cellClass: 'mono' },
      { field: 'email', headerName: 'PayPal email', flex: 1.3, minWidth: 150 },
      {
        field: 'sharePct',
        headerName: 'Share',
        width: 85,
        type: 'rightAligned',
        valueFormatter: (p) => `${(p.value as number).toFixed(2)}%`,
      },
      {
        field: 'amountCents',
        headerName: 'Amount',
        width: 110,
        type: 'rightAligned',
        sort: 'desc',
        valueFormatter: (p) => usd(p.value as number),
      },
      { field: 'status', headerName: 'Decision', width: 110, cellRenderer: (p: { value: string }) => <Badge value={p.value} /> },
      {
        field: 'flags',
        headerName: 'Fraud checks',
        flex: 1.3,
        minWidth: 150,
        valueFormatter: (p) => (p.value as string[]).join(', '),
        cellStyle: (p) => ((p.value as string[]).some((f) => f.startsWith('●')) ? { color: 'var(--bad)' } : null),
        filter: true,
      },
      { field: 'paypal', headerName: 'PayPal status', width: 125, cellRenderer: (p: { value: string }) => <Badge value={p.value} /> },
    ],
    [],
  );

  const act = async (fn: () => Promise<unknown>) => {
    setError(undefined);
    setWorking(true);
    try {
      await fn();
      await props.onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setWorking(false);
    }
  };

  if (!run) {
    return (
      <div className="panel fill empty">
        <b>No payout run yet</b>
        <span>Ask the agent on the right to draft one: write the split policy in plain English.</span>
      </div>
    );
  }

  const payableRows = run.allocations.filter((a) => a.status === 'payable');
  const payableCents = payableRows.reduce((s, a) => s + a.amountCents, 0);
  const heldCents = run.allocations.filter((a) => a.status === 'held').reduce((s, a) => s + a.amountCents, 0);

  return (
    <>
      <div className="panel">
        <div className="runbar">
          <select value={run.id} onChange={(e) => props.onSelectRun(e.target.value)}>
            {state.runs.map((r) => (
              <option key={r.id} value={r.id}>
                {r.id} · {r.kind === 'revenue_share' ? 'Season 7 revenue share' : 'Autumn Cup prizes'}
              </option>
            ))}
          </select>
          <span className={`badge ${run.status === 'draft' ? 'warn' : run.status === 'approved' ? 'brand' : 'ok'}`}>{run.status}</span>
          <div className="stat">
            <b>{usd(payableCents)}</b>
            <span>to {payableRows.length} recipients</span>
          </div>
          <div className="stat">
            <b style={{ color: heldCents ? 'var(--bad)' : undefined }}>{usd(heldCents)}</b>
            <span>held for review</span>
          </div>
          <div className="spacer" />
          {run.status === 'draft' && (
            <>
              <input placeholder="Your name" value={approver} onChange={(e) => setApprover(e.target.value)} style={{ width: 130 }} />
              <button
                className="primary"
                disabled={working || !approver.trim()}
                onClick={() =>
                  act(async () => {
                    try {
                      localStorage.setItem('prizedesk.approver', approver);
                    } catch {
                      /* storage unavailable */
                    }
                    await api.approve(run.id, approver);
                  })
                }
              >
                Approve {usd(payableCents)}
              </button>
            </>
          )}
          {run.status === 'approved' && (
            <button
              className="primary"
              disabled={working}
              onClick={() => {
                if (confirm(`Send ${usd(payableCents)} to ${payableRows.length} recipients with PayPal Payouts?`)) act(() => api.submit(run.id));
              }}
            >
              Pay with PayPal
            </button>
          )}
          {(run.status === 'submitted' || run.status === 'completed') && (
            <button disabled={working} onClick={() => act(() => api.refresh(run.id))}>
              Refresh PayPal status
            </button>
          )}
        </div>
        <div className="guard">
          {run.approval
            ? `Approved by ${run.approval.by} · fingerprint ${run.approval.digest}`
            : 'The agent prepared this draft. Review the holds, then approve: the approval is bound to these exact amounts.'}
          {run.batch && ` · PayPal batch ${run.batch.batchId} (${run.batch.status})`}
          {props.maxBatchUsd && ` · batch ceiling $${props.maxBatchUsd.toLocaleString('en-US')}`}
        </div>
        {error && <div className="error" style={{ margin: '0 14px 12px' }}>{error}</div>}
      </div>
      <div className="fill">
        <AgGridReact<Row>
          theme={theme}
          rowData={rows}
          columnDefs={columns}
          getRowId={(p) => p.data.id}
          defaultColDef={{ sortable: true, resizable: true }}
          rowClassRules={{ 'row-held': (p: RowClassParams<Row>) => p.data?.status === 'held' }}
          onRowDoubleClicked={(e) => e.data && props.onAsk(`Why does ${e.data.id} get ${usd(e.data.amountCents)}${e.data.status === 'held' ? ' and why is it on hold' : ''}?`)}
          tooltipShowDelay={300}
        />
      </div>
      <div className="guard" style={{ padding: 0 }}>Double-click a row to ask the agent about that recipient.</div>
    </>
  );
}
