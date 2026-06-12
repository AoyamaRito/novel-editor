// コーパス集計: 原稿 → 打鍵かなストリーム → unigram/bigram/記号/変換開始点
// usage: node tools/aggregate.js <file-or-dir>... > out/freq.json
const fs = require('fs');
const path = require('path');
const kuromoji = require('kuromoji');

const DIC = path.join(__dirname, '..', 'node_modules', 'kuromoji', 'dict');

// 集計対象の記号(小説本文で打つもの)。それ以外の記号は無視
const SYMBOLS = new Set(['。', '、', '「', '」', '…', '！', '？', 'ー', '・', '（', '）']);

function collectFiles(args) {
  const files = [];
  for (const a of args) {
    const st = fs.statSync(a);
    if (st.isDirectory()) {
      for (const f of fs.readdirSync(a)) {
        if (/\.(txt|md)$/.test(f)) files.push(path.join(a, f));
      }
    } else files.push(a);
  }
  return files;
}

function clean(text) {
  return text
    .replace(/<!--[\s\S]*?-->/g, '')   // 埋め込みメタデータ
    .replace(/^#+ /gm, '')             // markdown 見出し記法
    .replace(/[‥]/g, '…')
    .replace(/[“”]/g, '');
}

const kataToHira = (s) =>
  s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));

const isHira = (c) => c >= 'ぁ' && c <= 'ん';
const hasKanji = (s) => /[一-鿿々]/.test(s);
const isKana = (s) => /^[ぁ-んァ-ヶー]+$/.test(s);

kuromoji.builder({ dicPath: DIC }).build((err, tokenizer) => {
  if (err) throw err;

  const uni = {}, bi = {}, kanjiStartAfter = {};
  let totalKana = 0, totalKanjiStarts = 0, droppedTokens = 0;
  const inc = (m, k) => (m[k] = (m[k] || 0) + 1);

  for (const file of collectFiles(process.argv.slice(2))) {
    const text = clean(fs.readFileSync(file, 'utf8'));
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let prev = null; // 行内でのみ連接を取る
      for (const t of tokenizer.tokenize(line)) {
        const surf = t.surface_form;
        let yomi = null;
        if (t.reading && t.reading !== '*') yomi = kataToHira(t.reading);
        else if (isKana(surf)) yomi = kataToHira(surf);

        if (hasKanji(surf)) {
          totalKanjiStarts++; // 変換開始マークが1回打たれる地点
          if (prev) inc(kanjiStartAfter, prev);
        }

        if (yomi === null) {
          // 読み不明の漢字(固有名詞等)・英数・対象外記号: 連接を切る
          for (const c of surf) {
            if (SYMBOLS.has(c)) {
              inc(uni, c);
              if (prev) inc(bi, prev + c);
              prev = c;
              totalKana++;
            } else prev = null;
          }
          if (!isKana(surf) && !hasKanji(surf)) droppedTokens++;
          continue;
        }

        for (const c of yomi) {
          if (!(isHira(c) || c === 'ー' || SYMBOLS.has(c))) { prev = null; continue; }
          inc(uni, c);
          if (prev) inc(bi, prev + c);
          prev = c;
          totalKana++;
        }
      }
    }
  }

  const sorted = (m) => Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1]));
  process.stdout.write(JSON.stringify({
    meta: { totalKana, totalKanjiStarts, droppedTokens, files: process.argv.slice(2) },
    unigram: sorted(uni),
    bigram: sorted(bi),
    kanjiStartAfter: sorted(kanjiStartAfter),
  }, null, 1));
});
