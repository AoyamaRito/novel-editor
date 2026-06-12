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
    if (pr.includes('棚卸し')) {
      return { json: async () => ({ choices: [{ message: { content: llmStub.curateReply || 'なし' } }] }) };
    }
    if (pr.includes('すべてひらがなに直して')) {
      return { json: async () => ({ choices: [{ message: { content: llmStub.kanaReply || '' } }] }) };
    }
    if (pr.includes('品詞を、次から一語')) {
      return { json: async () => ({ choices: [{ message: { content: llmStub.posReply || '固有名詞' } }] }) };
    }
    if (pr.includes('固有名詞(人名')) {
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
  /^[0-9]$/.test(label) ? 'Digit' + label :
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
    .replace(/<span class="(ghost|candinfo|closers|nl)">[^<]*<\/span>/g, '') // 予測・候補カウンタ・予約閉じ・改行マークは本文ではない
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

// ---- 10c. ：=表記を開く(カタカナ⇄ひらがな) / 数字段4578=がだじで ----
down('Enter');
await typeWord('ねこ');
down('Quote');
assert(html().match(/class="cand">▼([^<]*)</)?.[1] === 'ネコ', '：でカタカナ候補');
down('Quote');
assert(html().match(/class="cand">▼([^<]*)</)?.[1] === 'ねこ', '：もう一押しでひらがなに戻る');
down('Quote');
assert(html().match(/class="cand">▼([^<]*)</)?.[1] === 'ネコ', '：は循環');
down('Enter');
assert(plain().endsWith('ネコ'), 'Enterで決定→ネコ');
down('Digit8'); down('Digit4'); down('Digit7'); down('Digit5');
assert(plain().endsWith('がだじで'), `数字段8475=がだじで: ${plain().slice(-6)}`);
down('Enter');
// 漢字候補の表示中からも：で開いて戻せる
await typeWord('かみ');
down('Space');
assert(el('mode').textContent === '▼', 'Spaceで変換が発動');
down('Quote');
assert(html().match(/class="cand">▼([^<]*)</)?.[1] === 'カミ', '漢字候補から：でカタカナに開く');
down('AltLeft');
down('Enter');
// 候補循環の最末尾にもカタカナが居る
await typeWord('ねこ');
down('Space');
let seenK = [], gk = 0, ck = html().match(/class="cand">▼([^<]*)</)?.[1];
while (!seenK.includes(ck) && gk++ < 40) { seenK.push(ck); down('Space'); ck = html().match(/class="cand">▼([^<]*)</)?.[1]; }
assert(seenK.includes('ネコ'), `候補循環にカタカナ: [${seenK.slice(0,8)}]`);
down('AltLeft');
ok('：=表記を開く(候補中も) / 数字段がだじで / 循環末尾カタカナ');

// ---- 10d. F1〜F10 = 全角数字 ----
down('Enter');
down('F1'); down('F7'); down('F10');
assert(plain().endsWith('１７０'), `Fキーで全角数字(F7は数字、カタカナではない): ${plain().slice(-5)}`);
ok('F1〜F10=数字(F10=0)');

// ---- 10e. ラティス変換(最低限の構文: は|会する でなく 破壊|する) ----
down('Enter');
await typeWord('をはかいする');
down('Space');
const candL = html().match(/class="cand">▼([^<]*)</)?.[1];
assert(candL && candL.includes('破壊'), `ラティスが破壊するを選ぶ: ${candL}`);
down('Enter');
assert(plain().endsWith('破壊する'), `確定: ${plain().slice(-8)}`);
ok(`ラティス変換(をはかいする→${candL})`);

// ---- 10f. Enter決定は改行を入れない(リピート・保留かな競合も) ----
down('Enter');
await typeWord('かみ');
down('Space');
const before10f = plain();
down('Enter'); // 決定
assert(!plain().endsWith('\n'), 'Enter決定で改行が入らない');
down('Enter', { repeat: true }); // キーリピートの2発目
assert(!plain().endsWith('\n'), 'リピートEnterでも改行が入らない');
// 保留かな(和音窓内)+即Enter: かなは確定扱い、改行は入らない
await typeWord('かみ');
down('Space');
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
down('Space');
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
down('Space');
down('Space'); // ユーザが先に候補送り(candIdx=1)
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
down('Space');
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
assert(plain().endsWith('「」') && html().includes('caret"></span>」'), '「」が実体で入りカーソルは中');
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

// ---- 19d. 自動閉じカッコ(実体で即挿入・カーソルは中)。」は直接キーを持たない ----
down('Enter');
await type('「');
assert(plain().endsWith('「」'), '「で閉じも実体で入る');
assert(html().includes('caret"></span>」'), 'カーソルは中');
await typeWord('かな');
down('Enter'); // かな確定+閉じの外へ
assert(plain().endsWith('「かな」'), `Enterで閉じの外へ: ${plain().slice(-6)}`);
assert(!html().includes('caret"></span>」'), 'カーソルが」の後ろに出た');
// 直後のBackspaceはペアごと削除
await type('「');
assert(plain().endsWith('「」'), 'ペア挿入');
down('Backspace');
assert(plain().endsWith('「かな」'), `Backspaceでペアごと消える: ${plain().slice(-6)}`);
// 変換でペア: かっこ→『』、カーソルは中
await typeWord('かっこ');
down('Space');
const pairCand = html().match(/class="cand">▼([^<]*)</)?.[1];
assert(['『』','（）','「」'].includes(pairCand), `ペア候補: ${pairCand}`);
down('Enter');
assert(plain().endsWith(pairCand) && html().includes(`caret"></span>${pairCand[1]}`), '閉じも実体・カーソルは中');
down('Enter'); // 閉じ実体化
assert(plain().endsWith(pairCand), '確定でペア完成');
ok('自動閉じカッコ+かっこ変換');

// ---- 19e. 作法エンジン(字下げ・！？アキ・。」除去) ----
down('Enter');
await typeWord('かな');
assert(/\n　かな$/.test(plain()), `地の文は自動字下げ: ${JSON.stringify(plain().slice(-4))}`);
down('Enter'); down('Enter');
await type('「');
assert(/\n「」$/.test(plain()), 'セリフ行は字下げしない');
await typeWord('なに');
await type('！');
await typeWord('かな');
assert(plain().includes('！　かな'), `！の後に全角アキ: ${JSON.stringify(plain().slice(-6))}`);
await type('。');
down('Enter'); // 閉じ実体化
assert(plain().endsWith('かな」') && !plain().includes('。」'), `。」の句点が落ちる(Enter閉じでも): ${plain().slice(-8)}`);
ok('作法エンジン(字下げ/！？アキ/。」)');

// ---- 19f. LLM採取で固有名詞を自動登録(2回観察) ----
down('Enter');
await typeWord('りふぃあ');
down('Quote'); // リフィア(1回目): ：でカタカナ候補→次のかなで決定
await typeWord('と');
await typeWord('りふぃあ');
down('Quote'); // リフィア(2回目)
down('Enter'); // 決定
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
const KH_TEST = new Set([...'」』）！？…―ーゃゅょっァィゥェォャュョッ。、']);
let ls = L(tk('あ'.repeat(50)));
assert(ls[0].length === 42 && ls[1].length === 8, `42字で折り返す: ${ls[0].length}/${ls[1].length}`);
ls = L(tk('い'.repeat(42) + '。' + 'う'));
assert(ls[0].length === 43 && ls[0][42].c === '。' && ls[1][0].c === 'う', 'ぶら下がり: 句点が43字目に残る');
ls = L(tk('え'.repeat(41) + '「お'));
assert(ls[0].length === 41 && ls[1][0].c === '「', '行末禁則: 開き括弧は次行へ送られる');
ls = L(tk('か'.repeat(42) + 'ょ' + 'き'));
assert(ls[0].length === 41 && ls[1][0].c === 'か' && ls[1][1].c === 'ょ', '行頭禁則: 小書きは前の字ごと追い出し(電撃式)');
ls = L(tk('あ'.repeat(41) + '……' + 'い'));
const l2s = ls[1].map((x) => x.c).join('');
assert(ls[1][0].c !== '…' && l2s.includes('……'), `……は分割されず行頭にも残らない: ${l2s.slice(0, 4)}`);
assert(ls.every((ln) => !(KH_TEST.has(ln[0]?.c))), '全行の行頭に禁則文字が無い');
ls = L(tk('あ'.repeat(41) + 'だ。」' + 'い'));
assert(ls[0].length === 41 && ls[1].map((x) => x.c).join('').startsWith('だ。」'), '句点+閉じのクラスタは前の字ごと追い出し');
ls = L(tk('ア'.repeat(42) + 'ット'));
assert(ls[1][0].c === 'ア' && ls[1][1].c === 'ッ', 'カタカナ小書きも行頭禁則(追い出し)');
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

// ---- 29. 改行マーク+カーソル行強調 ----
assert(html().includes('class="nl"'), '改行マーク⏎が表示される');
assert(html().includes('id="curline"'), '横書きのカーソル行帯がある');
el('tate').onclick();
assert(html().includes('cur-line'), '縦書きのカーソル行が強調される');
assert(html().includes('class="nl"'), '縦書きでも改行マークが出る');
el('tate').onclick();
ok('改行マーク+カーソル行強調');

// ---- 30. 貼り付け(改行正規化・カーソル位置挿入・即確定) ----
down('Enter'); down('Enter');
const L30 = plain().length;
globalThis.__nePaste('はろー\r\nわーるど');
assert(plain().endsWith('はろー\nわーるど'), `貼り付け+改行正規化: ${JSON.stringify(plain().slice(-9))}`);
assert(!html().includes('class="pend"'), '貼り付けは未確定にならない(即確定)');
globalThis.__neMove(L30 + 3); // はろー の直後
globalThis.__nePaste('ぴこ');
assert(plain().includes('はろーぴこ\n'), '途中貼り付け');
globalThis.__neMove(plain().length);
ok('コピペ(貼り付け・正規化・途中挿入)');

// ---- 31. 打鍵ログ ----
const lg0 = globalThis.__neLogSize();
await typeWord('か');
down('Space');
down('Enter');
assert(globalThis.__neLogSize() > lg0, '打鍵・変換イベントがログに積まれる');
const last = JSON.parse(globalThis.__neLogLast());
assert(typeof last.p === 'string' && last.p.length >= 1, 'ログはハッシュチェーン(前行ハッシュ p 付き)');
ok('打鍵ログ(keydown/conv/pick+ハッシュチェーン=人が書いた証拠)');

// ---- 32. 配列チャートの表示オプション ----
el('chartbtn').onclick();
assert(localStorage.getItem('ne:chart') === 'off', '盤OFFが永続化');
el('chartbtn').onclick();
assert(localStorage.getItem('ne:chart') === 'on', '盤ONに戻る');
ok('配列チャート表示オプション');

// ---- 33. バックアップJSONの往復 ----
const bundle = globalThis.__neExport();
const parsed = JSON.parse(bundle);
assert(parsed.app === 'novel-editor' && parsed.graph && parsed.userDict, 'バックアップに原稿+学習が入っている');
const before33 = plain();
await typeWord('あああ');
down('Enter');
globalThis.__neImport(bundle);
assert(plain() === before33, `復元で原稿が巻き戻る: ${JSON.stringify(plain().slice(-6))}`);
ok('バックアップJSONの書き出し/復元');

// ---- 33b. 監査強化: SHA-256チェーン / paste・mv・state の記録 ----
const nodeCryptoTest = await import('crypto');
for (const v of ['abc', 'こんにちは……「テスト」', '']) {
  const want = nodeCryptoTest.createHash('sha256').update(v).digest('hex');
  assert(globalThis.__neSha(v) === want, `純JS SHA-256 が node:crypto と一致: ${v.slice(0, 8)}`);
}
globalThis.__nePaste('外部テキスト');
let last33 = JSON.parse(globalThis.__neLogLast());
assert(last33.e === 'paste' && last33.s === '外部テキスト', 'paste は全文がログに乗る');
assert(last33.p.length === 64, 'チェーンは SHA-256(64hex)');
globalThis.__neMove(0);
last33 = JSON.parse(globalThis.__neLogLast());
assert(last33.e === 'mv' && last33.to === 0, 'カーソル移動が記録される');
globalThis.__neMove(plain().length);
el('save').onclick();
await wait(30);
assert(globalThis.__neLogAll().some((l) => JSON.parse(l).e === 'state'), 'saveで原稿状態(sha256)がチェーンに固定される');
ok('監査強化(SHA-256一致・paste/mv/state記録)');

// ---- 33c. 句読点の後からの変換(透かし変換) ----
down('Enter'); down('Enter');
llmStub.reply = '1';
await typeWord('かみ');
await type('。');
down('Space'); // 。の後からでも直前のかなが変換対象になる
const candP = html().match(/class="cand">▼([^<]*)</)?.[1];
assert(candP === '髪', `句読点透かし変換: ${candP}`);
down('Enter');
assert(plain().endsWith('髪。'), `確定後は記号の後ろへ: ${plain().slice(-4)}`);
await typeWord('か');
assert(plain().endsWith('髪。か'), 'カーソルが。の後ろに復帰している');
down('Backspace');
// Backspace リピートは実行もログもされる
const lgr0 = globalThis.__neLogSize();
down('Backspace', { repeat: true });
const lastR = JSON.parse(globalThis.__neLogLast());
assert(lastR.e === 'k' && lastR.r === 1, 'リピートBackspaceが r:1 でログに乗る');
ok('句読点透かし変換+リピート記録');

// ---- 34. 公証(OpenTimestamps)の安全動作 ----
await globalThis.__neAnchor(true); // ipc 無し環境では静かにスキップ(例外を出さない)
assert(true, 'anchorNow はブラウザ/テスト環境で安全');
ok('公証アンカー(非Electron環境で無害)');

// ---- 37. 証明書発行(チェーン検証・改ざん検出・外部由来開示) ----
const sha = globalThis.__neSha;
let hd = '0';
const mkLine = (obj) => { const body = JSON.stringify({ ...obj, p: hd }); hd = sha(hd + body); return body; };
const synth = [
  mkLine({ t: 1000, e: 'k', c: 'KeyA', s: 0, m: 'h' }),
  mkLine({ t: 2000, e: 'paste', at: 0, s: 'よそのぶんしょう' }),
  mkLine({ t: 3000, e: 'state', sha: sha('x'), len: 8 }),
].join('\n');
const rep37 = globalThis.__neCert(synth, '', hd);
assert(rep37.includes('✓ 末尾からの連鎖一致'), 'チェーン整合の検証が通る(アンカー無し時の文言)');
assert(rep37.includes('貼り付け: 1件 / 合計 8字'), '外部由来が開示される');
assert(rep37.includes('人間の打鍵を変更する動作は一切行わない'), 'LLM=フィルタ専任の保証が明記される');
const tampered = synth.replace('KeyA', 'KeyB');
assert(globalThis.__neCert(tampered, '', hd).includes('✗'), '改ざんが検出される');
ok('証明書発行(検証・開示・保証明記・改ざん検出)');

// ---- 38. Undo/Redo ----
down('Enter'); down('Enter');
await wait(1250); // snapスロットルを越える
const base38 = plain();
await typeWord('かきく');
down('Enter'); // かな確定
down('KeyZ', { metaKey: true });
assert(plain() === base38, `Undoでバースト前へ: ${JSON.stringify(plain().slice(-4))}`);
const undoEvt = JSON.parse(globalThis.__neLogLast());
assert(undoEvt.e === 'undo' && undoEvt.sha?.length === 64, 'undoが結果ダイジェスト付きで記録される');
down('KeyZ', { metaKey: true, shiftKey: true });
assert(plain().endsWith('　かきく'), 'Redoで復元');
ok('Undo/Redo(Cmd+Z / Cmd+Shift+Z+結果固定)');

// ---- 39. 複数原稿 ----
const txt39 = plain();
globalThis.__neDoc('novel:test2');
assert(plain() === '', '新規作品は空で始まる');
await typeWord('にさくめ');
down('Enter');
globalThis.__neDoc('novel:manuscript');
assert(plain() === txt39, '元の作品が無傷で戻る');
globalThis.__neDoc('novel:test2');
assert(plain().includes('にさくめ'), '二作目の内容も保持');
globalThis.__neDoc('novel:<タグ>');
assert(!el('doc').innerHTML.includes('<タグ>') && el('doc').innerHTML.includes('&lt;タグ&gt;'), '作品名はエスケープされる');
globalThis.__neDoc('novel:manuscript');
el('save').onclick();
await wait(30);
const stEvt = globalThis.__neLogAll().map((l) => JSON.parse(l)).filter((x) => x.e === 'state').pop();
assert(stEvt && stEvt.d === 'novel:manuscript', 'stateイベントに作品IDが乗る');
ok('複数原稿の切替(独立保持+エスケープ+state作品ID)');

// ---- 40. 検索+縦書きページスライダー ----
const pos40 = globalThis.__neFind('髪');
assert(pos40 >= 0, '検索でヒットしカーソルが飛ぶ');
globalThis.__neMove(plain().length);
el('tate').onclick();
assert(html().includes('id="pgbar"'), '縦書きにページスライダー');
el('tate').onclick();
ok('検索(Cmd+F/G)+ページスライダー');

// ---- 41. 証明書: アンカー照合(前方切り詰め検出) ----
{
  let h2 = '0';
  const heads = [];
  const mk = (o) => { const b = JSON.stringify({ ...o, p: h2 }); h2 = globalThis.__neSha(h2 + b); heads.push(h2); return b; };
  const l1 = mk({ t: 1, e: 'k', c: 'KeyA' });
  const l2 = mk({ t: 2, e: 'k', c: 'KeyB' });
  const l3 = mk({ t: 3, e: 'k', c: 'KeyC' });
  const anc = JSON.stringify({ at: '2026-06-12T00:00:00Z', logHash: heads[0], sha256: 'x', proofs: [{}] });
  const full = [l1, l2, l3].join('\n');
  const repFull = globalThis.__neCert(full, anc, h2);
  assert(repFull.includes('アンカー照合: 1/1'), 'フルログでアンカー再現');
  assert(repFull.includes('最古のアンカー時点まで完全性'), '文言が格上げされる');
  const truncated = [l2, l3].join('\n');
  const repTrunc = globalThis.__neCert(truncated, anc, h2);
  assert(repTrunc.includes('アンカー照合: 0/1') && repTrunc.includes('前方欠落の可能性'), '前方切り詰めが検出される');
}
ok('証明書: 前方切り詰め検出(アンカー照合)');

// ---- 42. 監査4R: importはチェーンを壊さない / curDocIdリセット / boot固定 ----
{
  // バッファ内のチェーン連鎖が import を跨いで切れていないこと
  const verifyBuf = () => {
    const ls2 = globalThis.__neLogAll();
    for (let i = 1; i < ls2.length; i++) {
      const prevHead = globalThis.__neSha(JSON.parse(ls2[i - 1]).p !== undefined ? (() => { let h3 = JSON.parse(ls2[0]).p; for (let k = 0; k < i; k++) h3 = globalThis.__neSha(h3 + ls2[k]); return h3; })() : '0');
      // 簡易: 各行の p が直前までの再計算headと一致
    }
    let h3 = JSON.parse(ls2[0]).p;
    for (let k = 0; k < ls2.length; k++) {
      if (JSON.parse(ls2[k]).p !== h3) return k;
      h3 = globalThis.__neSha(h3 + ls2[k]);
    }
    return -1;
  };
  globalThis.__neDoc('novel:test2'); // 別作品を開いた状態で復元
  const bundle42 = globalThis.__neExport();
  globalThis.__neImport(bundle42);
  assert(verifyBuf() === -1, 'import後もログバッファのチェーンが連続');
  const impEvt = globalThis.__neLogAll().map((l) => JSON.parse(l)).filter((x) => x.e === 'import').pop();
  assert(impEvt.importedHead !== undefined, 'importedHeadがデータとして記録される');
  el('save').onclick();
  await wait(30);
  const st42 = globalThis.__neLogAll().map((l) => JSON.parse(l)).filter((x) => x.e === 'state').pop();
  assert(st42.d === 'novel:manuscript', '復元後はcurDocIdがmanuscriptに揃う');
  const boot42 = globalThis.__neLogAll().map((l) => JSON.parse(l)).filter((x) => x.e === 'boot').pop();
  assert(boot42 && boot42.layout?.length === 64, '配列版のshaがチェーンに固定される(boot)');
}
ok('監査4R(import非破壊・curDocId・boot固定)');

// ---- 43. 先読み審査: Spaceの瞬間に審査済み ----
{
  down('Enter'); down('Enter');
  llmStub.reply = '2'; llmStub.delay = 10;
  await typeWord('かみ');
  const callsBefore = llmStub.calls;
  await wait(260); // 先読み(180ms debounce+応答)を待つ
  assert(llmStub.calls > callsBefore, 'ひらがな入力中に先読み審査が走る');
  const callsAfterSpec = llmStub.calls;
  down('Space');
  const inst = html().match(/class="cand">▼([^<]*)</)?.[1];
  assert(inst === '神', `Spaceの瞬間に審査済みの第一候補: ${inst}`);
  assert(llmStub.calls === callsAfterSpec, 'キャッシュ命中なので追加の問い合わせなし');
  down('AltLeft');
  llmStub.reply = '1';
}
ok('先読み審査(入力中に審査→Space即適用)');

// ---- 44. ガリガリ打ち→即Space でも審査が追いつく(非同期フォールバック) ----
{
  down('Enter');
  llmStub.reply = '2'; llmStub.delay = 30;
  await typeWord('かみ'); // 待たずに
  down('Space');          // 即変換(キャッシュ未着の想定)
  await wait(200);        // 追走中の審査が着地する
  const catchUp = html().match(/class="cand">▼([^<]*)</)?.[1];
  assert(catchUp === '神', `高速打鍵でも審査が追いつく: ${catchUp}`);
  down('AltLeft');
  llmStub.reply = '1';
}
ok('ガリガリ打ち耐性(常時追走+非同期着地)');

// ---- 45. 右クリック登録(読み手入力+LLM品詞特定) ----
{
  llmStub.posReply = '固有名詞';
  await globalThis.__neReg('竜胆', 'りんどう', -1);
  await wait(40);
  down('Enter');
  await typeWord('りんどう');
  down('Space');
  await wait(60);
  const reg45 = html().match(/class="cand">▼([^<]*)</)?.[1];
  assert(reg45 === '竜胆', `登録語が第一候補: ${reg45}`);
  down('Enter');
  const evs = globalThis.__neLogAll().map((l) => JSON.parse(l));
  assert(evs.some((x) => x.e === 'reg' && x.s === '竜胆'), '登録がチェーンに記録');
  assert(evs.some((x) => x.e === 'regpos' && x.pos === '固有名詞'), 'LLMの品詞特定が記録');
}
ok('右クリック登録(読み+品詞特定)');

// ---- 46. 音声入力の挿入とチェーン記録 ----
{
  down('Enter');
  const sha46 = globalThis.__neSha('voice-test');
  globalThis.__neVoice('おんせいでかいたぶん', sha46);
  assert(plain().endsWith('おんせいでかいたぶん'), '書き起こしがカーソル位置に入る');
  assert(!html().includes('class="pend"'), '音声入力は確定扱い');
  const stt46 = globalThis.__neLogAll().map((l) => JSON.parse(l)).filter((x) => x.e === 'stt').pop();
  assert(stt46 && stt46.sha === sha46 && stt46.s === 'おんせいでかいたぶん', 'stt事象が音声shaと全文つきで記録');
  const cert46 = globalThis.__neCert('', '', null);
  assert(cert46.includes('音声入力'), '証明書に音声入力の開示欄');
}
ok('音声入力(挿入・チェーン記録・証明書開示)');

// ---- 47. 音声パイプライン(かな化→自前ラティス変換) ----
{
  down('Enter');
  llmStub.kanaReply = 'まほうじんがひかる。';
  const sha47 = globalThis.__neSha('voice-2');
  await globalThis.__neVoicePipe('魔砲陣ガ光ル。', sha47); // whisperが表記を外した想定
  assert(plain().includes('魔法陣'), `自前変換で自分の語彙に直る: ${plain().slice(-12)}`);
  const stt47 = globalThis.__neLogAll().map((l) => JSON.parse(l)).filter((x) => x.e === 'stt').pop();
  assert(stt47.raw === '魔砲陣ガ光ル。' && stt47.kana === 'まほうじんがひかる。', 'raw/かな/最終の三層が記録される');
}
ok('音声パイプライン(whisper→かな化→ラティス)');

// ---- 48. 自動登録辞書のLLM棚卸し ----
{
  llmStub.curateReply = '1';
  const removed = await globalThis.__neCurate(true);
  assert(removed.length === 1, `棚卸しで1件除去: ${removed.join()}`);
  const cu = globalThis.__neLogAll().map((l) => JSON.parse(l)).filter((x) => x.e === 'curate').pop();
  assert(cu && cu.rm.length === 1, '整理がチェーンに記録される');
  llmStub.curateReply = 'なし';
  const removed2 = await globalThis.__neCurate(true);
  assert(removed2.length === 0, '「なし」なら何も消えない');
}
ok('辞書棚卸し(LLM・userDictは不可侵)');

// ---- 49. 音声: 正規化と表記の主権(自分のコーパスが勝つ) ----
{
  down('Enter');
  llmStub.kanaReply = 'コンニチハ'; // LLMまでカタカナで返した最悪ケース
  await globalThis.__neVoicePipe('コンニチハ', globalThis.__neSha('v3'));
  const st49 = globalThis.__neLogAll().map((l) => JSON.parse(l)).filter((x) => x.e === 'stt').pop();
  assert(st49.kana === 'こんにちは', `かな化層は正規化される: ${st49.kana}`);
  assert(st49.s === 'コンニチハ', `最終表記は自分のコーパスに忠実(過去作にコンニチハが実在): ${st49.s}`);
  // 未登録のカタカナ固有名詞は原文のまま生き残る
  down('Enter');
  llmStub.kanaReply = 'ぞまほんがきた。';
  await globalThis.__neVoicePipe('ゾマホンガ来タ。', globalThis.__neSha('v4'));
  assert(plain().includes('ゾマホン'), `未登録カタカナ名の復元: ${plain().slice(-10)}`);
}
ok('音声: かな正規化+表記主権+固有名詞復元');

// ---- 50. 声合わせ(キャリブレーション: 正解つき聞き癖採取) ----
{
  const len50 = plain().length; // 本文の長さ(非挿入の検証用)
  globalThis.__neCalib.start();
  assert(globalThis.__neCalib.get() && html().includes('声合わせ'), 'キャリブレーション画面が出る');
  await globalThis.__neVoicePipe('キキマチガイサンプル', globalThis.__neSha('v5'));
  assert(globalThis.__neCalib.get().idx === 1, '次の文へ進む');
  const vc = globalThis.__neLogAll().map((l) => JSON.parse(l)).filter((x) => x.e === 'vcal').pop();
  assert(vc && vc.h === 'キキマチガイサンプル' && vc.o, '聞き取り+正解原文がチェーンに記録');
  // Esc終了
  down('Escape');
  assert(!globalThis.__neCalib.get(), 'Escで終了');
  assert(plain().length === len50, '声合わせ中の音声は本文に挿入されていない');
  assert(JSON.parse(localStorage.getItem('ne:voiceCal')).length >= 1, '補正ペアが蓄積される');
}
ok('声合わせ(聞き癖採取→かな化の正解例示)');

// ---- 51. 作品ファイル形式(本文+メタ同居・自己検証) ----
{
  const w = globalThis.__neWork.serialize();
  assert(w.includes('機械用メタ'), 'マーカー入り');
  const parsed = globalThis.__neWork.parse(w);
  assert(parsed.verified && parsed.body === plain().replace(/⏎/g, ''), 'roundtrip: 本文一致+sha検証 ✓');
  assert(parsed.meta.chainHead.length >= 1 && parsed.meta.name, 'メタにチェーン錨と名前');
  const tampered = w.replace(/。/, '!');
  assert(globalThis.__neWork.parse(tampered).verified === false, '外部編集(改ざん)を検出');
  const noMeta = globalThis.__neWork.parse('ただのテキスト\n');
  assert(noMeta.meta === null && noMeta.body === 'ただのテキスト', 'メタ無しの素txtも開ける');
}
ok('作品ファイル(本文+sha+チェーン錨の同居形式)');

// ---- 51. 作品の改名(履歴ごと引き継ぎ) ----
{
  globalThis.window = { prompt: () => 'はじまりの物語', confirm: () => true };
  const txt51 = plain();
  globalThis.__neRename();
  delete globalThis.window;
  assert(plain() === txt51, '本文は不変');
  assert(el('doc').innerHTML.includes('はじまりの物語'), 'セレクタに新名称');
  const rn = globalThis.__neLogAll().map((l) => JSON.parse(l)).filter((x) => x.e === 'doc-rename').pop();
  assert(rn && rn.from === 'novel:manuscript' && rn.to === 'novel:はじまりの物語', '改名がチェーンに記録');
  el('save').onclick();
  await wait(30);
  const st51 = globalThis.__neLogAll().map((l) => JSON.parse(l)).filter((x) => x.e === 'state').pop();
  assert(st51.d === 'novel:はじまりの物語', '以後のstateは新IDで固定される');
}
ok('作品の改名(履歴引き継ぎ+チェーン記録)');

console.log(`\nall ${n} tests passed`);
process.exit(0);
