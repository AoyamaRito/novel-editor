// なろうテキストダウンロード形式(episode_NNNN.txt)を corpus/ に取り込む
// usage: node tools/import-narou.js <出力名> <episode files...>
// 【タイトル】の値行と【本文】以降だけを残し、corpus/<出力名>.txt に連結する
const fs = require('fs');
const path = require('path');

const [name, ...files] = process.argv.slice(2);
if (!name || !files.length) {
  console.error('usage: node tools/import-narou.js <出力名> <episode files...>');
  process.exit(1);
}

const parts = [];
for (const f of files) {
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  let title = '';
  let bodyStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('【タイトル】')) title = lines[i + 1] || '';
    if (lines[i].startsWith('【本文')) { bodyStart = i + 1; break; }
  }
  if (bodyStart < 0) { console.error(`本文が見つからない: ${f}`); continue; }
  parts.push(title + '\n' + lines.slice(bodyStart).join('\n').trim());
}

const outPath = path.join(__dirname, '..', 'corpus', name + '.txt');
fs.writeFileSync(outPath, parts.join('\n\n') + '\n');
console.log(`${outPath} ← ${files.length} episodes, ${parts.join('').length} chars`);
