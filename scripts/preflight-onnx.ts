// Pre-flight A2: does feature-extraction run under bun on win32?
import { pipeline, env } from '@huggingface/transformers';

env.cacheDir = './data/models';
env.allowLocalModels = true;

console.log('loading model (first run downloads ~120MB)...');
const t0 = Date.now();
const extractor = await pipeline('feature-extraction', 'Xenova/multilingual-e5-small', { dtype: 'q8' });
console.log(`loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const out = await extractor(['passage: bun test fails on the shared DB path'], { pooling: 'mean', normalize: true });
const emb = out.data as Float32Array;
console.log(`dims: ${emb.length}, norm: ${Math.sqrt(emb.reduce((s, x) => s + x * x, 0)).toFixed(3)}`);

const out2 = await extractor(['passage: les tests plantent sur la base partagée'], { pooling: 'mean', normalize: true });
const emb2 = out2.data as Float32Array;
const cos = emb.reduce((s, x, i) => s + x * emb2[i], 0);
console.log(`cosine(paraphrase FR/EN): ${cos.toFixed(3)} — expect high (>0.75)`);

const out3 = await extractor(['passage: recipe tomato basil pasta'], { pooling: 'mean', normalize: true });
const emb3 = out3.data as Float32Array;
const cos3 = emb.reduce((s, x, i) => s + x * emb3[i], 0);
console.log(`cosine(unrelated): ${cos3.toFixed(3)} — expect low (<0.6)`);
console.log('PRE-FLIGHT OK');
