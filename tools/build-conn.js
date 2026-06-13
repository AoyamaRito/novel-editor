// 連接モデル生成: corpus → conn.json
//   品詞bigram接続コスト(汎化) + 著者表記bigram(具体的な並び) + かな表記嗜好 + 語→品詞
// すべて著者コーパス由来の決定論的な統計。LLM は一切使わない。
// usage: node tools/build-conn.js > conn.json
const fs = require('fs');
const path = require('path');
const kuromoji = require('kuromoji');

const DIC = path.join(__dirname, '..', 'node_modules', 'kuromoji', 'dict');
const CORPUS = path.join(__dirname, '..', 'corpus');

const kataToHira = (s) => s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
const isHira = (s) => /^[ぁ-んー]+$/.test(s);
const isKata = (s) => /^[ァ-ヶー]+$/.test(s);
const hasKanji = (s) => /[一-鿿々]/.test(s);

// 品詞キー: 上位品詞を基本にしつつ、助詞/助動詞/動詞の補助は細分(連接の効きが段違いなので)
function posKey(t) {
  const p = t.pos;
  if (p === '助詞') return '助詞:' + (t.pos_detail_1 || '');
  if (p === '助動詞') return '助動詞';
  if (p === '動詞') return '動詞:' + (t.pos_detail_1 === '非自立' ? '補助' : '自立');
  if (p === '名詞') return '名詞:' + (t.pos_detail_1 === '非自立' || t.pos_detail_1 === '接尾' ? '接尾' : '一般');
  return p;
}
function tokYomi(t) {
  if (t.reading && t.reading !== '*') return kataToHira(t.reading);
  if (isKata(t.surface_form)) return kataToHira(t.surface_form);
  if (isHira(t.surface_form)) return t.surface_form;
  return null;
}

kuromoji.builder({ dicPath: DIC }).build((err, tokenizer) => {
  if (err) throw err;
  const uni = {};                 // pos -> count
  const bi = {};                  // posL -> posR -> count
  const wbi = {};                 // surfLsurfR -> count(内容語ペアのみ、高頻度)
  const kana = {};                // reading -> { kanaCnt, total }  著者がかなで書いた割合
  const wpos = {};                // readingsurface -> pos(多数決用カウント)
  const ypos = {};                // reading -> pos(多数決。助詞・かな語含む全トークン)
  const bump = (o, k) => (o[k] = (o[k] || 0) + 1);

  for (const f of fs.readdirSync(CORPUS)) {
    if (!/\.(txt|md)$/.test(f)) continue;
    const text = fs.readFileSync(path.join(CORPUS, f), 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      const toks = tokenizer.tokenize(line);
      let prev = 'BOS', prevSurf = null, prevContent = false;
      for (const t of toks) {
        const pk = posKey(t);
        bump(uni, pk);
        (bi[prev] ??= {}); bump(bi[prev], pk);
        // 表記bigram: 記号を挟まない隣接、かつ少なくとも片方が内容語(漢字/カタカナ)
        const content = hasKanji(t.surface_form) || isKata(t.surface_form);
        if (prevSurf != null && (prevContent || content) && t.pos !== '記号' && prevSurf.length + t.surface_form.length <= 8)
          bump(wbi, prevSurf + '' + t.surface_form);
        // かな表記嗜好: 読みを持つ自立語が、実際にかなで書かれたか
        const y = tokYomi(t);
        if (y && t.pos !== '記号' && t.pos !== '助詞' && t.pos !== '助動詞' && y.length >= 2) {
          (kana[y] ??= [0, 0]);
          kana[y][1]++;                          // total
          if (isHira(t.surface_form)) kana[y][0]++; // かなで書かれた
        }
        if (y && (hasKanji(t.surface_form) || isKata(t.surface_form))) {
          const wk = y + '' + t.surface_form;
          (wpos[wk] ??= {}); bump(wpos[wk], pk);
        }
        if (y && y.length >= 1) { (ypos[y] ??= {}); bump(ypos[y], pk); }
        prev = pk; prevSurf = t.pos === '記号' ? null : t.surface_form; prevContent = content;
      }
      (bi[prev] ??= {}); bump(bi[prev], 'EOS');
    }
  }

  // --- 品詞bigram → 接続コスト: cost = clamp(round(K * -log(P(posR|posL))), 0, MAXC) ---
  const K = 130, MAXC = 600, ALPHA = 0.6;
  const posList = Object.keys(uni).sort((a, b) => uni[b] - uni[a]);
  const V = posList.length + 1; // +EOS
  const posBi = {};
  for (const [L, row] of Object.entries(bi)) {
    const tot = Object.values(row).reduce((a, b) => a + b, 0);
    const out = {};
    for (const R of posList.concat(['EOS'])) {
      const p = ((row[R] || 0) + ALPHA) / (tot + ALPHA * V);
      const c = Math.max(0, Math.min(MAXC, Math.round(K * -Math.log(p))));
      out[R] = c;
    }
    posBi[L] = out;
  }

  // --- 表記bigram: 割引テーブル。count が多いほど割引(自然な並びを安くする) ---
  const WB_MIN = 3, WB_K = 60, WB_MAX = 220;
  const wbiOut = {};
  for (const [k, c] of Object.entries(wbi)) {
    if (c < WB_MIN) continue;
    wbiOut[k] = Math.min(WB_MAX, Math.round(WB_K * Math.log(c))); // 割引額(正の値=コストから引く)
  }

  // --- かな嗜好: かな率が高い読みだけ残す(passthrough 割引に使う) ---
  const kanaOut = {};
  for (const [y, [k, tot]] of Object.entries(kana)) {
    if (tot < 3) continue;
    const ratio = k / tot;
    if (ratio >= 0.85) kanaOut[y] = Math.round(ratio * 100); // 高かな率の語だけ(コーパス表記を上書きするので慎重に)
  }

  // --- 語→品詞(多数決): dict.json には載らない base 語の POS 補完にも使える ---
  const wposOut = {};
  for (const [k, m] of Object.entries(wpos)) {
    let best = null, bc = 0;
    for (const [p, c] of Object.entries(m)) if (c > bc) { bc = c; best = p; }
    if (best) wposOut[k] = best;
  }

  const yposOut = {};
  for (const [k, m] of Object.entries(ypos)) {
    let best = null, bc = 0;
    for (const [p, c] of Object.entries(m)) if (c > bc) { bc = c; best = p; }
    if (best) yposOut[k] = best;
  }

  const out = { K, MAXC, posList, posBi, wbi: wbiOut, kana: kanaOut, wpos: wposOut, ypos: yposOut };
  process.stdout.write(JSON.stringify(out));
  console.error(`pos=${posList.length} posBiRows=${Object.keys(posBi).length} wbi=${Object.keys(wbiOut).length} kana=${Object.keys(kanaOut).length} wpos=${Object.keys(wposOut).length} ypos=${Object.keys(yposOut).length}`);
});
