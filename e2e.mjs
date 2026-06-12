// e2e: 偽DOMの上で editor.js を起動し、keydown 列 → 描画結果を検証する
// usage: node e2e.js
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- 偽DOM ----
class FakeEl {
  constructor(id) {
    this.id = id;
    this.innerHTML = '';
    this.textContent = '';
    this.value = '';
    this.onclick = null;
    this.onchange = null;
    this.classList = {
      _set: new Set(),
      add: (...c) => c.forEach((x) => this.classList._set.add(x)),
      remove: (...c) => c.forEach((x) => this.classList._set.delete(x)),
    };
    this.scrollTop = 0;
  }
  get scrollHeight() { return 0; }
  querySelector() { return new FakeEl('q'); }
  querySelectorAll() { return []; }
}
const els = {};
const el = (id) => (els[id] ??= new FakeEl(id));
const handlers = {};
globalThis.document = {
  getElementById: el,
  querySelector: () => new FakeEl('q'),
  querySelectorAll: () => [],
  createElement: () => new FakeEl('a'),
  addEventListener: (type, fn) => (handlers[type] = fn),
};
globalThis.localStorage = {
  _m: {},
  getItem(k) { return this._m[k] ?? null; },
  setItem(k, v) { this._m[k] = String(v); },
};
globalThis.llmStub = { calls: 0, reply: '2', delay: 10, prompts: [], harvest: '', harvestCalls: 0 };
globalThis.fetch = async (p, opts = {}) => {
  const url = String(p);
  if (url.startsWith('http://127.0.0.1:18434')) {
    if (url.endsWith('/health')) return { json: async () => ({ status: 'ok' }) };
    // /v1/chat/completions: 審査員 or 採取の偽応答
    const pr = JSON.parse(opts.body).messages[0].content;
    if (pr.includes('固有名詞')) {
      llmStub.harvestCalls++;
      return { json: async () => ({ choices: [{ message: { content: llmStub.harvest } }] }) };
    }
    llmStub.calls++;
    llmStub.prompts.push(pr);
    await new Promise((r) => setTimeout(r, llmStub.delay));
    return { json: async () => ({ choices: [{ message: { content: llmStub.reply } }] }) };
  }
  return { json: async () => JSON.parse(fs.readFileSync(path.join(__dirname, url), 'utf8')) };
};
globalThis.setInterval = () => 0;
globalThis.URL = { createObjectURL: () => '' };
globalThis.Blob = class {};

// ---- editor 起動 ----
await import('./editor.js');
await new Promise((r) => setTimeout(r, 300)); // main() の fetch 完了待ち
assert(/基底|審査員/.test(el('status').textContent), '起動: 辞書+審査員スタブ');

const layout = JSON.parse(fs.readFileSync(path.join(__dirname, 'layout.json'), 'utf8'));
const ROWS = ['QWERTYUIOP', 'ASDFGHJKL;', 'ZXCVBNM,./'];
const codeOf = (label) =>
  label === ';' ? 'Semicolon' : label === ',' ? 'Comma' : label === '.' ? 'Period' : label === '/' ? 'Slash' : 'Key' + label;
const keyFor = (ch) => {
  const e2 = Object.entries(layout.slots).find(([c]) => c === ch);
  if (!e2) return null;
  const id = e2[1];
  return { code: codeOf(id.replace('+SP', '')), chord: id.endsWith('+SP') };
};

