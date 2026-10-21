import type { LLM, Message, StepResult, ToolCall, ToolSpec } from './llm.js';

/**
 * Offline stand-in for an LLM: routes a request to one tool by keywords and
 * answers with the tool's own summary. Lets judges and tests run the whole
 * desk without an API key. It is deliberately simple, not clever.
 */
export class MockLLM implements LLM {
  readonly name = 'mock';

  async step(_system: string, messages: Message[], _tools: ToolSpec[]): Promise<StepResult> {
    const last = messages[messages.length - 1];
    if (last?.role === 'tool') {
      const text = last.results
        .map((r) => {
          const res = r.result as { summary?: string; error?: string };
          return res.summary ?? res.error ?? JSON.stringify(res);
        })
        .join('\n\n');
      return { text, toolCalls: [], model: this.name };
    }
    const user = last?.role === 'user' ? last.text : '';
    return { toolCalls: [route(user)], model: this.name };
  }
}

function route(text: string): ToolCall {
  const t = text.toLowerCase();
  const recipient = text.match(/\b(cr_\d{3}|pl_\d{2})\b/i)?.[1]?.toLowerCase();
  const call = (name: string, args: Record<string, unknown> = {}): ToolCall => ({ id: 'mock_1', name, args });

  if (recipient && /remind|unclaimed/.test(t)) return call('draft_recipient_message', { recipient, purpose: 'unclaimed_reminder' });
  if (recipient && /notice|message|email|write/.test(t)) {
    return call('draft_recipient_message', { recipient, purpose: /hold|held/.test(t) ? 'hold_notice' : 'share_explanation' });
  }
  if (recipient) return call('explain_recipient', { recipient });
  if (/invoice|sponsor/.test(t)) {
    return /check|paid|status/.test(t) ? call('check_sponsor_invoices') : call('invoice_sponsor', { sponsor_id: 'sp_northwind' });
  }
  if (/status|unclaimed|track|refresh|claimed/.test(t)) return call('refresh_payout_status');
  if (/%|split|draft|policy|cap|placement|\d+\s*\/\s*\d+/.test(t)) {
    const prize = /prize|cup|tournament|placement|1st|\d+\s*\/\s*\d+/.test(t);
    return call('draft_payout_run', { kind: prize ? 'prize_pool' : 'revenue_share', policy_text: text });
  }
  return call('get_desk_overview');
}
