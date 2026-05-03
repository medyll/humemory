import type { LLMClient } from '../core/llm-generator.js';
import type { MemoryType } from '../core/types.js';
import type { ParsedSession } from './session-parser.js';

export interface ExtractedLearning {
  content: string;
  memoryType: MemoryType;
  keywords: string[];
  level3Keywords: string;
}

const SYSTEM_PROMPT = `Tu es un système d'extraction d'apprentissages mnésiques.
Analyse la session et extrait les apprentissages clés à mémoriser.
Réponds UNIQUEMENT avec un tableau JSON, sans markdown.`;

export async function extractLearnings(
  session: ParsedSession,
  client: LLMClient,
  maxLearnings = 5
): Promise<ExtractedLearning[]> {
  // Truncate to avoid token limits — keep last ~3000 chars which has recent context
  const transcript = session.rawText.slice(-3000);

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
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
        content: `Projet: ${session.directory}
Session: ${session.sessionId}

Transcript:
"""
${transcript}
"""

Extrait jusqu'à ${maxLearnings} apprentissages clés (décisions techniques, bugs résolus, patterns découverts, faits importants).
Ignore les échanges triviaux ou les répétitions.

Format JSON requis:
[
  {
    "content": "description complète de l'apprentissage",
    "memoryType": "episodic|semantic|procedural",
    "keywords": ["mot1", "mot2"],
    "level3Keywords": "mots clés BM25 séparés par espaces"
  }
]`,
      },
    ],
  });

  const text = response.content[0]?.type === 'text' ? (response.content[0].text ?? '') : '';

  try {
    const parsed = JSON.parse(text.trim());
    if (!Array.isArray(parsed)) throw new Error('Expected array');

    return parsed
      .filter((item: any) => item.content && item.memoryType)
      .map((item: any) => ({
        content: String(item.content),
        memoryType: (['episodic', 'semantic', 'procedural'].includes(item.memoryType)
          ? item.memoryType
          : 'semantic') as MemoryType,
        keywords: Array.isArray(item.keywords) ? item.keywords.map(String) : [],
        level3Keywords: String(item.level3Keywords || item.keywords?.join(' ') || ''),
      }))
      .slice(0, maxLearnings);
  } catch {
    // Fallback: store the last assistant message as single episodic memory
    const lastAssistant = session.messages.filter(m => m.role === 'assistant').pop();
    if (!lastAssistant) return [];

    return [
      {
        content: lastAssistant.content.slice(0, 500),
        memoryType: 'episodic',
        keywords: [],
        level3Keywords: '',
      },
    ];
  }
}
