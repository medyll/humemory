# HTTP transport + OAuth for the humemory MCP server

Status: **design note, not a plan of record.** Nothing here is scheduled. It exists
so the multi-user / multi-machine target does not get designed by accident, one
convenient shortcut at a time.

Colocated with [`server.ts`](./server.ts) because it is about that file.

---

## 1. What the protocol actually offers

MCP defines two transports. That is the whole menu.

| | **stdio** | **Streamable HTTP** |
|---|---|---|
| Process model | one server process per client, spawned by the client | one server, N clients |
| Identity | the process environment (`env` in the client's MCP config) | the HTTP layer — i.e. OAuth, or nothing |
| Auth | none needed; the OS already isolated you | OAuth 2.1, server acts as a **resource server** |
| Session | implicit (= the process lifetime) | explicit, `Mcp-Session-Id` header |
| Reach | local machine only | anywhere |

The old HTTP+SSE transport (two endpoints, `/sse` + `/messages`) is **deprecated**.
Do not implement it. Streamable HTTP is a single endpoint that handles `POST`,
`GET` and `DELETE`, with the server free to answer a POST either as one JSON
response or as an SSE stream.

Key mechanics of Streamable HTTP, since they drive the design below:

- One route, three methods. `POST /mcp` carries JSON-RPC in; `GET /mcp` opens the
  server→client notification stream; `DELETE /mcp` ends the session.
- `POST` requests must send `Content-Type: application/json` and an `Accept`
  containing **both** `application/json` and `text/event-stream`. The transport
  rejects anything else with 415 / 406.
- Sessions are a transport concern. Pass `sessionIdGenerator` to create one; the
  id then rides on the `Mcp-Session-Id` response header, and the client echoes it
  on every subsequent request. Omit `sessionIdGenerator` and the server is
  stateless (each POST fully self-contained).
- `OPTIONS` is *not* handled by the transport — it returns 405. CORS preflight is
  the framework's job (Hono's `cors()` middleware, already mounted in
  `src/api/server.ts`).

---

## 2. Why humemory can't just flip the switch

### 2.1 The identity problem — this is the real blocker

Read the header of [`server.ts`](./server.ts) before anything else. The current
design is deliberate:

```ts
const callingAgent = process.env.HUMEMORY_AGENT ?? 'unknown';
```

`callingAgent` is a **module-level constant**, sourced from the process
environment, never from a tool argument. The rationale, verbatim from the file:
the model filling in its own name is a claim, and in an injection scenario the
model is precisely the untrusted party. stdio gives a real identity per process.

Everything downstream leans on that:

- `humemory_recall` passes `{ identityTrusted: true }` to `store.recall()`. That
  flag is what makes a cross-agent recall count as **evidence** rather than a
  self-assertion, and it is what earns the `reused` verification
  (`VerificationReason` in `src/core/types.ts`).
- The trust layer (`src/core/trust.ts`) and the dreamer's cross-agent recurrence
  mining both consume that verification.

Move to HTTP with a shared process and `callingAgent` becomes a constant across
all callers. `identityTrusted: true` becomes a lie told at every call site. The
trust layer does not break loudly — it degrades silently into noise, which is
worse.

**Therefore: OAuth is not an optional add-on to HTTP transport here. It is the
thing that restores the invariant HTTP breaks.** Ship them together or not at
all. If you ever need a staging shortcut, make the shortcut explicit — see §6.

### 2.2 The tenancy problem

There is no `userId`, `tenantId`, `ownerId` or `workspace` anywhere in `src/`
(grep returns zero). `Memory`, `Intention`, `Cue`, `Script`, `DreamProposal` are
all scoped by `directory` (the "lieu mental") and nothing else. `directory` is a
filesystem path on *someone's* machine — meaningless as an isolation boundary
across users, and actively misleading across machines where two people both have
`D:\dev\api`.

Multi-user means a schema migration and a store-level scope that cannot be
forgotten. That is a bigger job than the transport itself.

### 2.3 The store problem

`SQLiteStore` is a single local file with WAL plus a file-based `AdvisoryLock`
for cross-process writes. That design assumes *one filesystem*. Multi-machine
means either a network-reachable server owning the only SQLite file (fine — the
lock becomes unnecessary, the write queue does the work) or a different store
backend. The first is much cheaper and should be the default assumption.

---

## 3. Target shape

```
              ┌────────────────────────────────────────────┐
   Claude ────┤  POST/GET/DELETE  /mcp                     │
   Codex  ────┤    ├─ Bearer token (OAuth 2.1)             │
   Kimi   ────┤    ├─ resolve subject → agentIdentity      │
              │    └─ StreamableHTTPServerTransport        │
              │         └─ McpServer (per session)         │
              │              └─ tools, scoped by tenant    │
              ├────────────────────────────────────────────┤
              │  GET /.well-known/oauth-protected-resource │
              ├────────────────────────────────────────────┤
              │  existing Hono API (:3456), dashboard      │
              └──────────────────┬─────────────────────────┘
                                 │
                          SQLiteStore (single owner)
```

