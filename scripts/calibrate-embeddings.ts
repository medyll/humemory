/**
 * Threshold calibration — Phase 7.5. NOT a test: needs the real model.
 *
 * Sweeps cosine thresholds against the labeled pairs and reports, per dtype:
 *   - clustering precision/recall/F1 (→ vectorClusterThreshold, best F1)
 *   - verification precision: share of pairs ABOVE the threshold that are
 *     true matches. Corroboration is unreviewed, so its threshold is the
 *     lowest value achieving precision 1.0 (→ vectorCorroborateThreshold).
 *
 * Run: bun run scripts/calibrate-embeddings.ts [--dtype q8|fp16|both]
 */
import { readFileSync } from 'fs';
import { OnnxEmbedder } from '../src/core/embeddings.js';

const dtypeArg = process.argv.includes('--dtype')
  ? process.argv[process.argv.indexOf('--dtype') + 1]
  : 'both';
const dtypes = dtypeArg === 'both' ? (['q8', 'fp16'] as const) : ([dtypeArg] as const);

const { pairs } = JSON.parse(readFileSync('tests/fixtures/embeddings/pairs.json', 'utf8')) as {
  pairs: { a: string; b: string; should: boolean }[];
};

for (const dtype of dtypes) {
  console.log(`\n=== ${dtype} ===`);
  const embedder = new OnnxEmbedder({ dtype });
  const texts = [...new Set(pairs.flatMap((p) => [p.a, p.b]))];
  const vecs = new Map<string, Float32Array>();
  const embedded = await embedder.embed(texts);
  texts.forEach((t, i) => vecs.set(t, embedded[i]));

  const scored = pairs.map((p) => ({
    cos: vecs.get(p.a)!.reduce((s, x, i) => s + x * vecs.get(p.b)![i], 0),
    should: p.should,
  }));

  const trues = scored.filter((s) => s.should).map((s) => s.cos).sort((a, b) => a - b);
  const falses = scored.filter((s) => !s.should).map((s) => s.cos).sort((a, b) => b - a);
  console.log(`true pairs:  min ${trues[0].toFixed(3)} · median ${trues[Math.floor(trues.length / 2)].toFixed(3)}`);
  console.log(`false pairs: max ${falses[0].toFixed(3)} · median ${falses[Math.floor(falses.length / 2)].toFixed(3)}`);

  let best = { t: 0, f1: 0, p: 0, r: 0 };
  let corroborate: number | null = null;
  for (let t = 0.70; t <= 0.99; t += 0.005) {
    const tp = scored.filter((s) => s.cos >= t && s.should).length;
    const fp = scored.filter((s) => s.cos >= t && !s.should).length;
    const fn = scored.filter((s) => s.cos < t && s.should).length;
    const p = tp + fp ? tp / (tp + fp) : 1;
    const r = tp + fn ? tp / (tp + fn) : 0;
    const f1 = p + r ? (2 * p * r) / (p + r) : 0;
    if (f1 > best.f1) best = { t, f1, p, r };
    if (corroborate === null && fp === 0 && t > trues[0]) corroborate = t; // precision 1.0 above the weakest true pair... tightened below
  }

  // Corroborate threshold: lowest threshold where precision = 1.0 AND recall
  // stays ≥ 0.5 — nobody reviews verification, precision dominates, but a
  // gate that never opens is useless.
  corroborate = null;
  for (let t = 0.70; t <= 0.99; t += 0.005) {
    const tp = scored.filter((s) => s.cos >= t && s.should).length;
    const fp = scored.filter((s) => s.cos >= t && !s.should).length;
    const r = tp / trues.length;
    if (fp === 0 && r >= 0.5) corroborate = corroborate === null ? t : corroborate;
    if (fp === 0 && r >= 0.5) break;
  }

  console.log(`cluster threshold (best F1):     ${best.t.toFixed(3)}  (P ${best.p.toFixed(2)} / R ${best.r.toFixed(2)} / F1 ${best.f1.toFixed(2)})`);
  console.log(`corroborate threshold (P=1.0):   ${corroborate === null ? 'NONE FOUND — manual review needed' : corroborate.toFixed(3)}`);
}
