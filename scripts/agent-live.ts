// Talks to the real model with an in-memory desk: npm run agent:live -- "your question"
import { config } from '../src/config.js';
import { GeminiLLM } from '../src/agent/gemini.js';
import { runAgent } from '../src/agent/agent.js';
import { Store } from '../src/desk/store.js';
import type { Message } from '../src/agent/llm.js';

const llm = new GeminiLLM(config.llm.geminiKey, config.llm.geminiModels);
const store = new Store(null);
let history: Message[] = [];
const prompts = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      'Draft the season 7 creator payout: 70% by engaged playtime, 30% by unique players, cap each creator at 25%, minimum payout $10, hold anyone flagged.',
      'Why is cr_004 on hold, and what about the two creators sharing an inbox?',
    ];
for (const p of prompts) {
  const res = await runAgent(llm, { store }, history, p);
  history = res.messages;
  console.log(`\n> ${p}\n[${res.model}] tools: ${res.actions.map((a) => `${a.tool}${a.ok ? '' : ' (error)'}`).join(', ') || 'none'}\n${res.reply}`);
}
