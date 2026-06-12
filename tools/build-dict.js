// 自己コーパス辞書生成: corpus/ → dict.json(読み→表記候補、頻度順)
// usage: node tools/build-dict.js > dict.json
const fs = require('fs');
const path = require('path');
const kuromoji = require('kuromoji');

const DIC = path.join(__dirname, '..', 'node_modules', 'kuromoji', 'dict');
const CORPUS = path.join(__dirname, '..', 'corpus');

const kataToHira = (s) =>
  s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
const hasKanji = (s) => /[一-鿿々]/.test(s);
const isKatakanaWord = (s) => /^[ァ-ヶー]+$/.test(s);

kuromoji.builder({ dicPath: DIC }).build((err, tokenizer) => {
  if (err) throw err;
  const dict = {}; // reading -> { surface -> count }
  const add = (yomi, surf) => {
    if (!yomi || yomi === surf) return;
    (dict[yomi] ??= {});
    dict[yomi][surf] = (dict[yomi][surf] || 0) + 1;
  };

  for (const f of fs.readdirSync(CORPUS)) {
    if (!/\.(txt|md)$/.test(f)) continue;
    const text = fs.readFileSync(path.join(CORPUS, f), 'utf8');
    for (const line of text.split('\n')) {
      const tokens = tokenizer.tokenize(line);
      for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        const surf = t.surface_form;
        if (!t.reading || t.reading === '*') {
          // 読み不明のカタカナ語(固有名詞): 読み=そのままのひらがな
          if (isKatakanaWord(surf)) add(kataToHira(surf), surf);
          continue;
        }
        const yomi = kataToHira(t.reading);
        if (hasKanji(surf)) add(yomi, surf);
        else if (isKatakanaWord(surf)) add(yomi, surf);
        // 次トークンと結合した複合語も登録(名詞+名詞、語幹+語尾)
        const n = tokens[i + 1];
        if (n && n.reading && n.reading !== '*' && hasKanji(surf + n.surface_form)) {
          if (
            (t.pos === '名詞' && n.pos === '名詞') ||
            (t.pos === '動詞' && n.pos === '助動詞') ||
            (t.pos === '形容詞' && n.pos === '助動詞')
          )
            add(yomi + kataToHira(n.reading), surf + n.surface_form);
        }
      }
    }
  }

  // 頻度順の候補配列に変換
  const out = {};
  for (const [yomi, surfs] of Object.entries(dict)) {
    out[yomi] = Object.entries(surfs)
      .sort((a, b) => b[1] - a[1])
      .map(([s, n]) => [s, n]);
  }
  process.stdout.write(JSON.stringify(out));
  console.error(`entries: ${Object.keys(out).length}`);
});