One process. The MCP endpoint mounts on the **existing Hono app** in
`src/api/server.ts` rather than standing up a second server — same port, same
CORS policy, same store instance, one thing to deploy.

---

## 4. Implementation paths

Four steps, in dependency order. Each is independently shippable and independently
testable. Do not reorder — step 2 before step 1 is exactly the silent-degradation
failure of §2.1.

### Step 0 — prerequisite: make `callingAgent` a parameter

Pure refactor, no behaviour change, doable today, and it is the whole reason the
rest is tractable.

Today `server.ts` is a top-level script: it builds one `McpServer`, closes over
`callingAgent`, and connects a `StdioServerTransport` at module scope.

Change to a factory:

```ts
export interface CallerIdentity {
  /** Agent name — 'claude', 'codex'. Trusted: derived from env or a token, never from a tool arg. */
  agent: string;
  /** Null until §4.3 lands. Once non-null, every store call must be scoped by it. */
  tenantId: string | null;
}

export function createHumemoryServer(store: MemoryStore, caller: CallerIdentity): McpServer {
  // ... the six registerTool calls, reading `caller.agent` instead of the const
}
```

Then `src/mcp/stdio.ts` becomes the four-line entry point that `pnpm mcp` runs:

```ts
const store = new SQLiteStore(process.env.HUMEMORY_DB);
const server = createHumemoryServer(store, {
  agent: process.env.HUMEMORY_AGENT ?? 'unknown',
  tenantId: null,
});
await server.connect(new StdioServerTransport());
```

Nothing else changes. `tests/mcp.test.ts` gets easier — it can build a server
against a temp-file store with an explicit identity, no env juggling, which is
what `docs/TESTING.md` demands anyway.

**Do this step whether or not HTTP ever ships.** It is a strict improvement.

### Step 1 — Streamable HTTP transport, localhost only, still one identity

Goal: prove the transport works, before touching auth. Bind to `127.0.0.1`, keep
`HUMEMORY_AGENT` from the env, and **refuse to start on a non-loopback bind
without step 2**. Explicit guard, not a comment:

```ts
if (bindHost !== '127.0.0.1' && !oauthEnabled) {
  throw new Error('MCP over HTTP on a non-loopback address requires OAuth (see src/mcp/HTTP_TRANSPORT.md §2.1)');
}
```

Session routing, mounted on the existing Hono app. One transport per session, one
`McpServer` per transport:

```ts
const sessions = new Map<string, StreamableHTTPServerTransport>();

async function handleMcp(c: Context) {
  const sessionId = c.req.header('mcp-session-id');
  const body = c.req.method === 'POST' ? await c.req.json() : undefined;

  if (sessionId && sessions.has(sessionId)) {
    return sessions.get(sessionId)!.handleRequest(c.req.raw, body);
  }
  if (!sessionId && isInitializeRequest(body)) {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => sessions.set(id, transport),
    });
    transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); };
    await createHumemoryServer(store, callerFor(c)).connect(transport);
    return transport.handleRequest(c.req.raw, body);
  }
  // unknown session → 404 -32001; no session on a non-init request → 400 -32000
}

app.post('/mcp', handleMcp);
app.get('/mcp', handleMcp);
app.delete('/mcp', handleMcp);
```

Watch out for:

- **Hono's runtime.** The SDK's Node transport wants `IncomingMessage`/
  `ServerResponse`; the Fetch-API transport wants a `Request`. The project runs
  under bun but serves via `@hono/node-server`, so check which surface the
  installed `@modelcontextprotocol/sdk` (^1.30) exposes before writing the glue.
  If only the Node flavour exists, mount the MCP route with
  `@hono/node-server`'s raw handle rather than fighting the adapter.
- **CORS.** The existing policy allows credentialed localhost origins. An MCP
  endpoint reachable from a browser origin is a DNS-rebinding target. Give `/mcp`
  its own stricter CORS (no `*`, explicit allowlist) and validate the `Origin`
  header — do not inherit the dashboard's policy.
- **Session memory.** `sessions` is an unbounded `Map`. Add a TTL sweep; a client
  that dies without `DELETE` leaks a transport and an `McpServer` forever.

At the end of this step you have a working remote MCP server that is only safe on
loopback. Do not deploy it. Go to step 2.

### Step 2 — OAuth 2.1, server as resource server

The spec's requirements, non-negotiable:

- The MCP server is an **OAuth 2.1 resource server**, not an authorization
  server. Do not write an auth server. Use an existing IdP.
- It **must** implement OAuth 2.0 Protected Resource Metadata —
  `GET /.well-known/oauth-protected-resource` — pointing at the authorization
  server. This is how clients discover where to authenticate.
- It **must** validate that the token's audience is this server, and reject
  tokens issued for anyone else. Rejecting on signature alone is not enough — a
  valid token for a *different* resource is a confused-deputy attack.
- On a missing or invalid token, return `401` with a `WWW-Authenticate` header
  carrying the metadata URL:

  ```http
  HTTP/1.1 401 Unauthorized
  WWW-Authenticate: Bearer resource_metadata="https://mem.example.com/.well-known/oauth-protected-resource",
                           scope="humemory:read"
  ```

  Insufficient scope is `403` with `error="insufficient_scope"`, not `401`.
