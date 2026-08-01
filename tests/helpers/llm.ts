import { setLLMClient, type LLMClient, type GeneratedLevels } from '../../src/core/llm-generator.js';

export interface StubLLMOptions {
  /** Levels returned. Derived from the prompt by default, so they stay meaningful. */
  levels?: Partial<GeneratedLevels>;
  /** Forces an error — to exercise the fallback paths. */
  fail?: Error;
}

/**
 * Deterministic LLM client, shaped like an Anthropic one (`messages.create`
 * returning a JSON text block), which is what `generateMemoryLevels` expects.
 *
 * No test may instantiate a real client: CI runs without `ANTHROPIC_API_KEY`, and
 * a network call is a bug (docs/TESTING.md → pillar 3).
 */
export function stubLLMClient(options: StubLLMOptions = {}): LLMClient & { calls: any[] } {
  const calls: any[] = [];
  return {
    calls,
    messages: {
      async create(params: any) {
        calls.push(params);
        if (options.fail) throw options.fail;

        // The trace content is the last user message.
        const prompt: string = params?.messages?.at(-1)?.content ?? '';
        const words = String(prompt).split(/\s+/).filter(Boolean);

        const levels: GeneratedLevels = {
          level1Summary: options.levels?.level1Summary ?? `summary: ${words.slice(0, 8).join(' ')}`,
          level2Essential: options.levels?.level2Essential ?? `gist: ${words.slice(0, 3).join(' ')}`,
          level3Keywords: options.levels?.level3Keywords ?? words.slice(0, 3).join(', '),
        };

        return { content: [{ type: 'text', text: JSON.stringify(levels) }] };
      },
    },
  };
}

/** Installs the stub globally. Call it from a `beforeEach`. */
export function useStubLLM(options?: StubLLMOptions) {
  const client = stubLLMClient(options);
  setLLMClient(client);
  return client;
}
