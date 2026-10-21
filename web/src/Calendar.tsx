import '@bryntum/scheduler/fontawesome/css/fontawesome.css';
import '@bryntum/scheduler/fontawesome/css/solid.css';
import '@bryntum/scheduler/scheduler.css';
import '@bryntum/scheduler/svalbard-light.css';
import { Scheduler } from '@bryntum/scheduler';
import { useEffect, useMemo, useRef } from 'react';
import { usd, type DeskState, type RunView } from './api';

const DAY = 86_400_000;
const at = (d: string | number | Date) => new Date(d);
const plus = (d: Date, days: number) => new Date(d.getTime() + days * DAY);

/** When the money was earned; fixed for the synthetic demo data. */
const EARNING_WINDOWS = {
  revenue_share: { start: '2026-08-24', end: '2026-10-18', name: 'Season 7 earnings' },
  prize_pool: { start: '2026-10-03', end: '2026-10-11', name: 'Autumn Cup' },
} as const;
const PLANNED_PAYOUT = '2026-11-05';
const NEXT_SEASON_PAYOUT = '2027-01-05';

interface CalEvent {
  id: string;
  resourceId: string;
  name: string;
  startDate: Date;
  endDate: Date;
  eventColor: string;
  eventStyle?: 'dashed';
  iconCls?: string;
}

/**
 * Turns one payout run into a timeline: when each recipient earned the money,
 * holds under review, the payout date and, for unclaimed payouts, the 30-day
 * claim window with a reminder. Recomputed from the run, so the agent's and
 * PayPal's updates show up on the next refresh.
 */
export function calendarFor(state: DeskState, run: RunView) {
  const resources = run.allocations.map((a) => ({
    id: a.recipientId,
    name:
      state.season.creators.find((c) => c.id === a.recipientId)?.handle ??
      state.tournament.players.find((p) => p.id === a.recipientId)?.handle ??
      a.recipientId,
    amount: usd(a.amountCents),
  }));
  const win = EARNING_WINDOWS[run.kind];
  const created = at(run.createdAt);
  const events: CalEvent[] = [];
  for (const a of run.allocations) {
    const id = a.recipientId;
    events.push({ id: `${id}-earn`, resourceId: id, name: win.name, startDate: at(win.start), endDate: at(win.end), eventColor: 'gray', eventStyle: 'dashed' });
    if (a.status === 'held') {
      events.push({ id: `${id}-hold`, resourceId: id, name: `Hold review · ${usd(a.amountCents)}`, startDate: created, endDate: plus(created, 10), eventColor: 'red', iconCls: 'fa fa-hand' });
      continue;
    }
    if (a.status === 'below_minimum') {
      events.push({ id: `${id}-roll`, resourceId: id, name: `Rolls over · ${usd(a.amountCents)}`, startDate: at(win.end), endDate: at(NEXT_SEASON_PAYOUT), eventColor: 'violet', iconCls: 'fa fa-rotate' });
      continue;
    }
    const item = run.items[id];
    if (!run.batch || !item) {
      events.push({ id: `${id}-plan`, resourceId: id, name: `Payout ${usd(a.amountCents)}`, startDate: at(PLANNED_PAYOUT), endDate: plus(at(PLANNED_PAYOUT), 5), eventColor: run.status === 'approved' ? 'blue' : 'cyan', iconCls: 'fa fa-calendar-check' });
      continue;
    }
    const sent = at(run.batch.submittedAt);
    if (item.status === 'UNCLAIMED') {
      events.push({ id: `${id}-claim`, resourceId: id, name: `Unclaimed · claim window`, startDate: sent, endDate: plus(sent, 30), eventColor: 'orange', iconCls: 'fa fa-hourglass-half' });
      events.push({ id: `${id}-remind`, resourceId: id, name: 'Reminder', startDate: plus(sent, 7), endDate: plus(sent, 10), eventColor: 'yellow', iconCls: 'fa fa-envelope' });
    } else {
      const ok = item.status === 'SUCCESS';
      const bad = ['FAILED', 'RETURNED', 'BLOCKED'].includes(item.status);
      events.push({ id: `${id}-paid`, resourceId: id, name: `${ok ? 'Paid' : item.status} · ${usd(a.amountCents)}`, startDate: sent, endDate: plus(sent, 5), eventColor: ok ? 'green' : bad ? 'red' : 'blue', iconCls: ok ? 'fa fa-check' : 'fa fa-paper-plane' });
    }
  }
  return { resources, events };
}

export function PayoutCalendar({ state, run }: { state: DeskState; run?: RunView }) {
  const host = useRef<HTMLDivElement>(null);
  const scheduler = useRef<Scheduler>();
  const data = useMemo(() => (run ? calendarFor(state, run) : undefined), [state, run]);

  useEffect(() => {
    if (!host.current) return;
    scheduler.current = new Scheduler({
      appendTo: host.current,
      startDate: new Date(2026, 8, 1),
      endDate: new Date(2027, 0, 15),
      viewPreset: 'weekAndMonth',
      rowHeight: 38,
      barMargin: 5,
      eventStyle: 'filled',
      readOnly: true,
      columns: [
        { text: 'Recipient', field: 'name', width: 170 },
        { text: 'Amount', field: 'amount', width: 100, align: 'right' },
      ],
      features: { timeRanges: { showCurrentTimeLine: true }, eventTooltip: true },
    });
    return () => {
      scheduler.current?.destroy();
      scheduler.current = undefined;
    };
  }, []);

  useEffect(() => {
    const s = scheduler.current;
    if (!s) return;
    s.resourceStore.data = data?.resources ?? [];
    s.eventStore.data = data?.events ?? [];
    if (data?.events.length) void s.zoomToFit({ leftMargin: 20, rightMargin: 40 });
  }, [data]);

  return (
    <>
      {!run && (
        <div className="panel empty">
          <b>No payout run yet</b>
          <span>Draft a run with the agent to see earnings, holds, payout dates and claim windows here.</span>
        </div>
      )}
      <div className="panel fill" ref={host} style={{ overflow: 'hidden', display: run ? 'block' : 'none' }} />
    </>
  );
}
