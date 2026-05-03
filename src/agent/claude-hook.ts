import { SQLiteStore } from '../store/sqlite.js';
import { parseClaudeHookPayload } from './session-parser.js';
import { extractLearnings } from './learning-extractor.js';
import type { LLMClient } from '../core/llm-generator.js';
import Anthropic from '@anthropic-ai/sdk';

export interface HookOptions {
  dbPath: string;
  directory?: string;
  maxLearnings?: number;
  client?: LLMClient;
  verbose?: boolean;
}

export interface HookResult {
  sessionId: string;
  directory: string;
  memoriesStored: number;
  learnings: string[];
}

export async function processSession(
  rawTranscript: string,
  options: HookOptions
): Promise<HookResult> {
  const directory = options.directory ?? process.cwd();
  const client = options.client ?? (new Anthropic() as unknown as LLMClient);

  const session = parseClaudeHookPayload(rawTranscript, directory);
  const learnings = await extractLearnings(session, client, options.maxLearnings ?? 5);

  if (learnings.length === 0) {
    return { sessionId: session.sessionId, directory: session.directory, memoriesStored: 0, learnings: [] };
  }

  const store = new SQLiteStore(options.dbPath);
  const stored: string[] = [];

  try {
    for (const learning of learnings) {
      await store.add({
        content: learning.content,
        directory: session.directory,
        day: new Date().toISOString().split('T')[0],
        keywords: learning.keywords,
        sessionId: session.sessionId,
        memoryType: learning.memoryType,
        level3Keywords: learning.level3Keywords,
      });
      stored.push(learning.content.slice(0, 80));
    }
  } finally {
    store.close();
  }

  return {
    sessionId: session.sessionId,
    directory: session.directory,
    memoriesStored: stored.length,
    learnings: stored,
  };
}