const ev = (code, extra = {}) => ({ code, preventDefault() {}, metaKey: false, ctrlKey: false, repeat: false, ...extra });
const down = (code, extra) => handlers.keydown(ev(code, extra));
const up = (code) => handlers.keyup(ev(code));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// かな1字を打つ(単打/和音/゛変形を自動で解決)
const CYCLE_STEPS = (() => {
  const m = {};
  const reg = (base, forms) => forms.forEach((f, i) => (m[f] = { base, steps: i + 1 }));
  'かきくけこさしすせそたちつてと'.split('').forEach((c, i) => reg(c, ['がぎぐげござじずぜぞだぢづでど'[i]]));
  'はひふへほ'.split('').forEach((c, i) => reg(c, ['ばびぶべぼ'[i], 'ぱぴぷぺぽ'[i]]));
  'あいうえお'.split('').forEach((c, i) => reg(c, ['ぁぃぅぇぉ'[i]]));
  return m;
})();
async function type(ch) {
  const comp = !keyFor(ch) && CYCLE_STEPS[ch];
  const target = comp ? comp.base : ch;
  const k = keyFor(target);
  assert(k, `キーがある: ${target}`);
  if (k.chord) { down(k.code, { shiftKey: true }); up(k.code); } // シフト面=Shift+キー
  else { down(k.code); up(k.code); }
  if (comp) for (let i = 0; i < comp.steps; i++) await type('゛');
}
async function typeWord(s) { for (const c of s) await type(c); }
const html = () => el('text').innerHTML;
const plain = () =>
  html()
    .replace(/<span class="(ghost|candinfo|closers)">[^<]*<\/span>/g, '') // 予測・候補カウンタ・予約閉じは本文ではない
    .replace(/<[^>]*>/g, '');

let n = 0;
const ok = (name) => console.log(`  ✔ ${++n} ${name}`);

// ---- 1. 単打 ----
await type('か');
assert(plain().startsWith('　か'), '単打で か(行頭は自動字下げ)');
ok('単打');

// ---- 2. ゛変形 ----
await type('゛');
assert(plain().startsWith('　が'), '゛で が');
ok('゛変形(か→が)');

// ---- 3. 和音 ----
const chordChar = Object.entries(layout.slots).find(([c, id]) => id.endsWith('+SP') && /^[ぁ-ん]$/.test(c))[0];
await type(chordChar);
assert(plain().includes(chordChar), `和音で ${chordChar}`);
ok(`シフト面(Shift+key → ${chordChar})`);

// ---- 4. 未確定(青字) ----
assert(html().includes('class="pend"'), '未確定かなが pend span');
ok('未確定の青字表示');

// ---- 5. …… 一打 ----
await type('…');
assert(plain().includes('……'), '…キー一打で ……');
down('Backspace');
assert(!plain().includes('…'), 'Backspace で……が単位で消える');
ok('……(偶数規約)');

// ---- 6. 後置変換 + Enter決定 ----
down('Enter'); // 改行で区切る
await typeWord('かみ');
down('MetaRight'); // 変換
assert(el('mode').textContent === '▼', '変換で▼モード');
const cand1 = html().match(/class="cand">▼([^<]*)</)?.[1];
assert(cand1 && cand1 !== 'かみ', `候補が出る: ${cand1}`);
down('Enter');
assert(plain().includes(cand1), `Enterで決定: ${cand1}`);
assert(html().includes('conv-flash'), '確定ハイライトが付く');
ok(`後置変換(かみ→${cand1})`);

// ---- 7. 候補送り(循環の末尾にひらがな) ----
await typeWord('かみ');
down('MetaRight');
let seen = [], guard = 0;
let cur = html().match(/class="cand">▼([^<]*)</)?.[1];
while (!seen.includes(cur) && guard++ < 40) {
  seen.push(cur);
  down('MetaRight');
  cur = html().match(/class="cand">▼([^<]*)</)?.[1];
}
assert(seen.includes('かみ'), `候補循環にひらがな無変換が居る: [${seen.slice(0, 6)}...]`);
down('AltLeft'); // キャンセル
assert(plain().endsWith('かみ'), 'キャンセルでかなに戻る');
ok('候補循環+キャンセル');

// ---- 8. 予測ゴースト + 予測込み変換 ----
down('Backspace'); down('Backspace'); // かみ を消す
await typeWord('かのじ');
const ghost = html().match(/class="ghost">([^<]*)</)?.[1];
assert(ghost && ghost.length >= 1, `ゴーストが出る: "${ghost}"`);
down('MetaRight');
const cand2 = html().match(/class="cand">▼([^<]*)</)?.[1];
assert(cand2 === '彼女', `予測込み変換: かのじ → ${cand2}`);
down('AltLeft');
assert(plain().endsWith('かのじ'), 'キャンセルは打った分だけ戻す(予測分は入らない)');
ok(`予測(かのじ +゛ → ghost"${ghost}" → 彼女)`);

