# Jev integration recommendation

Status: shadow-only implementation shipped locally on 2026-09-20. Jev remains outside the cognitive core until shadow results justify a narrowly scoped role.

Implementation map:

- `src/agent/memory-advisor.ts` owns the injected contract, local privacy gate, salience-band mapping, fail-open shadow comparison, and content-free JSONL records;
- `src/agent/jev-advisor.ts` owns the TypeSafe HTTP adapter and strict response validation;
- `processSession` invokes the advisor only for automatic `hook` candidates and always stores the existing candidate unchanged;
- `data/jev-shadow.jsonl` (next to the resolved database) receives hashes and decision metadata only;
- `tests/fixtures/jev-candidates.json` is the human-labelled evaluation corpus;
- `pnpm probe:jev` is the explicit live synthetic probe and is never part of `pnpm test`.

`HUMEMORY_JEV_MODE=advisory` is intentionally capped to effective `shadow` behavior in this implementation. It cannot alter storage until the activation gates below are satisfied in a later change.

## Blocking prerequisite: resolve the Kimi experiments

As of 2026-09-20, this worktree contains uncommitted maintenance and Kimi adapter experiments, including changes around `src/agent/maintenance-runner.ts` and new Kimi client files. Treat their resolution as Session 0. Jev implementation must not start while their ownership and outcome remain ambiguous.

Session 0 must:

1. Capture the exact worktree status and inspect every Kimi-related diff without changing it.
2. Map each modified or new file to the experiment it belongs to, its entry point, and its tests.
3. Run the relevant network-free tests and any explicit live trial already provided by the experiment; record the commands, results, and unresolved failures.
4. Choose and execute one durable outcome for the whole experiment: integrate and commit the accepted work, or park it intact on a named branch/worktree. Discarding any part requires explicit user authorization after the evidence review.
5. Leave a short resolution note with the chosen outcome, commit or branch reference, test evidence, and any remaining debt.

The Kimi work counts as resolved only when every changed file has an owner and outcome, the evidence is recorded, and the Jev session can edit its intended seam without overlapping anonymous work. Do not fold Kimi changes into a Jev commit.

## Where Jev may help

The safe first use is candidate-trace qualification before a new automatic trace enters the store:

```text
automatic learning candidate
            |
            v
     local privacy filter
            |
            v
       Jev advice
       - should store?
       - memory type?
       - initial salience band?
            |
            v
 existing humemory acquisition path
            |
            v
 deterministic store, decay, recall, cues, and review
```

Jev may advise whether an automatically extracted learning deserves storage. It must not govern decay, deletion, loop closure, cue firing, script activation, dream approval, or explicit memories created by a user.

This preserves the existing rule: LLMs are optional helpers, not governors.

## First session task

Complete Session 0 first. Then build a synthetic live probe and a network-free advisor contract; do not start by changing runtime acquisition.

Test candidate traces such as:

1. A durable project rule that should become semantic memory.
2. A one-off command result that should be dropped.
3. A corrected build procedure that should become procedural memory.
4. A session event with temporary local paths or possible secret material.

Ask these atomic questions:

| Answer | Jev primitive | Values |
| --- | --- | --- |
| `should_store` | noul | probability from 0 to 1 |
| `memory_type` | choice | `episodic`, `semantic`, `procedural` |
| `salience_band` | score | discard, low, normal, high, exceptional |
| `contains_sensitive_material` | noul | experimental signal only; never the sole privacy filter |

The privacy decision must happen locally before the request. Asking Jev whether text is sensitive after sending it is not a protection.

## Proposed modes

Keep network use off unless the operator chooses it:

```text
HUMEMORY_JEV_MODE=off
HUMEMORY_JEV_MODE=shadow
HUMEMORY_JEV_MODE=advisory
```

- `off`: default; no TypeSafe request.
- `shadow`: run Jev only for eligible automatic candidates, keep the existing result, and record a sanitized comparison.
- `advisory`: apply Jev advice inside strict local thresholds, then fall back to existing behavior on uncertainty or failure.

The presence of `TYPESAFE_API_KEY` must not enable network calls by itself.

## Advisor boundary

Use an injected interface rather than calling the SDK from the store or cue resolver:

```ts
type MemoryAdvice = {
  shouldStore: number;
  memoryType: 'episodic' | 'semantic' | 'procedural';
  memoryTypeConfidence: number | null;
  salienceBand: 'discard' | 'low' | 'normal' | 'high' | 'exceptional';
  provider: 'jev';
};

interface MemoryAdvisor {
  advise(candidate: SanitizedMemoryCandidate): Promise<MemoryAdvice>;
}
```

Map `salienceBand` to numeric saillance in local code. Do not ask Jev for an unconstrained number and store it directly.

Place the provider at the automatic acquisition or learning-extraction boundary. Keep it out of:

- `src/store/sqlite.ts`;
- the deterministic level generator fallback;
- cue matching and `SqliteCueResolver`;
- session context composition;
- maintenance job retry ownership.

The exact caller should be chosen only after tracing the current acquisition path and reviewing the uncommitted Kimi work.

## Privacy envelope

Only send the minimum text needed to classify the candidate. Before the API call:

- reject candidates containing detected credentials, tokens, private keys, or authorization headers;
- strip absolute paths, usernames, hostnames, and unrelated command output;
- enforce a small character limit;
- restrict the feature to source types explicitly approved for cloud evaluation;
- never send the full session transcript or the memory database.

Logs must contain hashes and decision metadata, not candidate content. Make any diagnostic content logging a separate opt-in setting.

## Testing rules

Default tests stay hermetic, deterministic, and network-free as required by `AGENTS.md` and `docs/TESTING.md`.

- inject a fake `MemoryAdvisor` in unit tests;
- cover timeout, malformed response, missing key, rejected content, low confidence, and provider failure;
- verify that every failure preserves existing behavior;
- keep the live TypeSafe probe outside `pnpm test` and require an explicit command;
- never let a test read the real memory database.

Use fixtures with expected `should_store`, type, and salience band. Human-review those labels; the fixture corpus is the product decision being evaluated, not generated truth.

## Evaluation and activation

The shadow report should measure storage precision, dangerous false positives, useful memories incorrectly dropped, type accuracy, confidence calibration, latency, and cost. Review disagreements manually because several memory candidates will be legitimately ambiguous.

Do not enable `advisory` mode until:

- local redaction tests cover known secret formats and path leakage;
- provider failure cannot lose an explicit or automatic memory candidate;
- low-confidence decisions use existing behavior;
- Jev improves the labeled corpus over the current acquisition rule;
- cloud processing is documented as an opt-in privacy tradeoff;
- the Kimi resolution note identifies the accepted commit or parked branch, test evidence, and remaining debt without erasing user changes.

## Deferred work

Do not use Jev for resurfacing in the first implementation. Resurfacing depends on current directory, branch, cues, open loops, recency, and the session objective; mistakes directly alter injected context. Revisit it only after candidate qualification has enough data to show that confidence tracks correctness.

Also defer deletion, memory merging, dream proposal approval, script activation, and loop closure. Those actions already have deterministic or human-review boundaries that should stay intact.

## Done condition for the first implementation session

Session 0 must already have resolved the Kimi experiments. Stop the first Jev implementation session after the synthetic probe, injected advisor contract, local privacy filter, network-free tests, shadow-only wiring, and evaluation fixtures work. Do not enable advisory behavior in the same session.
