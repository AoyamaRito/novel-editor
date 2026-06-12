// 配列生成: out/freq.json → 貪欲法 + 山登り → out/layout.json / out/layout.md
// usage: node tools/layout-gen.js
const fs = require('fs');
const path = require('path');

const freq = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'out', 'freq.json'), 'utf8'));

// ---- 文字集合(60スロットちょうど) ----
const SEION =
  'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん';
const DIRECT = [...SEION, 'っ', 'ゃ', 'ゅ', 'ょ', 'ー', '。', '、', '「', '」', '…', '！', '？', '゛', '　'];
// 変形キー゛で後置合成する文字 → 親
const COMPOSE = {
  が: 'か', ぎ: 'き', ぐ: 'く', げ: 'け', ご: 'こ',
  ざ: 'さ', じ: 'し', ず: 'す', ぜ: 'せ', ぞ: 'そ',
  だ: 'た', ぢ: 'ち', づ: 'つ', で: 'て', ど: 'と',
  ば: 'は', び: 'ひ', ぶ: 'ふ', べ: 'へ', ぼ: 'ほ',
  ぱ: 'は', ぴ: 'ひ', ぷ: 'ふ', ぺ: 'へ', ぽ: 'ほ',
  ぁ: 'あ', ぃ: 'い', ぅ: 'う', ぇ: 'え', ぉ: 'お',
};
// 半濁音・小書き母音は゛2連打(゛゛)。打鍵列にはどちらも「親+゛」で1個分として近似計上し、
// ぱ行と小書き母音のみ ゛ をもう1打加算する。
const DOUBLE_MOD = new Set(['ぱ', 'ぴ', 'ぷ', 'ぺ', 'ぽ', 'ぁ', 'ぃ', 'ぅ', 'ぇ', 'ぉ']);

// ---- 物理キー: JIS 3段×10列。指: 0-3 左小薬中人, 4 左人差し伸ばし, 5 右人差し伸ばし, 6-9 右人中薬小 ----
const KEYS = [];
const COST = [
  [3.0, 2.4, 2.0, 2.2, 2.7, 2.7, 2.2, 2.0, 2.4, 3.0], // 上段 QWERTYUIOP
  [1.7, 1.3, 1.1, 1.0, 1.9, 1.9, 1.0, 1.1, 1.3, 1.7], // 中段 ASDFGHJKL;
  [3.2, 2.8, 2.4, 1.9, 2.9, 2.9, 1.9, 2.4, 2.8, 3.2], // 下段 ZXCVBNM,./
];
const LABELS = ['QWERTYUIOP', 'ASDFGHJKL;', 'ZXCVBNM,./'];
const FINGER = [0, 1, 2, 3, 3, 6, 6, 7, 8, 9];
const CHORD_PENALTY = 0.7;
for (let r = 0; r < 3; r++)
  for (let c = 0; c < 10; c++)
    for (const chord of [false, true])
      KEYS.push({
        id: LABELS[r][c] + (chord ? '+SP' : ''),
        row: r, col: c, chord,
        cost: COST[r][c] + (chord ? CHORD_PENALTY : 0),
        finger: FINGER[c], hand: c < 5 ? 0 : 1,
      });
// KEYS.length = 60

// ---- 打鍵単位の uni/bigram に変換(濁音→親+゛ 展開) ----
const expand = (ch) => (COMPOSE[ch] ? [COMPOSE[ch], '゛'] : [ch]);
const uni = {}, bi = {};
const add = (m, k, n) => (m[k] = (m[k] || 0) + n);
for (const [ch, n] of Object.entries(freq.unigram)) {
  const ex = expand(ch);
  if (!ex.every((c) => DIRECT.includes(c))) continue;
  for (const c of ex) add(uni, c, n);
  if (ex.length === 2) add(bi, ex[0] + ex[1], n);
  if (DOUBLE_MOD.has(ch)) add(uni, '゛', n); // ゛2打目
}
for (const [pair, n] of Object.entries(freq.bigram)) {
  const a = expand(pair[0]), b = expand(pair[1]);
  if (![...a, ...b].every((c) => DIRECT.includes(c))) continue;
  add(bi, a[a.length - 1] + b[0], n);
}

