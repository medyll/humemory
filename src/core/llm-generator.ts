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

const SYSTEM_PROMPT = `Tu es un système de consolidation mnésique.
Pour chaque trace, génère 3 niveaux de dégradation en JSON strict.
Réponds UNIQUEMENT avec un objet JSON, sans markdown, sans explication.`;

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
    episodic: 'événement vécu (contexte temporel/spatial)',
    semantic: 'connaissance factuelle ou concept',
    procedural: 'savoir-faire ou procédure',
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
        content: `Type de mémoire: ${typeHints[memoryType]}

Trace à consolider:
"""
${content}
"""

Génère exactement ce JSON:
{
  "level1Summary": "<résumé 2-3 phrases, préserve le contexte clé>",
  "level2Essential": "<1 phrase, l'information irréductible>",
  "level3Keywords": "<8-12 mots-clés BM25 séparés par des espaces>"
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
