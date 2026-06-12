// 練習用ドリル生成: corpus → drills.json(変換語 + かな化した実文)
// usage: node tools/build-drills.js > drills.json
const fs = require('fs');
const path = require('path');
const kuromoji = require('kuromoji');

const DIC = path.join(__dirname, '..', 'node_modules', 'kuromoji', 'dict');
const CORPUS = path.join(__dirname, '..', 'corpus');
const DICT = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'out', 'dict.json'), 'utf8'));

const kataToHira = (s) =>
  s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
const KEEP = new Set(['。', '、', '「', '」', '…', '！', '？', 'ー']);

// 変換語ドリル: 自己コーパス辞書から頻出語(読み2〜6字)
const convWords = [];
for (const [yomi, cands] of Object.entries(DICT)) {
  const [surf, n] = cands[0];
  if (n >= 8 && yomi.length >= 2 && yomi.length <= 6 && surf !== yomi)
    convWords.push([surf, yomi, n]);
}
convWords.sort((a, b) => b[2] - a[2]);

kuromoji.builder({ dicPath: DIC }).build((err, tokenizer) => {
  if (err) throw err;
  // 単語ドリル: コーパス頻出語の読み(意味のある語だけ。ランダム文字列は使わない)
  const POS = new Set(['名詞', '動詞', '形容詞', '副詞', '感動詞', '連体詞', '接続詞']);
  const wordCount = {};
  // 実文ドリル: 行をかな化(リズム練習用)。記号は KEEP のみ残す
  const lines = [];
  for (const f of fs.readdirSync(CORPUS)) {
    if (!/\.txt$/.test(f)) continue;
    for (const raw of fs.readFileSync(path.join(CORPUS, f), 'utf8').split('\n')) {
      const line = raw.trim();
      if (line.length < 8 || line.length > 28) continue;
      let kana = '';
      let ok = true;
      for (const t of tokenizer.tokenize(line)) {
        if (POS.has(t.pos)) {
          const y =
            t.reading && t.reading !== '*'
              ? kataToHira(t.reading)
              : /^[ぁ-んァ-ヶー]+$/.test(t.surface_form)
                ? kataToHira(t.surface_form)
                : null;
          if (y && y.length >= 2 && y.length <= 7 && /^[ぁ-んー]+$/.test(y))
            wordCount[y] = (wordCount[y] || 0) + 1;
        }
        if (t.reading && t.reading !== '*') kana += kataToHira(t.reading);
        else if (/^[ぁ-んー]+$/.test(t.surface_form)) kana += t.surface_form;
        else if (/^[ァ-ヶー]+$/.test(t.surface_form)) kana += kataToHira(t.surface_form);
        else {
          for (const c of t.surface_form) {
            if (KEEP.has(c)) kana += c;
            else { ok = false; break; }
          }
        }
        if (!ok) break;
      }
      // 原文(漢字込み)が打てる行だけ: かな/カタカナ/漢字/許可記号のみで構成
      const origOk = [...line].every((c) => /[ぁ-んァ-ヶー一-鿿々]/.test(c) || KEEP.has(c));
      if (ok && origOk && kana.length >= 8 && kana.length <= 40) lines.push([line, kana]);
    }
  }
  // 重複除去 + 決定的に間引き(7行ごと、最大150)
  const seen = new Set();
  const uniq = lines.filter(([o]) => !seen.has(o) && seen.add(o));
  const sampled = uniq.filter((_, i) => i % 7 === 0).slice(0, 150);
  const words = Object.entries(wordCount)
    .filter(([, n]) => n >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 800)
    .map(([w]) => w);
  process.stdout.write(
    JSON.stringify({ convWords: convWords.slice(0, 60).map(([s, y]) => [s, y]), words, lines: sampled })
  );
  console.error(`convWords: ${Math.min(convWords.length, 60)}, words: ${words.length}, lines: ${sampled.length}`);
});
