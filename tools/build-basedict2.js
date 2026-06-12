// 基底辞書 v3: コスト付き { 読み: [[表記, cost], ...] }
// 層: mozc dictionary_oss(実使用頻度コスト) + IPADIC(活用形展開込み) + SKK-JISYO 群
// cost は小さいほど一般的。ラティス変換(最小コスト経路)がこの値で分割を決める。
// usage: node tools/build-basedict2.js > basedict.json
const fs = require('fs');
const path = require('path');
const IPADic = require('mecab-ipadic-seed');

const kataToHira = (s) =>
  s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
const GOOD_YOMI = /^[ぁ-んー]+$/;
const POS_OK = new Set(['名詞', '動詞', '形容詞', '副詞', '連体詞', '感動詞', '接続詞', '接頭詞']);
const MAX_CANDS = 16;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v)));

async function main() {
  const pool = {}; // yomi -> [{surf, cost}]
  const put = (yomi, surf, cost) => {
    if (!GOOD_YOMI.test(yomi) || yomi === surf || yomi.length < 2) return;
    (pool[yomi] ??= []).push({ surf, cost });
  };

  // ---- mozc(コストが一番信頼できる層) ----
  for (let i = 0; i <= 9; i++) {
    const f = path.join(__dirname, '..', 'data', `mozc-dictionary0${i}.txt`);
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      const c = line.split('\t');
      if (c.length < 5) continue;
      const yomi = c[0], surf = c[4];
      if (!/[一-鿿々ァ-ヶーA-ZＡ-Ｚ]/.test(surf)) continue;
      put(yomi, surf, clamp(200 + Number(c[3]) / 10, 120, 1400));
    }
  }
  console.error(`mozc done: ${Object.keys(pool).length} readings`);

  // ---- IPADIC(活用形が展開されている) + 接続形の機械展開 ----
  const taSuffixes = (surf, baseForm) => {
    const last = surf.slice(-1);
    const voiced = last === 'ん' || (last === 'い' && baseForm.endsWith('ぐ'));
    return voiced ? ['だ', 'で', 'だら', 'でも', 'だり'] : ['た', 'て', 'たら', 'ても', 'たり'];
  };
  const dic = new IPADic();
  await dic.readTokenInfo((line) => {
    const f = line.split(',');
    if (f.length < 12) return;
    const surf = f[0], pos = f[4], pos1 = f[5];
    const conjType = f[8], conjForm = f[9], baseForm = f[10], reading = f[11];
    if (!POS_OK.has(pos)) return;
    if (pos1 === '数' || pos1 === '非自立' || pos1 === '特殊') return;
    if (!reading || reading === '*') return;
    const cost = clamp(150 + Number(f[3]) / 12, 100, 1500);
    const yomi = kataToHira(reading);
    put(yomi, surf, cost);
    if (pos === '動詞') {
      if (conjForm === '連用タ接続')
        for (const s of taSuffixes(surf, baseForm)) put(yomi + s, surf + s, cost + 30);
      if (conjForm === '連用形') {
        for (const s of ['ます', 'ました', 'ません', 'ましょう']) put(yomi + s, surf + s, cost + 30);
        if (/^(一段|カ変|サ変)/.test(conjType))
          for (const s of ['た', 'て', 'たら', 'ても', 'たり']) put(yomi + s, surf + s, cost + 30);
      }
      if (conjForm === '未然形')
        for (const s of ['ない', 'なかった', 'ず']) put(yomi + s, surf + s, cost + 30);
    }
    if (pos === '形容詞') {
      if (conjForm === '連用タ接続') for (const s of ['た', 'たり']) put(yomi + s, surf + s, cost + 30);
      if (conjForm === '連用テ接続') for (const s of ['て', 'ない', 'なかった']) put(yomi + s, surf + s, cost + 30);
    }
  });
  console.error(`ipadic done: ${Object.keys(pool).length} readings`);

  // ---- SKK-JISYO 群(語彙の受け皿。コストは高めの固定) ----
  for (const name of ['L', 'jinmei', 'geo', 'propernoun', 'station']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'data', `SKK-JISYO.${name}.utf8`), 'utf8');
    let inOkuriNasi = name !== 'L';
    for (const line of src.split('\n')) {
      if (line.startsWith(';; okuri-nasi entries.')) { inOkuriNasi = true; continue; }
      if (line.startsWith(';')) continue;
      if (name === 'L' && !inOkuriNasi) continue;
      const sp = line.indexOf(' ');
      if (sp < 0) continue;
      const yomi = line.slice(0, sp);
      if (!GOOD_YOMI.test(yomi)) continue;
      line
        .slice(sp + 1)
        .split('/')
        .map((c) => c.split(';')[0])
        .filter((c) => c && !c.includes('('))
        .forEach((c, i) => put(yomi, c, 1250 + i * 15));
    }
    console.error(`SKK-JISYO.${name} done`);
  }

  // ---- mozc-UT 層(jawiki/人名/地名/sudachi。受け皿: SKKと同格の底層) ----
  // 形式は mozc と同じ TSV。表記は漢字/かなを含むものだけ(英字のみは小説で使わない)
  for (const name of ['mozcdic-ut-jawiki', 'mozcdic-ut-personal-names', 'mozcdic-ut-place-names', 'mozcdic-ut-sudachidict']) {
    const f = path.join(__dirname, '..', 'data', `${name}.txt`);
    if (!fs.existsSync(f)) { console.error(`${name}: なし(スキップ)`); continue; }
    let added = 0;
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      const c = line.split('	');
      if (c.length < 5) continue;
      const yomi = c[0], surf = c[4];
      if (!/[一-鿿々ァ-ヶ]/.test(surf)) continue;
      if (yomi.length > 10) continue; // 文・作品名級の長尺読みは打たない(ラティス窓も12字)
      if (pool[yomi]) continue; // 穴埋め専任: 既存読みの候補は太らせない
      put(yomi, surf, clamp(1300 + (Number(c[3]) - 8000) / 20, 1300, 1450));
      added++;
    }
    console.error(`${name} done: +${added}`);
  }

  // ---- 集約: 同表記は最小コスト、コスト昇順で cap ----
  const dict = {};
  for (const [yomi, arr] of Object.entries(pool)) {
    const best = {};
    for (const { surf, cost } of arr) if (best[surf] === undefined || cost < best[surf]) best[surf] = cost;
    dict[yomi] = Object.entries(best)
      .sort((a, b) => a[1] - b[1])
      .slice(0, MAX_CANDS);
  }
  console.error(`total readings: ${Object.keys(dict).length}`);
  process.stdout.write(JSON.stringify(dict));
}
main();