// ---- 9. 確定学習(userDict が候補順を上書き) ----
await typeWord('ょ'); // かのじょ完成
down('MetaRight');
down('MetaRight'); // 第2候補へ
const second = html().match(/class="cand">▼([^<]*)</)?.[1];
down('Enter'); // 第2候補で確定 → 学習
await typeWord('かのじょ');
down('MetaRight');
const relearned = html().match(/class="cand">▼([^<]*)</)?.[1];
assert(relearned === second, `確定学習で第一候補が ${second} に変わる(実際: ${relearned})`);
ok('確定学習の昇格');

// ---- 10b. Tab で予測をひらがな確定 ----
down('Enter');
await typeWord('かのじ');
const ghost2 = html().match(/class="ghost">([^<]*)</)?.[1];
down('Tab');
assert(plain().endsWith('かのじ' + ghost2), `Tabで予測確定: かのじ+${ghost2}`);
assert(html().includes('class="pend"'), 'Tab確定後も未確定(青)のまま=続けて変換可');
ok(`Tab予測確定(かのじ→かのじ${ghost2})`);

// ---- 10c. 7=変換 / 8=カタカナ ----
down('Enter');
await typeWord('かみ');
down('Digit7');
assert(el('mode').textContent === '▼', '7キーで変換が発動');
down('AltLeft');
await typeWord('ねこ');
down('Digit8');
assert(plain().endsWith('ネコ'), '8キーでカタカナ確定');
// 候補循環の最末尾にもカタカナが居る
await typeWord('ねこ');
down('Digit7');
let seenK = [], gk = 0, ck = html().match(/class="cand">▼([^<]*)</)?.[1];
while (!seenK.includes(ck) && gk++ < 40) { seenK.push(ck); down('Digit7'); ck = html().match(/class="cand">▼([^<]*)</)?.[1]; }
assert(seenK.includes('ネコ'), `候補循環にカタカナ: [${seenK.slice(0,8)}]`);
down('AltLeft');
ok('7=変換 / 8=カタカナ / 循環末尾カタカナ');

// ---- 10d. F1〜F10 = 全角数字 ----
down('Enter');
down('F1'); down('F7'); down('F10');
assert(plain().endsWith('１７０'), `Fキーで全角数字(F7は数字、カタカナではない): ${plain().slice(-5)}`);
ok('F1〜F10=数字(F10=0)');

// ---- 10e. ラティス変換(最低限の構文: は|会する でなく 破壊|する) ----
down('Enter');
await typeWord('をはかいする');
down('Digit7');
const candL = html().match(/class="cand">▼([^<]*)</)?.[1];
assert(candL && candL.includes('破壊'), `ラティスが破壊するを選ぶ: ${candL}`);
down('Enter');
assert(plain().endsWith('破壊する'), `確定: ${plain().slice(-8)}`);
ok(`ラティス変換(をはかいする→${candL})`);

// ---- 10f. Enter決定は改行を入れない(リピート・保留かな競合も) ----
down('Enter');
await typeWord('かみ');
down('Digit7');
const before10f = plain();
down('Enter'); // 決定
assert(!plain().endsWith('\n'), 'Enter決定で改行が入らない');
down('Enter', { repeat: true }); // キーリピートの2発目
assert(!plain().endsWith('\n'), 'リピートEnterでも改行が入らない');
// 保留かな(和音窓内)+即Enter: かなは確定扱い、改行は入らない
await typeWord('かみ');
down('Digit7');
const kCode = keyFor('の').code; // 保留を作る(待たずに即Enter)
down(kCode); up(kCode);
down('Enter');
assert(!plain().endsWith('\n'), '保留かな+即Enterでも改行は入らない');
ok('Enter=決定のみ(改行バグ封じ)');

