// わかち境界分類器の学習(純JSロジスティック回帰・SGD)。
// 入力: /tmp/ne-wakachi.jsonl  出力: /tmp/ne-wakachi-model.json(特徴→重み)
// 各内部位置を「切る(1)/切らない(0)」で二値分類。確率は sigmoid(Σw)。
// usage: node tools/train-wakachi.mjs   env: EPOCHS=12 LR=0.2 L2=1e-6 SEED=7
import fs from 'fs';
import { feats } from './wakachi-feats.mjs';

const EPOCHS = +(process.env.EPOCHS || 12);
const LR = +(process.env.LR || 0.2);
const L2 = +(process.env.L2 || 1e-6);
let SEED = +(process.env.SEED || 7);
const rng = () => { SEED |= 0; SEED = (SEED + 0x6D2B79F5) | 0; let t = Math.imul(SEED ^ (SEED >>> 15), 1 | SEED); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const sigmoid = (z) => 1 / (1 + Math.exp(-z));

// データ読み込み → 例の配列 {chars, p, y}
const lines = fs.readFileSync('/tmp/ne-wakachi.jsonl', 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
// シーケンス単位で train/test 分割(位置を漏らさない)
const idx = lines.map((_, i) => i);
for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
const nTest = Math.floor(idx.length * 0.1);
const testSet = new Set(idx.slice(0, nTest));
const mkEx = (seqIds) => {
  const ex = [];
  for (const si of seqIds) {
    const s = lines[si]; const chars = [...s.y]; const cut = new Set(s.c);
    for (let p = 1; p < chars.length; p++) ex.push({ chars, p, y: cut.has(p) ? 1 : 0 });
  }
  return ex;
};
const train = mkEx(idx.slice(nTest));
const test = mkEx(idx.slice(0, nTest));
console.error(`train例=${train.length}  test例=${test.length}  特徴抽出中...`);

const W = new Map();
const dot = (fs_) => { let z = 0; for (const f of fs_) z += W.get(f) || 0; return z; };
for (let e = 0; e < EPOCHS; e++) {
  for (let i = train.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [train[i], train[j]] = [train[j], train[i]]; }
  let loss = 0;
  for (const ex of train) {
    const F = feats(ex.chars, ex.p);
    const pr = sigmoid(dot(F));
    const g = pr - ex.y;
    loss += -(ex.y ? Math.log(pr + 1e-12) : Math.log(1 - pr + 1e-12));
    for (const f of F) { const w = W.get(f) || 0; W.set(f, w - LR * (g + L2 * w)); }
  }
  // test 精度
  let ok = 0;
  for (const ex of test) if ((sigmoid(dot(feats(ex.chars, ex.p))) >= 0.5 ? 1 : 0) === ex.y) ok++;
  console.error(`epoch ${e + 1}/${EPOCHS}  loss/ex=${(loss / train.length).toFixed(4)}  test精度=${(100 * ok / test.length).toFixed(2)}%`);
}

// 校正/確信域の評価: 高確信 pin の precision と被覆率(partial制約の質を見る)
const bins = [];
for (const ex of test) bins.push({ p: sigmoid(dot(feats(ex.chars, ex.p))), y: ex.y });
const measure = (lo, hi, want) => { const sel = bins.filter((b) => b.p >= lo && b.p < hi); const acc = sel.filter((b) => b.y === want).length; return { cov: sel.length / bins.length, prec: sel.length ? acc / sel.length : 0, nn: sel.length }; };
console.error(`\n確信域 precision / 被覆:`);
for (const [lo, hi, w, lbl] of [[0.9, 1.01, 1, 'p≥0.90 →cut '], [0.8, 1.01, 1, 'p≥0.80 →cut '], [0.0, 0.1, 0, 'p<0.10 →nocut'], [0.0, 0.2, 0, 'p<0.20 →nocut']]) {
  const r = measure(lo, hi, w); console.error(`  ${lbl}: precision=${(100 * r.prec).toFixed(1)}%  被覆=${(100 * r.cov).toFixed(1)}%  (n=${r.nn})`);
}
const conf = bins.filter((b) => b.p >= 0.8 || b.p < 0.2).length / bins.length;
console.error(`  pin候補(p≥0.8 or <0.2)= ${(100 * conf).toFixed(1)}% の位置`);

fs.writeFileSync('/tmp/ne-wakachi-model.json', JSON.stringify(Object.fromEntries(W)));
console.error(`\nモデル保存: /tmp/ne-wakachi-model.json  特徴数=${W.size}`);
