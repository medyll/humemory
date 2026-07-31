import type { LLMClient } from '../core/llm-generator.js';
import type { MemoryType } from '../core/types.js';
import type { ParsedSession } from './session-parser.js';

export interface ExtractedLearning {
  content: string;
  memoryType: MemoryType;
  keywords: string[];
  level3Keywords: string;
}

const SYSTEM_PROMPT = `You are a system that extracts mnemonic learnings.
Analyse the session and extract the key learnings worth remembering.
Write them in the same language as the session itself.
Answer with a JSON array ONLY — no markdown.`;

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

Extract up to ${maxLearnings} key learnings (technical decisions, bugs solved, patterns discovered, important facts).
Skip trivial exchanges and repetitions.

Format JSON requis:
[
  {
    "content": "full description of the learning",
    "memoryType": "episodic|semantic|procedural",
    "keywords": ["mot1", "mot2"],
    "level3Keywords": "BM25 keywords separated by spaces"
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