// ---- 10g. Enter: 未確定かなは「確定のみ」、改行は未確定なしの時だけ ----
down('Enter'); down('Enter'); // 確実に未確定なし状態へ
const base10g = plain();
await typeWord('かな');
down('Enter'); // 1回目: ひらがな確定のみ
assert(plain() === base10g + '　かな', `確定のみで改行なし+自動字下げ: ${JSON.stringify(plain().slice(-5))}`);
assert(!html().includes('class="pend"'), '青字が消えて確定済みになる');
down('Enter'); // 2回目: 未確定がないので改行
assert(plain() === base10g + '　かな\n', '2回目のEnterで改行');
ok('Enter=ひらがな確定と改行の分離');

// ---- 10. 活用形(基底辞書v2) ----
down('Enter');
await typeWord('はしった');
down('MetaRight');
const cand3 = html().match(/class="cand">▼([^<]*)</)?.[1];
assert(cand3 === '走った', `活用形変換: はしった → ${cand3}`);
ok('活用形(はしった→走った)');

// ---- 17. LLM審査員: 推奨候補に差し替える ----
down('Enter'); down('Enter');
llmStub.reply = '2'; llmStub.delay = 10; llmStub.calls = 0;
await typeWord('かみ');
down('Digit7');
const first17 = html().match(/class="cand">▼([^<]*)</)?.[1];
const total17 = Number(html().match(/\(1\/(\d+)\)/)?.[1]);
await wait(80); // 審査員の応答を待つ
const after17 = html().match(/class="cand">▼([^<]*)</)?.[1];
const total17b = Number(html().match(/\(1\/(\d+)\)/)?.[1]);
assert(llmStub.calls === 1, '審査員が1回呼ばれた');
assert(after17 !== first17, `最初の変換は審査員の選択になる: ${first17}→${after17}`);
assert(el('status').textContent.includes('第一候補に'), 'status に明示される');
assert(total17b < total17, `不自然候補がフィルタされる: ${total17}→${total17b}`);
assert(llmStub.prompts[0].includes('不自然'), 'プロンプトは審査形式');
down('Space'); // 次候補=元の第一候補(辞書トップ)が残っている
const pick17 = html().match(/class="cand">▼([^<]*)</)?.[1];
assert(pick17 === first17, `元の第一候補は次に控える: ${pick17}`);
down('AltLeft');
ok(`審査員が第一候補を決める(${first17}→${after17}、フィルタ${total17}→${total17b})`);

// ---- 18. 審査員: ユーザが先に候補送りしたら黙る ----
llmStub.delay = 100; llmStub.calls = 0;
down('Backspace'); down('Backspace');
await typeWord('かみ');
down('Digit7');
down('Digit7'); // ユーザが先に候補送り(candIdx=1)
const userPick = html().match(/class="cand">▼([^<]*)</)?.[1];
await wait(180); // 遅れて審査員応答が届く
const after18 = html().match(/class="cand">▼([^<]*)</)?.[1];
assert(after18 === userPick, `ユーザ選択が保持される: ${after18}`);
down('AltLeft');
ok('審査員はユーザ先行時に黙る');

// ---- 19. 審OFF なら呼ばれない ----
el('llm').onclick(); // OFF
llmStub.calls = 0; llmStub.delay = 5;
down('Backspace'); down('Backspace');
await typeWord('かみ');
down('Digit7');
await wait(60);
assert(llmStub.calls === 0, '審OFFで審査員は呼ばれない');
assert(localStorage.getItem('ne:llm') === 'off', 'OFFが永続化される');
el('llm').onclick(); // ONに戻す
down('AltLeft');
ok('審OFF時は不召喚+永続化');

// ---- 19b. Space=変換・候補送り ----
down('Enter'); down('Enter');
await typeWord('かみ');
down('Space');
assert(el('mode').textContent === '▼', 'Spaceで変換が発動');
const sp1 = html().match(/class="cand">▼([^<]*)</)?.[1];
down('Space');
const sp2 = html().match(/class="cand">▼([^<]*)</)?.[1];
assert(sp1 !== sp2, `Space連打で候補送り: ${sp1}→${sp2}`);
down('Enter');
assert(plain().endsWith(sp2), 'Enterで決定');
ok('Space=変換・候補送り');

