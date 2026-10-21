import type { LLM, Message, StepResult, ToolSpec } from './llm.js';

/**
 * Uses the primary model and, when every model is out of quota or down,
 * answers that step with the offline model instead of failing the chat.
 * The reply's model name says so, so nobody mistakes it for the LLM.
 */
export class FallbackLLM implements LLM {
  readonly name: string;

  constructor(
    private readonly primary: LLM,
    private readonly fallback: LLM,
  ) {
    this.name = primary.name;
  }

  async step(system: string, messages: Message[], tools: ToolSpec[]): Promise<StepResult> {
    try {
      return await this.primary.step(system, messages, tools);
    } catch (e) {
      console.warn(`${this.primary.name} unavailable, using offline model: ${(e as Error).message.slice(0, 200)}`);
      const res = await this.fallback.step(system, messages, tools);
      return { ...res, model: `offline fallback (${this.primary.name} quota or outage)` };
    }
  }
}