// ---- スコア: Σ unigram*cost + Σ bigram*連接ペナルティ ----
function score(slotOf) {
  let s = 0;
  for (const [c, n] of Object.entries(uni)) s += n * KEYS[slotOf[c]].cost;
  for (const [pair, n] of Object.entries(bi)) {
    const a = KEYS[slotOf[pair[0]]], b = KEYS[slotOf[pair[1]]];
    if (a === undefined || b === undefined) continue;
    let p = 0;
    if (a.hand === b.hand) {
      p += 0.1; // 同手
      if (a.finger === b.finger) p += a.row === b.row && a.col === b.col ? 0.3 : 1.5; // 同キー連打 / 同指異キー
      else if (Math.abs(a.row - b.row) === 2) p += 0.4; // 同手で上段↔下段の跳躍
    }
    if (a.chord && b.chord) p += 0.4; // 和音の連続
    s += n * p;
  }
  return s;
}

// ---- 山登り(乱数は固定シードLCG: 再現可能) ----
const chars = DIRECT.slice().sort((x, y) => (uni[y] || 0) - (uni[x] || 0));

// 差分スコア用の隣接リスト: c -> Map(o -> [c→o回数, o→c回数])。自己連接は前向きのみ保持
const nbr = {};
for (const [pair, n] of Object.entries(bi)) {
  const x = pair[0], y = pair[1];
  nbr[x] ??= new Map();
  nbr[y] ??= new Map();
  const ex = nbr[x].get(y) || [0, 0];
  ex[0] += n;
  nbr[x].set(y, ex);
  if (x !== y) {
    const ey = nbr[y].get(x) || [0, 0];
    ey[1] += n;
    nbr[y].set(x, ey);
  }
}

function pen(a, b) {
  let p = 0;
  if (a.hand === b.hand) {
    p += 0.1;
    if (a.finger === b.finger) p += a.row === b.row && a.col === b.col ? 0.3 : 1.5;
    else if (Math.abs(a.row - b.row) === 2) p += 0.4;
  }
  if (a.chord && b.chord) p += 0.4;
  return p;
}

function climb(initial, seedVal, iters) {
  const cur = { ...initial };
  let seed = seedVal;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0), seed / 2 ** 32);

  // 文字cの現配置でのスコア寄与(uni項 + cが絡む全bigram項)
  const contrib = (c) => {
    const sc = KEYS[cur[c]];
    let s = (uni[c] || 0) * sc.cost;
    if (nbr[c])
      for (const [o, [f, b]] of nbr[c]) {
        if (cur[o] === undefined) continue;
        const so = KEYS[cur[o]];
        if (o === c) s += f * pen(sc, sc);
        else s += f * pen(sc, so) + b * pen(so, sc);
      }
    return s;
  };
  // a,b 両方の contrib に二重計上される a↔b 間の項
  const cross = (a, b) => {
    const e = nbr[a] && nbr[a].get(b);
    if (!e) return 0;
    return e[0] * pen(KEYS[cur[a]], KEYS[cur[b]]) + e[1] * pen(KEYS[cur[b]], KEYS[cur[a]]);
  };

  let s0 = score(cur);
  for (let it = 0; it < iters; it++) {
    const a = chars[(rand() * chars.length) | 0];
    const b = chars[(rand() * chars.length) | 0];
    if (a === b) continue;
    const before = contrib(a) + contrib(b) - cross(a, b);
    [cur[a], cur[b]] = [cur[b], cur[a]];
    const after = contrib(a) + contrib(b) - cross(a, b);
    if (after - before < -1e-9) s0 += after - before;
    else [cur[a], cur[b]] = [cur[b], cur[a]];
  }
  return [cur, score(cur)]; // 報告値は全計算で取り直す(差分誤差の蓄積を遮断)
}