// ---- 19c. ……=記号変換の入口(――・括弧ペア) ----
down('Enter');
await type('…'); // ……が入る
down('Space');
const dash1 = html().match(/class="cand">▼([^<]*)</)?.[1];
assert(dash1 === '――', `……をSpaceで棒線に: ${dash1}`);
down('Space');
const pair1 = html().match(/class="cand">▼([^<]*)</)?.[1];
assert(pair1 === '「」', `候補に「」が並ぶ: ${pair1}`);
down('Enter'); // 「」で確定 → カーソルは中
assert(plain().endsWith('「') && html().includes('class="closers"'), '開きが入り閉じは予約');
down('Enter'); // 閉じ実体化
assert(plain().endsWith('「」'), '……→「」変換の完成');
await type('…');
down('Space'); down('Enter');
assert(plain().endsWith('――'), '――で確定');
down('Space'); // 逆方向
const dash2 = html().match(/class="cand">▼([^<]*)</)?.[1];
assert(dash2 === '……', `――をSpaceで三点リーダに戻せる: ${dash2}`);
down('AltLeft');
assert(plain().endsWith('――'), 'キャンセルで――のまま');
ok('……=記号変換の入口(――/「」/逆方向)');

// ---- 19d. 自動閉じカッコ(間にカーソル) ----
down('Enter');
await type('「');
assert(html().includes('class="closers"') && html().includes('」'), '「で閉じが予約表示される');
assert(!plain().endsWith('」'), '本文にはまだ」が入っていない');
await typeWord('かな');
await type('」');
assert(plain().endsWith('「かな」'), `」で閉じる: ${plain().slice(-6)}`);
assert(!html().includes('class="closers"'), '予約が消化された');
// Enterでも閉じる
await type('「');
await typeWord('かな');
down('Enter'); // かな確定+閉じ実体化
assert(plain().endsWith('「かな」'), `Enterで閉じ実体化: ${plain().slice(-6)}`);
// 変換でペア: かっこ→『』、カーソルは中
await typeWord('かっこ');
down('Space');
const pairCand = html().match(/class="cand">▼([^<]*)</)?.[1];
assert(['『』','（）','「」'].includes(pairCand), `ペア候補: ${pairCand}`);
down('Enter');
assert(plain().endsWith(pairCand[0]), 'открыき側だけ本文に入りカーソルは中');
assert(html().includes(pairCand[1]), '閉じは予約表示');
down('Enter'); // 閉じ実体化
assert(plain().endsWith(pairCand), '確定でペア完成');
ok('自動閉じカッコ+かっこ変換');

// ---- 19e. 作法エンジン(字下げ・！？アキ・。」除去) ----
down('Enter');
await typeWord('かな');
assert(/\n　かな$/.test(plain()), `地の文は自動字下げ: ${JSON.stringify(plain().slice(-4))}`);
down('Enter'); down('Enter');
await type('「');
assert(/\n「$/.test(plain()), 'セリフ行は字下げしない');
await typeWord('なに');
await type('！');
await typeWord('かな');
assert(plain().includes('！　かな'), `！の後に全角アキ: ${JSON.stringify(plain().slice(-6))}`);
await type('。');
await type('」');
assert(plain().endsWith('かな」') && !plain().includes('。」'), `。」の句点が落ちる: ${plain().slice(-8)}`);
ok('作法エンジン(字下げ/！？アキ/。」)');

// ---- 19f. LLM採取で固有名詞を自動登録(2回観察) ----
down('Enter');
await typeWord('りふぃあ');
down('Digit8'); // リフィア(1回目)
await typeWord('と');
await typeWord('りふぃあ');
down('Digit8'); // リフィア(2回目)
down('Enter');
llmStub.harvest = 'リフィア,りふぃあ\nミスリル,みすりる';
el('save').onclick(); // 保存→採取が走る
await wait(60);
assert(llmStub.harvestCalls >= 1, '採取が呼ばれた');
assert(el('status').textContent.includes('リフィア'), `自動登録の通知: ${el('status').textContent}`);
assert(!el('status').textContent.includes('ミスリル'), '原稿に無い語(幻覚)は登録されない');
llmStub.reply = '1'; // 偽審査員は第一候補支持にしておく
await typeWord('りふぃあ');
down('Space');
await wait(60);
const auto1 = html().match(/class="cand">▼([^<]*)</)?.[1];
assert(auto1 === 'リフィア', `自動登録語が第一候補: ${auto1}`);
down('Enter');
ok('LLM採取→自動登録(幻覚ガード込み)');

