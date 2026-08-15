import { existsSync } from 'fs';
import { posix, win32 } from 'path';

export type AgentSourceId =
  | 'claude-code'
  | 'codex'
  | 'kimi-code'
  | 'kimi-desktop'
  | 'opencode'
  | 'qwen-code'
  | 'mistral-vibe'
  | 'gemini-cli'
  | 'github-copilot-cli'
  | 'aider'
  | 'cursor'
  | 'windsurf';

export interface AgentSourceDefinition {
  id: AgentSourceId;
  name: string;
  vendor: string;
  commands: string[];
  /** Known local roots. Discovery only: no file below these roots is read. */
  roots: RootCandidate[];
}

type RootCandidate =
  | { base: 'home' | 'appData' | 'localAppData'; parts: string[] }
  | { base: 'env'; variable: string; parts?: string[] };

export interface DiscoveredAgentSource extends AgentSourceDefinition {
  installed: boolean;
  evidence: string[];
}

export interface DiscoveryOptions {
  homeDir?: string;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  exists?: (path: string) => boolean;
}

const home = (...parts: string[]): RootCandidate => ({ base: 'home', parts });
const appData = (...parts: string[]): RootCandidate => ({ base: 'appData', parts });
const localAppData = (...parts: string[]): RootCandidate => ({ base: 'localAppData', parts });
const envRoot = (variable: string, ...parts: string[]): RootCandidate => ({ base: 'env', variable, parts });

/**
 * Non-exhaustive catalog of local AI agent runtimes. A catalog entry means
 * "discoverable", not "its private session format is already importable".
 */
export const KNOWN_AGENT_SOURCES: readonly AgentSourceDefinition[] = [
  { id: 'claude-code', name: 'Claude Code', vendor: 'Anthropic', commands: ['claude'], roots: [home('.claude')] },
  { id: 'codex', name: 'Codex', vendor: 'OpenAI', commands: ['codex'], roots: [home('.codex')] },
  {
    id: 'kimi-code', name: 'Kimi Code', vendor: 'Moonshot AI', commands: ['kimi'],
    roots: [home('.kimi-code'), home('.kimi-work'), localAppData('kimi-code')],
  },
  {
    id: 'kimi-desktop', name: 'Kimi Desktop', vendor: 'Moonshot AI', commands: [],
    roots: [appData('kimi-desktop'), localAppData('kimi-desktop-updater')],
  },
  {
    id: 'opencode', name: 'OpenCode', vendor: 'SST', commands: ['opencode'],
    roots: [home('.opencode'), appData('opencode'), localAppData('opencode')],
  },
  {
    id: 'qwen-code', name: 'Qwen Code', vendor: 'Alibaba Cloud', commands: ['qwen'],
    roots: [envRoot('QWEN_RUNTIME_DIR'), envRoot('QWEN_HOME'), home('.qwen')],
  },
  {
    id: 'mistral-vibe', name: 'Mistral Vibe', vendor: 'Mistral AI', commands: ['vibe'],
    roots: [envRoot('VIBE_HOME'), home('.vibe')],
  },
  {
    id: 'gemini-cli', name: 'Gemini CLI', vendor: 'Google', commands: ['gemini'],
    roots: [envRoot('GEMINI_CLI_HOME', '.gemini'), home('.gemini')],
  },
  {
    id: 'github-copilot-cli', name: 'GitHub Copilot CLI', vendor: 'GitHub', commands: ['copilot'],
    roots: [home('.copilot')],
  },
  { id: 'aider', name: 'Aider', vendor: 'Aider-AI', commands: ['aider'], roots: [home('.aider.conf.yml')] },
  { id: 'cursor', name: 'Cursor', vendor: 'Anysphere', commands: ['cursor'], roots: [appData('Cursor')] },
  { id: 'windsurf', name: 'Windsurf', vendor: 'Cognition', commands: ['windsurf'], roots: [appData('Windsurf')] },
];

function resolveRoot(
  candidate: RootCandidate,
  context: { homeDir: string; env: Record<string, string | undefined>; join: (...parts: string[]) => string },
): string | null {
  let base: string | undefined;
  if (candidate.base === 'home') base = context.homeDir;
  else if (candidate.base === 'appData') base = context.env.APPDATA;
  else if (candidate.base === 'localAppData') base = context.env.LOCALAPPDATA;
  else if (candidate.base === 'env') base = context.env[candidate.variable];
  if (!base) return null;
  return context.join(base, ...(candidate.parts ?? []));
}

function executableCandidates(
  command: string,
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
  join: (...parts: string[]) => string,
): string[] {
  const separator = platform === 'win32' ? ';' : ':';
  const pathEntries = (env.PATH ?? env.Path ?? '').split(separator).filter(Boolean);
  const extensions = platform === 'win32'
    ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  return pathEntries.flatMap((entry) => extensions.map((extension) => join(entry, `${command}${extension.toLowerCase()}`)));
}

export function discoverLocalAgentSources(options: DiscoveryOptions = {}): DiscoveredAgentSource[] {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const pathApi = platform === 'win32' ? win32 : posix;
  const homeDir = options.homeDir ?? env.USERPROFILE ?? env.HOME ?? '';
  const exists = options.exists ?? existsSync;
  const join = pathApi.join;

  return KNOWN_AGENT_SOURCES.map((source) => {
    const evidence = new Set<string>();
    for (const root of source.roots) {
      const resolved = resolveRoot(root, { homeDir, env, join });
      if (resolved && exists(resolved)) evidence.add(resolved);
    }
    for (const command of source.commands) {
      const executable = executableCandidates(command, env, platform, join).find(exists);
      if (executable) evidence.add(executable);
    }
    return { ...source, installed: evidence.size > 0, evidence: [...evidence] };
  });
}
