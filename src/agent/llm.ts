export type JsonSchema = Record<string, unknown>;

export interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export type Message =
  | { role: 'user'; text: string }
  /** `raw` keeps the provider's own message so it can be echoed back verbatim. */
  | { role: 'assistant'; text?: string; toolCalls: ToolCall[]; raw?: unknown }
  | { role: 'tool'; results: { id: string; name: string; result: unknown }[] };

export interface StepResult {
  text?: string;
  toolCalls: ToolCall[];
  raw?: unknown;
  model: string;
}

export interface LLM {
  readonly name: string;
  step(system: string, messages: Message[], tools: ToolSpec[]): Promise<StepResult>;
}
