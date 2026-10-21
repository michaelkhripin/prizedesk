import type { LLM, Message, StepResult, ToolSpec } from './llm.js';

interface Part {
  text?: string;
  functionCall?: { id?: string; name: string; args?: Record<string, unknown> };
  functionResponse?: { id?: string; name: string; response: unknown };
  thoughtSignature?: string;
}
interface Content {
  role: 'user' | 'model';
  parts: Part[];
}

const RETRYABLE = new Set([429, 500, 503]);
/** Prefix for ids we invent when Gemini sends none; those are never sent back. */
const GENERATED = 'gen_';
const sentId = (id: string) => (id.startsWith(GENERATED) ? undefined : id);

/** Gemini REST function calling. Falls back to the next model when one is overloaded. */
export class GeminiLLM implements LLM {
  readonly name = 'gemini';

  constructor(
    private readonly apiKey: string,
    private readonly models: string[],
  ) {}

  async step(system: string, messages: Message[], tools: ToolSpec[]): Promise<StepResult> {
    const body = {
      systemInstruction: { parts: [{ text: system }] },
      contents: messages.map(toContent),
      tools: [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters })) }],
      generationConfig: { temperature: 0.2 },
    };
    let lastError = '';
    for (const model of this.models) {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'x-goog-api-key': this.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as {
        candidates?: { content?: Content }[];
        modelVersion?: string;
        error?: { message: string };
      };
      if (!res.ok) {
        lastError = `${model}: ${res.status} ${json.error?.message ?? ''}`;
        if (RETRYABLE.has(res.status)) continue;
        throw new Error(lastError);
      }
      const content = json.candidates?.[0]?.content ?? { role: 'model', parts: [] };
      const parts = content.parts ?? [];
      const text = parts.filter((p) => p.text).map((p) => p.text).join('').trim() || undefined;
      const toolCalls = parts
        .filter((p) => p.functionCall)
        .map((p, i) => ({ id: p.functionCall!.id ?? `${GENERATED}${i}`, name: p.functionCall!.name, args: p.functionCall!.args ?? {} }));
      return { text, toolCalls, raw: content, model: json.modelVersion ?? model };
    }
    throw new Error(`all Gemini models unavailable (${lastError})`);
  }
}

function toContent(m: Message): Content {
  if (m.role === 'user') return { role: 'user', parts: [{ text: m.text }] };
  if (m.role === 'assistant') {
    // Gemini 3 requires its thought signatures back, so replay the original content.
    if (m.raw) return m.raw as Content;
    const parts: Part[] = [];
    if (m.text) parts.push({ text: m.text });
    for (const c of m.toolCalls) parts.push({ functionCall: { id: sentId(c.id), name: c.name, args: c.args } });
    return { role: 'model', parts };
  }
  return {
    role: 'user',
    parts: m.results.map((r) => ({ functionResponse: { id: sentId(r.id), name: r.name, response: { result: r.result } } })),
  };
}
