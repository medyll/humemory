import { createHash } from 'crypto';
import { appendFile, mkdir } from 'fs/promises';
import { dirname } from 'path';
import type { MemoryType, TraceSource } from '../core/types.js';

export const SALIENCE_BANDS = ['discard', 'low', 'normal', 'high', 'exceptional'] as const;
export type SalienceBand = typeof SALIENCE_BANDS[number];

export interface MemoryAdvice {
  shouldStore: number;
  memoryType: MemoryType;
  memoryTypeConfidence: number | null;
  salienceBand: SalienceBand;
  provider: 'jev';
  /** Experimental signal only. Privacy has already been decided locally. */
  containsSensitiveMaterial?: number;
}

export interface SanitizedMemoryCandidate {
  content: string;
  currentMemoryType: MemoryType;
  source: TraceSource;
  truncated: boolean;
  redactions: Array<'path' | 'identity' | 'command_output'>;
}

export interface MemoryAdvisor {
  advise(candidate: SanitizedMemoryCandidate): Promise<MemoryAdvice>;
}

export interface AutomaticMemoryCandidate {
  content: string;
  currentMemoryType: MemoryType;
  source: TraceSource;
}

export type CandidateRejectionReason = 'source_not_allowed' | 'sensitive_material' | 'empty_after_redaction';

export type CandidateSanitization =
  | { accepted: true; hash: string; candidate: SanitizedMemoryCandidate }
  | { accepted: false; hash: string; reason: CandidateRejectionReason };

export interface SanitizeCandidateOptions {
  maxCharacters?: number;
  allowedSources?: ReadonlySet<TraceSource>;
}

const DEFAULT_ALLOWED_SOURCES: ReadonlySet<TraceSource> = new Set(['hook']);

const SENSITIVE_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\b(?:authorization|proxy-authorization)\s*[:=]\s*(?:bearer|basic)\s+\S+/i,
  /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd)\s*[:=]\s*["']?[^\s"']{8,}/i,
  /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[A-Z0-9]{16})\b/,
];

function candidateHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function redactCandidateContent(content: string): { content: string; redactions: SanitizedMemoryCandidate['redactions'] } {
  const redactions = new Set<SanitizedMemoryCandidate['redactions'][number]>();
  let sanitized = content.replace(/\r\n/g, '\n');

  sanitized = sanitized.replace(/\b[A-Za-z]:\\(?:[^\s<>:"|?*]+\\)*[^\s<>:"|?*]*/g, () => {
    redactions.add('path');
    return '<path>';
  });
  sanitized = sanitized.replace(/(?<![:\w])\/(?:Users|home|private|tmp|var|etc|opt|srv|mnt|workspace)\/[^\s'"`]+/g, () => {
    redactions.add('path');
    return '<path>';
  });
  sanitized = sanitized.replace(/\b[\w.-]+@[\w.-]+\b/g, () => {
    redactions.add('identity');
    return '<identity>';
  });
  sanitized = sanitized.replace(/\b(?:host(?:name)?|computer(?:name)?|user(?:name)?)\s*[:=]\s*[^\s,;]+/gi, (match) => {
    redactions.add('identity');
    return `${match.split(/[:=]/, 1)[0]}=<identity>`;
  });

  const lines = sanitized.split('\n');
  let suppressOutput = false;
  const kept: string[] = [];
  for (const line of lines) {
    if (/^\s*(?:stdout|stderr|command output|sortie)\s*:/i.test(line)) {
      if (!suppressOutput) kept.push('<command-output>');
      suppressOutput = true;
      redactions.add('command_output');
      continue;
    }
    if (suppressOutput && line.trim() !== '') continue;
    if (suppressOutput) suppressOutput = false;
    kept.push(line);
  }

  return {
    content: kept.join('\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim(),
    redactions: [...redactions],
  };
}

/** Local privacy gate. It always runs before an advisor can see the candidate. */
export function sanitizeMemoryCandidate(
  input: AutomaticMemoryCandidate,
  options: SanitizeCandidateOptions = {},
): CandidateSanitization {
  const hash = candidateHash(input.content);
  const allowedSources = options.allowedSources ?? DEFAULT_ALLOWED_SOURCES;
  if (!allowedSources.has(input.source)) return { accepted: false, hash, reason: 'source_not_allowed' };
  if (SENSITIVE_PATTERNS.some((pattern) => pattern.test(input.content))) {
    return { accepted: false, hash, reason: 'sensitive_material' };
  }

  const redacted = redactCandidateContent(input.content);
  if (!redacted.content) return { accepted: false, hash, reason: 'empty_after_redaction' };
  const maxCharacters = options.maxCharacters ?? 1_200;
  const truncated = redacted.content.length > maxCharacters;

  return {
    accepted: true,
    hash,
    candidate: {
      content: redacted.content.slice(0, maxCharacters),
      currentMemoryType: input.currentMemoryType,
      source: input.source,
      truncated,
      redactions: redacted.redactions,
    },
  };
}

export function salienceForBand(band: SalienceBand): number {
  return ({ discard: 0, low: 25, normal: 50, high: 75, exceptional: 100 })[band];
}

export interface ShadowDecisionRecord {
  at: string;
  mode: 'shadow';
  candidateHash: string;
  source: TraceSource;
  baseline: { shouldStore: true; memoryType: MemoryType };
  outcome: 'advised' | 'rejected' | 'failed';
  latencyMs: number;
  rejectionReason?: CandidateRejectionReason;
  errorKind?: 'provider_failure';
  advice?: MemoryAdvice & { mappedSaillance: number };
}

export type ShadowDecisionReporter = (record: ShadowDecisionRecord) => void | Promise<void>;

async function reportSafely(reporter: ShadowDecisionReporter | undefined, record: ShadowDecisionRecord): Promise<void> {
  if (!reporter) return;
  try {
    await reporter(record);
  } catch {
    // A diagnostic sink must never decide whether a memory survives.
  }
}

/**
 * Compare one automatic candidate with the advisor without changing the
 * candidate or throwing into maintenance. This is the whole shadow boundary.
 */
export async function adviseInShadow(
  input: AutomaticMemoryCandidate,
  advisor: MemoryAdvisor,
  reporter?: ShadowDecisionReporter,
  now: () => Date = () => new Date(),
): Promise<ShadowDecisionRecord> {
  const started = now().getTime();
  const sanitized = sanitizeMemoryCandidate(input);
  const base = {
    at: now().toISOString(),
    mode: 'shadow' as const,
    candidateHash: sanitized.hash,
    source: input.source,
    baseline: { shouldStore: true as const, memoryType: input.currentMemoryType },
  };

  if (!sanitized.accepted) {
    const record: ShadowDecisionRecord = {
      ...base,
      outcome: 'rejected',
      rejectionReason: sanitized.reason,
      latencyMs: Math.max(0, now().getTime() - started),
    };
    await reportSafely(reporter, record);
    return record;
  }

  try {
    const advice = await advisor.advise(sanitized.candidate);
    const record: ShadowDecisionRecord = {
      ...base,
      outcome: 'advised',
      latencyMs: Math.max(0, now().getTime() - started),
      advice: { ...advice, mappedSaillance: salienceForBand(advice.salienceBand) },
    };
    await reportSafely(reporter, record);
    return record;
  } catch {
    const record: ShadowDecisionRecord = {
      ...base,
      outcome: 'failed',
      errorKind: 'provider_failure',
      latencyMs: Math.max(0, now().getTime() - started),
    };
    await reportSafely(reporter, record);
    return record;
  }
}

export function jsonlShadowReporter(path: string): ShadowDecisionReporter {
  return async (record) => {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${JSON.stringify(record)}\n`, 'utf8');
  };
}