// ---- 19g. レビュー修正の検証: CAND中Backspace復元 / 採取走査位置の永続化 ----
down('Enter');
llmStub.reply = '1';
await typeWord('かみ');
down('Space');
down('Backspace'); // 候補をやめてかなに戻す(MARK残骸が消えたことの確認)
assert(plain().endsWith('かみ'), `CAND中Backspaceで打った分が戻る: ${plain().slice(-3)}`);
assert(el('mode').textContent !== '▽', 'MARKモードは存在しない');
assert(Number(localStorage.getItem('ne:lastScanLen') || 0) > 0, 'llmHarvestの走査位置が永続化されている');
ok('CAND-Backspace復元+走査位置の永続化');

// ---- 20. 効果音トグルの永続化 ----
const sBefore = localStorage.getItem('ne:sound');
el('sound').onclick();
assert(localStorage.getItem('ne:sound') !== sBefore || sBefore === null, '♪トグルが永続化される');
el('sound').onclick();
ok('効果音トグル');

// ---- 27. 縦書きレイアウト(42字折返し・ぶら下がり・禁則・見開き) ----
const L = globalThis.__neLayout;
const tk = (s) => [...s].map((c) => ({ c }));
let ls = L(tk('あ'.repeat(50)));
assert(ls[0].length === 42 && ls[1].length === 8, `42字で折り返す: ${ls[0].length}/${ls[1].length}`);
ls = L(tk('い'.repeat(42) + '。' + 'う'));
assert(ls[0].length === 43 && ls[0][42].c === '。' && ls[1][0].c === 'う', 'ぶら下がり: 句点が43字目に残る');
ls = L(tk('え'.repeat(41) + '「お'));
assert(ls[0].length === 41 && ls[1][0].c === '「', '行末禁則: 開き括弧は次行へ送られる');
ls = L(tk('か'.repeat(42) + 'ょ' + 'き'));
assert(ls[0][42].c === 'ょ' && ls[1][0].c === 'き', '行頭禁則: 小書きは追い込み');
el('tate').onclick(); // 縦書きON
assert(html().includes('class="spread"') && html().includes('class="pagein"'), '見開きが描画される');
assert(el('count').textContent.includes('見開き'), 'ページカウンタ表示');
el('tate').onclick(); // 戻す
assert(!html().includes('class="spread"'), '横書きに復帰');
ok('縦書き(電撃文庫42×17・ぶら下がり・禁則・見開き)');

// ---- 28. 挿入編集(カーソル移動・途中挿入・途中変換・矢印) ----
llmStub.reply = '1';
down('Enter'); down('Enter');
await typeWord('かきく');
down('Enter'); // 確定(改行なし)
const L28 = plain().length;
globalThis.__neMove(L28 - 2); // か|きく の間へ
await typeWord('さ');
assert(plain().endsWith('　かさきく'), `途中挿入: ${plain().slice(-6)}`);
assert(html().indexOf('class="caret"') < html().length && plain().length === L28 + 1, 'tailが描画され文字数が合う');
down('Backspace');
assert(plain().endsWith('　かきく'), '途中削除');
down('ArrowLeft');
await typeWord('た');
assert(plain().endsWith('　たかきく'), `矢印移動+挿入: ${plain().slice(-6)}`);
// 途中での変換
globalThis.__neMove(plain().length - 1); // 最後の く の前
await typeWord('かみ');
down('Space');
down('Enter');
assert(plain().endsWith('髪く'), `途中変換: ${plain().slice(-4)}`);
globalThis.__neMove(plain().length); // 末尾へ戻す
ok('挿入編集(移動・挿入・削除・途中変換)');

console.log(`\nall ${n} tests passed`);
process.exit(0);
