import type { LLM, Message, ToolCall } from './llm.js';
import { deskTools, paypalToolkitTools, type AgentTool, type ToolContext } from './tools.js';

export const SYSTEM_PROMPT = `You are PrizeDesk, the payout assistant for a game studio's community team.
You help them pay UGC creators their share of a season creator fund, and pay tournament prizes, through PayPal.

Rules:
- Every number you state must come from a tool result. Never compute splits yourself; draft_payout_run does that.
- You prepare; people decide. You cannot approve or submit a payout run and must never say money was sent unless refresh_payout_status shows it.
- When something is held or flagged, say why in one plain sentence using the evidence from the tools.
- Messages to recipients are drafts for a person to send.
- Be brief: a short paragraph or a few bullets, amounts in USD. End with the next human step when there is one (for example: review the holds, then approve in the Approve panel).`;

export interface AgentAction {
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  summary: string;
}

export interface AgentReply {
  reply: string;
  actions: AgentAction[];
  model: string;
  messages: Message[];
}

const MAX_STEPS = 6;

export function allTools(ctx: ToolContext): AgentTool[] {
  return [...deskTools, ...paypalToolkitTools(ctx)];
}

function summarize(result: unknown): string {
  if (result && typeof result === 'object') {
    const r = result as Record<string, unknown>;
    if (typeof r.summary === 'string') return r.summary;
    if (typeof r.error === 'string') return r.error;
  }
  const text = JSON.stringify(result) ?? '';
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

export async function runAgent(llm: LLM, ctx: ToolContext, history: Message[], userText: string): Promise<AgentReply> {
  const tools = allTools(ctx);
  const byName = new Map(tools.map((t) => [t.spec.name, t]));
  const messages: Message[] = [...history, { role: 'user', text: userText }];
  const actions: AgentAction[] = [];
  let model = llm.name;

  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await llm.step(SYSTEM_PROMPT, messages, tools.map((t) => t.spec));
    model = res.model;
    messages.push({ role: 'assistant', text: res.text, toolCalls: res.toolCalls, raw: res.raw });
    if (res.toolCalls.length === 0) {
      return { reply: res.text ?? '', actions, model, messages };
    }
    const results = [];
    for (const call of res.toolCalls) {
      const { result, ok } = await execute(byName, call, ctx);
      actions.push({ tool: call.name, args: call.args, ok, summary: summarize(result) });
      ctx.store.audit('agent', `tool.${call.name}`, { args: call.args, ok });
      results.push({ id: call.id, name: call.name, result });
    }
    messages.push({ role: 'tool', results });
  }
  return { reply: 'I stopped after too many steps. Try a narrower question.', actions, model, messages };
}

async function execute(byName: Map<string, AgentTool>, call: ToolCall, ctx: ToolContext) {
  const t = byName.get(call.name);
  if (!t) return { ok: false, result: { error: `unknown tool ${call.name}` } };
  try {
    return { ok: true, result: await t.run(call.args, ctx) };
  } catch (e) {
    return { ok: false, result: { error: e instanceof Error ? e.message : String(e) } };
  }
}
