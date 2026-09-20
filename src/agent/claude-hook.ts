import { SQLiteStore } from '../store/sqlite.js';
import { lastMessageTime, parseAgentSession, type ParsedSession } from './session-parser.js';
import { extractLearnings, extractLearningsDeterministic } from './learning-extractor.js';
import type { LLMClient } from '../core/llm-generator.js';
import type { TraceSource } from '../core/types.js';
import {
  adviseInShadow,
  type MemoryAdvisor,
  type ShadowDecisionReporter,
} from './memory-advisor.js';

export interface HookOptions {
  dbPath: string;
  directory?: string;
  maxLearnings?: number;
  client?: LLMClient;
  llmTimeoutMs?: number;
  source?: TraceSource;
  agent?: string;
  /** Optional automatic-candidate advisor. It is observational in this release. */
  memoryAdvisor?: MemoryAdvisor;
  /** Receives content-free comparisons; reporter failures never block storage. */
  advisorReporter?: ShadowDecisionReporter;
  /**
   * Number of leading transcript messages already encoded for this session.
   * `Stop` fires once per turn and resends the whole transcript, so without a
   * checkpoint every pass would re-encode the entire history as new memories.
   */
  sinceMessage?: number;
  verbose?: boolean;
}

export interface HookResult {
  sessionId: string;
  directory: string;
  memoriesStored: number;
  learnings: string[];
  extractionMode: 'llm' | 'deterministic';
  /** Candidates inspected in shadow mode, including local privacy rejections. */
  advisorComparisons: number;
  /** Total messages in the transcript — the checkpoint to persist after success. */
  messagesSeen: number;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`maintenance model timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function processSession(
  rawTranscript: string,
  options: HookOptions
): Promise<HookResult> {
  const directory = options.directory ?? process.cwd();
  const session = parseAgentSession(rawTranscript, directory);
  const maxLearnings = options.maxLearnings ?? 5;
  const messagesSeen = session.messages.length;

  // Only the messages added since the last successful pass are candidates.
  const since = Math.max(0, Math.min(options.sinceMessage ?? 0, messagesSeen));
  const pending = session.messages.slice(since);
  if (pending.length === 0) {
    return {
      sessionId: session.sessionId, directory: session.directory,
      memoriesStored: 0, learnings: [], extractionMode: 'deterministic', advisorComparisons: 0, messagesSeen,
    };
  }
  const scoped: ParsedSession = {
    ...session,
    messages: pending,
    rawText: pending.map((m) => `${m.role}: ${m.content}`).join('\n\n'),
  };

  let extractionMode: HookResult['extractionMode'] = 'deterministic';
  let learnings = extractLearningsDeterministic(scoped, maxLearnings);
  if (options.client) {
    try {
      learnings = await withTimeout(
        extractLearnings(scoped, options.client, maxLearnings),
        options.llmTimeoutMs ?? 8_000,
      );
      extractionMode = 'llm';
    } catch {
      // Quota, network, timeout: the deterministic path already produced a result.
    }
  }

  if (learnings.length === 0) {
    return {
      sessionId: session.sessionId, directory: session.directory, memoriesStored: 0,
      learnings: [], extractionMode, advisorComparisons: 0, messagesSeen,
    };
  }

  const source = options.source ?? 'agent';
  let advisorComparisons = 0;
  if (options.memoryAdvisor) {
    // Advice is recorded before storage, but its value is intentionally ignored.
    // `adviseInShadow` contains provider and reporter failures, so every learning
    // below follows the same storage path it used before Jev existed.
    for (const learning of learnings) {
      await adviseInShadow({
        content: learning.content,
        currentMemoryType: learning.memoryType,
        source,
      }, options.memoryAdvisor, options.advisorReporter);
      advisorComparisons += 1;
    }
  }

  // What is encoded belongs to the day the session ran, not the day it was
  // read: a rollout sweep runs long after the fact, and dating every trace on
  // the sweep collapses the timeline into a single import day.
  const occurredAt = lastMessageTime(pending) ?? session.occurredAt ?? new Date();

  const store = new SQLiteStore(options.dbPath);
  const stored: string[] = [];

  try {
    for (const learning of learnings) {
      await store.add({
        content: learning.content,
        directory: session.directory,
        day: occurredAt.toISOString().split('T')[0],
        createdAt: occurredAt,
        keywords: learning.keywords,
        sessionId: session.sessionId,
        memoryType: learning.memoryType,
        level3Keywords: learning.level3Keywords,
        source,
        agent: options.agent ?? 'unknown',
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
    extractionMode,
    advisorComparisons,
    messagesSeen,
  };
}
