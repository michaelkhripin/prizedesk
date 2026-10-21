import { describe, expect, it } from 'vitest';
import { Store } from '../desk/store.js';
import { runAgent } from './agent.js';
import { MockLLM } from './mock.js';
import { deskTools } from './tools.js';

const llm = new MockLLM();

describe('agent with the offline model', () => {
  it('drafts a run from a written policy and never approves it', async () => {
    const store = new Store(null);
    const res = await runAgent(llm, { store }, [], '70% by engaged playtime, 30% by unique players, cap 25%, minimum payout $10, hold flagged');
    expect(res.actions.map((a) => a.tool)).toEqual(['draft_payout_run']);
    expect(res.reply).toMatch(/approve/i);
    expect(store.get().runs[0]!.status).toBe('draft');
  });

  it('explains why a creator is on hold', async () => {
    const store = new Store(null);
    await runAgent(llm, { store }, [], 'split 70% by playtime, 30% by unique players');
    const res = await runAgent(llm, { store }, [], 'why is cr_004 on hold?');
    expect(res.reply).toMatch(/scripted/);
  });

  it('reports a bad policy as a tool error instead of crashing', async () => {
    const store = new Store(null);
    const res = await runAgent(llm, { store }, [], 'prize split 50/30/10');
    expect(res.actions[0]!.ok).toBe(false);
    expect(res.reply).toMatch(/100%/);
  });

  it('exposes no tool that can approve or submit money', () => {
    const names = deskTools.map((t) => t.spec.name).join(' ');
    expect(names).not.toMatch(/approve|submit|send_payout|create_payout/);
  });
});
