import { anthropicClient } from './anthropic';
import { openaiClient } from './openai';
import { geminiClient } from './gemini';
import type {
  LlmClient,
  LlmProvider,
  LlmToolCall,
  LlmTurn,
  ToolExecutor,
} from './types';

/** Resolve the LLM client for a provider. */
export function createProvider(provider: LlmProvider): LlmClient {
  switch (provider) {
    case 'anthropic':
      return anthropicClient;
    case 'openai':
      return openaiClient;
    case 'gemini':
      return geminiClient;
    default:
      throw new Error(`Unknown LLM provider: ${provider as string}`);
  }
}

export interface RunChatInput {
  system: string;
  model: string;
  apiKey: string;
  messages: LlmTurn[];
}

export interface RunChatResult {
  text: string;
  steps: number;
}

export interface RunChatCallbacks {
  /** Streamed text chunks from the model as they arrive. */
  onDelta?: (text: string) => void;
  /** Fired when the model invokes a tool. */
  onToolCall?: (call: LlmToolCall) => void;
}

/**
 * Agentic loop: stream a model turn; if it asks for tools, execute them, feed the
 * results back, and repeat until it produces a final text answer (or hits
 * maxSteps). Provider-agnostic — works for any LlmClient.
 */
export async function runChat(
  client: LlmClient,
  input: RunChatInput,
  executor: ToolExecutor,
  callbacks: RunChatCallbacks = {},
  maxSteps = 6
): Promise<RunChatResult> {
  const messages: LlmTurn[] = [...input.messages];
  const tools = executor.list();

  for (let step = 1; step <= maxSteps; step++) {
    const reply = await client.chatStream(
      {
        system: input.system,
        model: input.model,
        apiKey: input.apiKey,
        tools,
        messages,
      },
      (delta) => callbacks.onDelta?.(delta)
    );

    if (reply.toolCalls && reply.toolCalls.length > 0) {
      messages.push({ role: 'assistant', text: reply.text, toolCalls: reply.toolCalls });
      const results = [];
      for (const call of reply.toolCalls) {
        callbacks.onToolCall?.(call);
        try {
          results.push({ id: call.id, name: call.name, content: await executor.execute(call.name, call.args) });
        } catch (e) {
          results.push({
            id: call.id,
            name: call.name,
            content: e instanceof Error ? e.message : String(e),
            isError: true,
          });
        }
      }
      messages.push({ role: 'tool', results });
      continue;
    }

    return { text: reply.text ?? '', steps: step };
  }

  return { text: 'Stopped after reaching the tool-call limit without a final answer.', steps: maxSteps };
}