- Never forward a received token upstream. If humemory ever calls an upstream API
  on the user's behalf, it obtains its own token.

Then the payoff — `callerFor(c)` becomes real:

```ts
function callerFor(c: Context): CallerIdentity {
  const claims = c.get('tokenClaims');          // set by the auth middleware
  return {
    agent: claims.client_id,   // which agent app — the OAuth client, not a self-report
    tenantId: claims.sub,      // which human
  };
}
```

`agent` now comes from the OAuth client identity and `tenantId` from the token
subject. Both are attested by the IdP. `{ identityTrusted: true }` in
`humemory_recall` is honest again, and it means something *stronger* than the
stdio version: cross-agent recall is now cross-agent *within one user*, which is
exactly the signal the dreamer wants.

Scopes worth defining early, mapped to the six tools:

| scope | tools |
|---|---|
| `humemory:read` | `humemory_search`, `humemory_recall`, `humemory_dreams` |
| `humemory:write` | `humemory_add`, `humemory_intent_add`, `humemory_intent_close` |

Split read/write from day one. Widening a scope later is easy; narrowing one
breaks every issued token.

### Step 3 — tenancy in the store

The largest step, and the one with a migration.

1. Add `tenantId TEXT NOT NULL` to `memories`, `intentions`, `cues`, `scripts`,
   `dream_proposals`. Backfill existing rows with a single `'local'` tenant.
2. Index every table on `(tenantId, directory)` — the current `directory` indexes
   become the wrong shape the moment a second tenant exists.
3. Make the scope impossible to forget. Do **not** add an optional `tenantId` to
   every `MemoryStore` method — someone will omit it and read another user's
   memories. Either:
   - **(a) Scoped store wrapper** — `store.forTenant(id)` returns a façade whose
     methods inject the predicate. The MCP session holds the façade and cannot
     reach the raw store. Cheap, type-safe, recommended.
   - **(b) Required parameter** on every method. Verbose, touches every call
     site (CLI, API, hooks, dreamer, maintenance worker), but the compiler
     enforces it.

   (a) is the better trade here — the CLI and hooks keep using the unscoped store
   with an implicit `'local'` tenant, so single-user local use is untouched.
4. Audit the cross-cutting jobs: the dreamer, the decay sweep, `scripts/
   maintenance-worker.ts` and `pnpm consolidate` all iterate over everything.
   Decay is per-trace and tenant-agnostic — fine. **Merging, contradiction
   detection and dream mining are not**: they correlate traces across rows, and
   must never correlate across tenants. That is a data-leak bug, not a
   correctness nit.
5. Tests, per `docs/TESTING.md`: a two-tenant fixture where tenant A's search,
   recall, dream list and contradiction set never surface tenant B's rows. This
   suite is the one that justifies the whole step.

---

## 5. Testing

The `docs/TESTING.md` constraints hold — hermetic, deterministic, network-free,
never touching `data/humemory.db`, injected clock, stubbed `LLMClient`.

Additions for this work:

- **Transport tests** use an in-process client over an ephemeral port; no fixed
  `:3456`, tests must be able to run in parallel.
- **Token validation tests** use a locally-generated key pair and hand-minted
  JWTs. No live IdP, no network. Cases that must fail: expired, wrong audience,
  wrong issuer, bad signature, missing scope, `none` algorithm.
- **Tenancy isolation** as in §4.3 step 5 — the load-bearing suite.
- **Session lifecycle**: init → tool call → `DELETE` → the id is gone from
  `sessions`; and TTL expiry evicts an abandoned session.

---

## 6. Decision record

- Streamable HTTP, single endpoint. Never the deprecated HTTP+SSE pair.
- The MCP route mounts on the existing Hono app, not a second server.
- HTTP and OAuth ship together. A non-loopback bind without OAuth is a startup
  error, not a warning — see the guard in §4.2.
- humemory is a resource server. It does not become an authorization server.
- stdio remains the default and the local path. `pnpm mcp` keeps working with
  zero config, forever. HTTP is opt-in.
- Step 0 (identity as a parameter) is worth doing on its own merits, now.

## 7. Open questions

- Which IdP? Self-hosted (Keycloak, Ory Hydra, Zitadel) vs hosted (Auth0,
  Clerk, WorkOS). Drives whether Dynamic Client Registration is available, which
  in turn decides how painful it is for an arbitrary MCP client to connect.
- Is `directory` still meaningful across machines, or does a tenant need an
  explicit project/workspace entity that `directory` merely maps into? Leaning
  toward: `directory` stays as a local hint, a new `workspace` becomes the real
  conceptual scope. That is a Phase-level decision, not a transport one.
- Does the dashboard (`public/`, `web/`) get the same auth, or stay local-only?
  Two auth models in one process is a maintenance cost worth avoiding.
- Embeddings and the LLM generator run server-side. Multi-tenant means someone's
  Anthropic key pays for everyone's summaries — needs a quota story before this
  is a product.
