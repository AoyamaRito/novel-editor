// 基底辞書生成: SKK-JISYO.L(UTF-8変換済み) → basedict.json
// okuri-nasi エントリのみ(本システムは読みを活用形まで全部打つ方式のため)
// usage: node tools/build-basedict.js > basedict.json
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'data', 'SKK-JISYO.L.utf8'), 'utf8');
const dict = {};
let inOkuriNasi = false;
let entries = 0;

for (const line of src.split('\n')) {
  if (line.startsWith(';; okuri-nasi entries.')) { inOkuriNasi = true; continue; }
  if (line.startsWith(';') || !inOkuriNasi) continue;
  const sp = line.indexOf(' ');
  if (sp < 0) continue;
  const yomi = line.slice(0, sp);
  if (!/^[ぁ-んー]+$/.test(yomi)) continue; // この配列で打てる読みだけ
  const cands = line
    .slice(sp + 1)
    .split('/')
    .map((c) => c.split(';')[0]) // 注釈を落とす
    .filter((c) => c && !c.includes('(')); // lisp 式候補を除外
  if (!cands.length) continue;
  dict[yomi] = (dict[yomi] || []).concat(cands);
  entries++;
}

process.stdout.write(JSON.stringify(dict));
console.error(`base entries: ${entries}, readings: ${Object.keys(dict).length}`);
