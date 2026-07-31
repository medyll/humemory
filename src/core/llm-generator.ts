import Anthropic from '@anthropic-ai/sdk';
import type { MemoryType } from './types.js';

export interface GeneratedLevels {
  level1Summary: string;
  level2Essential: string;
  level3Keywords: string;
}

export interface LLMClient {
  messages: {
    create(params: any): Promise<{ content: Array<{ type: string; text?: string }> }>;
  };
}

const SYSTEM_PROMPT = `You are a memory consolidation system.
For each trace, produce 3 decay levels as strict JSON.
Write the levels in the same language as the trace itself.
Answer with a JSON object ONLY — no markdown, no explanation.`;

let _client: LLMClient | null = null;

function getClient(): LLMClient {
  if (!_client) {
    _client = new Anthropic() as unknown as LLMClient;
  }
  return _client;
}

export function setLLMClient(client: LLMClient): void {
  _client = client;
}

export async function generateMemoryLevels(
  content: string,
  memoryType: MemoryType = 'semantic',
  client?: LLMClient
): Promise<GeneratedLevels> {
  const llm = client ?? getClient();
  const typeHints: Record<MemoryType, string> = {
    episodic: 'a lived event, with its temporal and spatial context',
    semantic: 'a fact or a concept',
    procedural: 'know-how or a procedure',
  };

  const response = await llm.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      {
        role: 'user',
        content: `Memory type: ${typeHints[memoryType]}

Trace to consolidate:
"""
${content}
"""

Produce exactly this JSON:
{
  "level1Summary": "<2-3 sentences, keep the key context>",
  "level2Essential": "<1 sentence, the irreducible information>",
  "level3Keywords": "<8-12 BM25 keywords separated by spaces>"
}`,
      },
    ],
  });

  const text = response.content[0].type === 'text' ? (response.content[0].text ?? '') : '';

  try {
    const parsed = JSON.parse(text.trim());
    if (!parsed.level1Summary || !parsed.level2Essential || !parsed.level3Keywords) {
      throw new Error('Missing fields in LLM response');
    }
    return parsed as GeneratedLevels;
  } catch {
    // Fallback: extract from content if JSON parse fails
    const words = content.split(/\s+/).slice(0, 10).join(' ');
    return {
      level1Summary: content.slice(0, 300),
      level2Essential: content.slice(0, 100),
      level3Keywords: words,
    };
  }
}