// 初期値: 既存 layout.json があればそれをアンカー(増分改善のみ → 配列の連続性を守る)。
// --fresh でマルチリスタート探索(配列を白紙から導出し直す。学習済み配列は捨てる覚悟で)。
const outPath = path.join(__dirname, '..', 'out', 'layout.json');
const fresh = process.argv.includes('--fresh') || !fs.existsSync(outPath);
let slotOf, best, init, mode, prevSlots = null;

if (fresh) {
  mode = 'fresh(マルチリスタート8)';
  const slotsByCost = KEYS.map((k, i) => i).sort((i, j) => KEYS[i].cost - KEYS[j].cost);
  const greedy = {};
  chars.forEach((c, i) => (greedy[c] = slotsByCost[i]));
  init = score(greedy);
  best = Infinity;
  for (const s of [11, 22, 33, 44, 55, 66, 77, 20260612]) {
    const [cand, sc] = climb(greedy, s, 1000000);
    if (sc < best) { best = sc; slotOf = cand; }
  }
} else {
  mode = 'anchor(前版から増分改善)';
  const prev = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  prevSlots = prev.slots;
  const idToIdx = Object.fromEntries(KEYS.map((k, i) => [k.id, i]));
  const anchored = {};
  for (const c of chars) anchored[c] = idToIdx[prev.slots[c]];
  init = score(anchored);
  [slotOf, best] = climb(anchored, 20260612, 1000000);
}

const moved = prevSlots
  ? chars.filter((c) => KEYS[slotOf[c]].id !== prevSlots[c]).map((c) => `${c}: ${prevSlots[c]}→${KEYS[slotOf[c]].id}`)
  : [];

// ---- 出力 ----
const grid = (chord) =>
  [0, 1, 2].map((r) =>
    [...Array(10).keys()]
      .map((c) => {
        const ch = Object.keys(slotOf).find(
          (k) => KEYS[slotOf[k]].row === r && KEYS[slotOf[k]].col === c && KEYS[slotOf[k]].chord === chord
        );
        return ch === '　' ? '□' : ch || '・';
      })
      .join(' ')
  );

const out = {
  meta: {
    generated: '2026-06-12',
    mode,
    corpusKana: freq.meta.totalKana,
    scoreInit: Math.round(init),
    scoreFinal: Math.round(best),
    moved,
    rule: '濁音・半濁音・小書き母音は親かな+゛(半濁/小書きは゛゛)。っゃゅょ は独立スロット。□=全角スペース',
  },
  plain: grid(false),
  chord: grid(true),
  slots: Object.fromEntries(chars.map((c) => [c, KEYS[slotOf[c]].id])),
  unigramTyped: Object.fromEntries(Object.entries(uni).sort((a, b) => b[1] - a[1])),
};
fs.writeFileSync(path.join(__dirname, '..', 'out', 'layout.json'), JSON.stringify(out, null, 1));

const md = `# 配列(コーパス導出 2026-06-12, mode: ${mode})

打鍵スコア: 初期 ${Math.round(init)} → 最適化後 ${Math.round(best)}(コーパス${Math.round(freq.meta.totalKana / 10000)}万かな)
${moved.length ? `\n前版からの移動 ${moved.length} 字: ${moved.join(' / ')}\n` : ''}

## 単打面

\`\`\`
${grid(false).join('\n')}
\`\`\`

## 和音面(space 同時)

\`\`\`
${grid(true).join('\n')}
\`\`\`

規則: 濁音=親+゛ / 半濁音・小書き母音=親+゛゛ / っゃゅょ は独立キー / □=全角スペース
物理キー対応: 上段 QWERTYUIOP・中段 ASDFGHJKL;・下段 ZXCVBNM,./
`;
fs.writeFileSync(path.join(__dirname, '..', 'out', 'layout.md'), md);
console.log(md);
