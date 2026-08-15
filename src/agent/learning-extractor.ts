import type { LLMClient } from '../core/llm-generator.js';
import type { MemoryType } from '../core/types.js';
import type { ParsedSession } from './session-parser.js';

export interface ExtractedLearning {
  content: string;
  memoryType: MemoryType;
  keywords: string[];
  level3Keywords: string;
}

const STOP_WORDS = new Set([
  'about', 'after', 'again', 'avec', 'cette', 'dans', 'elle', 'from', 'have', 'mais',
  'pour', 'that', 'this', 'tout', 'une', 'with', 'your', 'être', 'plus', 'then', 'when',
]);

function deterministicKeywords(content: string): string[] {
  const words = content
    .toLocaleLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .match(/[a-z0-9_-]{4,}/g) ?? [];
  return [...new Set(words.filter((word) => !STOP_WORDS.has(word)))].slice(0, 8);
}

/** Fast, network-free baseline used whenever no maintenance model is available. */
export function extractLearningsDeterministic(
  session: ParsedSession,
  maxLearnings = 5,
): ExtractedLearning[] {
  const unique = new Set<string>();
  const candidates = session.messages
    .filter((message) => message.role === 'assistant')
    .map((message) => message.content.trim())
    .filter((content) => content.length >= 40)
    .filter((content) => {
      const key = content.replace(/\s+/g, ' ').toLocaleLowerCase();
      if (unique.has(key)) return false;
      unique.add(key);
      return true;
    })
    .slice(-maxLearnings);

  return candidates.map((content) => {
    const clipped = content.slice(0, 1_000);
    const keywords = deterministicKeywords(clipped);
    const procedural = /\b(fix(?:ed)?|implement(?:ed)?|add(?:ed)?|use|run|step|corrig|ajout|remplac|configur)/i.test(clipped);
    return {
      content: clipped,
      memoryType: procedural ? 'procedural' : 'episodic',
      keywords,
      level3Keywords: keywords.join(' '),
    };
  });
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
    return extractLearningsDeterministic(session, 1)
      .map((learning) => ({ ...learning, memoryType: 'episodic' }));
  }
}
