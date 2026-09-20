import {
  SALIENCE_BANDS,
  type MemoryAdvice,
  type MemoryAdvisor,
  type SalienceBand,
  type SanitizedMemoryCandidate,
} from './memory-advisor.js';
import type { MemoryType } from '../core/types.js';

/**
 * TypeSafe System One adapter for automatic-memory qualification.
 * Acquisition rules and privacy checks stay in `memory-advisor.ts`; this file
 * only translates a sanitized candidate to and from the provider schema.
 */
export type JevMode = 'off' | 'shadow' | 'advisory';

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface JevAdvisorOptions {
  apiKey: string;
  endpoint?: string;
  model?: string;
  /** Per-request deadline. Native fetch observes the AbortSignal below. */
  timeoutMs?: number;
  /** Test seam; production uses the runtime's native fetch. */
  fetch?: FetchLike;
}

interface JevAnswerMap {
  should_store?: { type?: unknown; noul?: unknown };
  memory_type?: { type?: unknown; choice?: unknown; confidence?: unknown };
  salience_band?: { type?: unknown; score?: unknown; confidence?: unknown };
  contains_sensitive_material?: { type?: unknown; noul?: unknown };
}

function finiteProbability(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`Malformed Jev ${name}`);
  }
  return value;
}

function memoryType(value: unknown): MemoryType {
  if (value === 'episodic' || value === 'semantic' || value === 'procedural') return value;
  throw new Error('Malformed Jev memory_type');
}

function salienceBand(value: unknown): SalienceBand {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > SALIENCE_BANDS.length - 1) {
    throw new Error('Malformed Jev salience_band');
  }
  return SALIENCE_BANDS[Math.round(value)];
}

/** HTTP implementation of the provider-neutral `MemoryAdvisor` seam. */
export class JevMemoryAdvisor implements MemoryAdvisor {
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(options: JevAdvisorOptions) {
    if (!options.apiKey.trim()) throw new Error('TYPESAFE_API_KEY is required for Jev shadow mode');
    this.apiKey = options.apiKey.trim();
    this.endpoint = options.endpoint ?? 'https://api.typesafe.ai/v1/systemone';
    this.model = options.model ?? 'jev-latest';
    this.timeoutMs = options.timeoutMs ?? 3_000;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async advise(candidate: SanitizedMemoryCandidate): Promise<MemoryAdvice> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
        },
        signal: controller.signal,
        body: JSON.stringify({
          state: {
            candidate: candidate.content,
            current_memory_type: candidate.currentMemoryType,
          },
          model: this.model,
          questions: {
            should_store: {
              type: 'noul',
              instructions: 'Should this candidate become durable memory for a future AI agent working on the same project?',
              criteria: {
                true: 'Durable decision, solved problem, reusable procedure, or stable project fact',
                false: 'Transient output, conversational filler, unverified plan, repetition, or one-off observation',
              },
            },
            memory_type: {
              type: 'choice',
              instructions: 'Which cognitive memory type best describes this candidate?',
              criteria: {
                episodic: 'A particular event or session-bound occurrence',
                semantic: 'A stable fact, rule, or concept',
                procedural: 'A reusable method, skill, or sequence of actions',
              },
            },
            salience_band: {
              type: 'score',
              instructions: 'How important is this candidate to future work on the same project?',
              criteria: [
                'Discard: no durable value',
                'Low: occasionally useful context',
                'Normal: useful project memory',
                'High: important decision or reliable procedure',
                'Exceptional: critical safety rule or foundational invariant',
              ],
            },
            contains_sensitive_material: {
              type: 'noul',
              instructions: 'Does the already-redacted candidate still appear to contain private credentials, personal identity, or confidential machine details?',
            },
          },
        }),
      });

      if (!response.ok) throw new Error(`Jev request failed with status ${response.status}`);
      const payload = await response.json() as { answers?: JevAnswerMap };
      const answers = payload.answers;
      // Do not coerce partial provider output. Throwing here becomes a
      // content-free `provider_failure` record at the shadow boundary.
      if (!answers || answers.should_store?.type !== 'noul' || answers.memory_type?.type !== 'choice'
        || answers.salience_band?.type !== 'score' || answers.contains_sensitive_material?.type !== 'noul') {
        throw new Error('Malformed Jev response');
      }

      return {
        shouldStore: finiteProbability(answers.should_store.noul, 'should_store'),
        memoryType: memoryType(answers.memory_type.choice),
        memoryTypeConfidence: finiteProbability(answers.memory_type.confidence, 'memory_type confidence'),
        salienceBand: salienceBand(answers.salience_band.score),
        provider: 'jev',
        containsSensitiveMaterial: finiteProbability(
          answers.contains_sensitive_material.noul,
          'contains_sensitive_material',
        ),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Requested mode and the narrower mode this release is allowed to execute. */
export interface ConfiguredJevAdvisor {
  requestedMode: JevMode;
  effectiveMode: 'off' | 'shadow';
  advisor?: MemoryAdvisor;
  unavailableReason?: 'missing_api_key';
}

function requestedMode(env: NodeJS.ProcessEnv): JevMode {
  const value = env.HUMEMORY_JEV_MODE?.trim().toLowerCase();
  return value === 'shadow' || value === 'advisory' ? value : 'off';
}

/** API-key presence alone is inert. Advisory is deliberately capped to shadow. */
export function resolveConfiguredJevAdvisor(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: FetchLike,
): ConfiguredJevAdvisor {
  const requested = requestedMode(env);
  if (requested === 'off') return { requestedMode: requested, effectiveMode: 'off' };
  const apiKey = env.TYPESAFE_API_KEY?.trim();
  if (!apiKey) {
    return {
      requestedMode: requested,
      effectiveMode: 'shadow',
      unavailableReason: 'missing_api_key',
    };
  }
  return {
    requestedMode: requested,
    effectiveMode: 'shadow',
    advisor: new JevMemoryAdvisor({
      apiKey,
      model: env.HUMEMORY_JEV_MODEL?.trim() || 'jev-latest',
      timeoutMs: Number(env.HUMEMORY_JEV_TIMEOUT_MS ?? 3_000),
      fetch: fetchImpl,
    }),
  };
}
