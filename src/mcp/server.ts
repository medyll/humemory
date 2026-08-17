/**
 * MCP server — Phase 6.2.
 *
 * Exposes the shared humemory store over the Model Context Protocol so any
 * MCP-capable agent (Claude, Codex, Kimi, OpenCode) encodes, searches and
 * recalls against the SAME database, with the same decay curve — one unified
 * memory instead of one memory per tool.
 *
 * Attribution: every write path carries the calling agent, taken from
 * `$HUMEMORY_AGENT` in this process's environment — set by the client's MCP
 * config, one server process per client. It is deliberately NOT a tool
 * argument: the model filling in its own name is a claim, and in an injection
 * scenario the model is precisely the untrusted party. stdio gives us a real
 * identity per process; using it is the whole point of doing attribution at
 * this boundary.
 *
 * That identity feeds the Phase 6.0.1 trust layer: cross-agent recall earns
 * the `reused` verification, cross-agent recurrence feeds the dreamer.
 *
 * Run: `pnpm mcp` (stdio transport — register it in the client's MCP config).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { SQLiteStore } from '../store/sqlite.js';
import { trustScore } from '../core/trust.js';
import { sanitizeTrace, wrapUntrusted } from '../core/sanitize.js';

const store = new SQLiteStore(process.env.HUMEMORY_DB);

/**
 * This process's agent identity. Not overridable per call — see the header.
 * Register one server per agent in the client's MCP config:
 *   { "humemory": { "command": "bun", "args": ["run", "src/mcp/server.ts"],
 *                   "env": { "HUMEMORY_AGENT": "claude" } } }
 */
const callingAgent = process.env.HUMEMORY_AGENT ?? 'unknown';

const server = new McpServer({
  name: 'humemory',
  version: '6.2.0',
});

/** Renders a memory for tool output — sanitized, never raw prompt material. */
function show(m: any): string {
  const trust = trustScore(m);
  const text = sanitizeTrace(m.content, 300).text;
  return [
    `id: ${m.id}`,
    `level: L${m.currentLevel} · saillance: ${m.saillance} · trust: ${trust}`,
    `source: ${m.source ?? 'agent'}${m.agent ? ` (${m.agent})` : ''}${m.verified ? ` · verified:${m.verificationReason}` : ''}`,
    `content: ${text}`,
  ].join('\n');
}

server.registerTool(
  'humemory_add',
  {
    description: 'Encode a new memory trace (decision, bug fix, lesson learned) into the shared store',
    inputSchema: {
      content: z.string().describe('What to remember'),
      directory: z.string().optional().describe('Project path (defaults to cwd)'),
      keywords: z.array(z.string()).optional(),
      memoryType: z.enum(['episodic', 'semantic', 'procedural']).optional(),
    },
  },
  async ({ content, directory, keywords, memoryType }) => {
    const m = await store.add({
      content,
      directory: directory ?? process.cwd(),
      day: new Date().toISOString().split('T')[0],
      keywords: keywords ?? [],
      sessionId: 'mcp',
      memoryType: memoryType ?? 'semantic',
      source: 'agent',
      agent: callingAgent,
    });
    return { content: [{ type: 'text', text: `encoded:\n${show(m)}` }] };
  }
);

server.registerTool(
  'humemory_search',
  {
    description: 'Inverse search — degraded layers first, like a human memory',
    inputSchema: {
      query: z.string(),
      directory: z.string().optional(),
      limit: z.number().optional(),
    },
  },
  async ({ query, directory, limit }) => {
    const results = await store.search({ query, directory, limit: limit ?? 5 });
    if (!results.length) return { content: [{ type: 'text', text: 'no trace' }] };
    return {
      content: [
        {
          type: 'text',
          text: results.map((r) => `match@L${r.matchLevel} score ${r.score}\n${show(r.memory)}`).join('\n---\n'),
        },
      ],
    };
  }
);

server.registerTool(
  'humemory_recall',
  {
    description: 'Recall a trace — reinforces it; a cross-agent recall earns the `reused` verification',
    inputSchema: {
      id: z.string(),
    },
  },
  async ({ id }) => {
    // identityTrusted: this agent id came from the process environment, not
    // from the caller — so a cross-agent recall here is evidence, not a claim.
    const m = await store.recall(id, callingAgent, { identityTrusted: true });
    return { content: [{ type: 'text', text: `recalled:\n${show(m)}` }] };
  }
);

server.registerTool(
  'humemory_intent_add',
  {
    description: 'Arm an open loop (prospective memory) with an optional time/event cue',
    inputSchema: {
      content: z.string(),
      directory: z.string().optional(),
      cron: z.string().optional().describe('5-field cron, e.g. "0 9 * * 1"'),
      at: z.string().optional().describe('ISO datetime for a one-shot cue'),
    },
  },
  async ({ content, directory, cron, at }) => {
    const cues = [];
    if (cron) cues.push({ kind: 'time' as const, cron });
    else if (at) cues.push({ kind: 'time' as const, at });
    const i = await store.addIntention(
      {
        content,
        directory: directory ?? process.cwd(),
        source: 'agent',
        agent: callingAgent,
      },
      cues
    );
    // Echoes the caller's own content back into the tool result, which lands
    // in the agent's context like any other tool output — sanitized the same
    // way a recalled trace would be (SECURITY_AUDIT.md H-03).
    const s = sanitizeTrace(i.content);
    return { content: [{ type: 'text', text: `loop armed: ${i.id}\n${s.text}` }] };
  }
);

server.registerTool(
  'humemory_intent_close',
  {
    description: 'Close an open loop by id (or short loop-XXXX id)',
    inputSchema: { id: z.string() },
  },
  async ({ id }) => {
    let target = await store.getIntention(id);
    if (!target) {
      const armed = await store.listIntentions({ status: ['armed', 'fired'], limit: 500 });
      const { matchIntentionByShortId } = await import('../core/cues.js');
      target = matchIntentionByShortId(armed, id.replace(/^loop-/, '')) ?? null;
    }
    if (!target) return { content: [{ type: 'text', text: `no open loop matches ${id}` }] };
    await store.updateIntentionStatus(target.id, 'closed', {});
    return { content: [{ type: 'text', text: `closed: ${target.id}\n${target.content}` }] };
  }
);

server.registerTool(
  'humemory_dreams',
  {
    description: 'List pending dream proposals (cross-session patterns awaiting human review)',
    inputSchema: {},
  },
  async () => {
    const pending = await store.listDreamProposals({ status: 'pending' });
    if (!pending.length) return { content: [{ type: 'text', text: 'no dream pending' }] };
    // Dream proposals are synthesized cross-session patterns, never
    // human-verified at this stage — wrapped like any other unverified
    // recalled content (SECURITY_AUDIT.md H-03), not returned raw.
    return {
      content: [
        {
          type: 'text',
          text: pending
            .map((p) => {
              const s = sanitizeTrace(p.payload.slice(0, 400));
              return `[${p.kind}] ${p.id} — confidence ${p.confidence}\n${wrapUntrusted(s.text, { id: p.id })}`;
            })
            .join('\n---\n'),
        },
      ],
    };
  }
);

await server.connect(new StdioServerTransport());
