// novel-editor: オリジナル配列 + space和音シフト + SKK式前置変換 + 自己コーパス辞書 + 練習モード
// 公理0: 本文の全文字は打鍵から決定的に導出される。LLMは本文生成経路に存在しない。
// substrate: yume-lite (Block = 原稿の保存単位、versions = 履歴)。../yume-lite は読み取り専用の依存
import { Graph, Block } from './vendor/yume-lite-core.js'; // yume-lite core を同梱(パッケージ自己完結のため)

// ---- 設定(キーが反応しないときはここを実際の code に合わせる。最下部に押した code が出る) ----
// かなキーは macOS が入力ソース切替に横取りすることがあるため、右Cmd を確実な代替にしている
const HENKAN_CODES = ['Space', 'Digit7', 'Lang1', 'KanaMode', 'HiraganaKatakana', 'MetaRight']; // 変換/候補送り(Space/7)
const KATAKANA_CODES = ['Digit8']; // カタカナ変換(8)。F7 は数字の7(F1〜F10=数字)
const CANCEL_CODES = ['Lang2', 'NonConvert', 'Convert', 'AltLeft', 'AltRight']; // ▽破棄/キャンセル

// ---- 物理キー(JIS 3段×10列) ----
const ROWS = ['QWERTYUIOP', 'ASDFGHJKL;', 'ZXCVBNM,./'];
const CODE_OF = {};
ROWS.join('').split('').forEach((ch) => {
  CODE_OF[ch] =
    ch === ';' ? 'Semicolon' : ch === ',' ? 'Comma' : ch === '.' ? 'Period' : ch === '/' ? 'Slash' : 'Key' + ch;
});

// ---- ゛変形キー: base→濁→(半濁/小書き)→base の循環 ----
const CYCLE = {};
const chain = (arr) => arr.forEach((c, i) => (CYCLE[c] = arr[(i + 1) % arr.length]));
'かきくけこさしすせそたちつてと'.split('').forEach((c, i) =>
  chain([c, 'がぎぐげござじずぜぞだぢづでど'[i]])
);
'はひふへほ'.split('').forEach((c, i) => chain([c, 'ばびぶべぼ'[i], 'ぱぴぷぺぽ'[i]]));
'あいうえお'.split('').forEach((c, i) => chain([c, 'ぁぃぅぇぉ'[i]]));

// ---- 状態 ----
let plainMap = {}, chordMap = {};       // code -> かな
let keyOfPlain = {}, keyOfChord = {};   // かな -> code
let COMPOSED = {};                      // 変形後の字 -> {base, steps}
let dict = {}, baseDict = {}, drills = { convWords: [], lines: [] };
let userDict = JSON.parse(localStorage.getItem('ne:userDict') || '{}');
let autoDict = JSON.parse(localStorage.getItem('ne:autoDict') || '{}'); // LLM採取の自動登録(読み→{表記:回数})
let observed = JSON.parse(localStorage.getItem('ne:observed') || '{}'); // 採取観察カウント(2回で登録)
let lastScanLen = Number(localStorage.getItem('ne:lastScanLen') || 0);
let text = '';
let mode = 'NONE'; // NONE | CAND(▼)
let reading = '', cands = [], candIdx = 0;
let graph, manuscript;
let tut = null; // 練習モード状態
let lastConv = null, lastConvTimer = null; // 直近の変換確定区間(ハイライト用)
let committedTo = 0; // 未確定領域の開始。committedTo..cursor の末尾かな列=未確定(青字・変換対象)
let cursor = 0; // 挿入位置(キャレット)。クリック/矢印で移動できる
let selfPred = [];   // 予測用: 自分の語彙(コーパス+確定学習)の [読み, スコア]
let convRestore = ''; // 変換キャンセル時に戻す文字列(予測変換では打った分だけ戻す)
let candPaths = null; // ラティス候補の分割情報(確定学習用)。従来型候補のときは null
let closers = []; // 自動閉じカッコ(キャレットの後ろに予約表示、本文はその手前に入る)
let tategaki = localStorage.getItem('ne:tate') === 'on';
let chartOn = localStorage.getItem('ne:chart') !== 'off';
let viewSpread = -1; // -1=最終見開きに追従
let totalSpreads = 1;
const PAIR = { '「': '」', '（': '）', '『': '』', '(': ')' };

// ---- yume-lite 保存層 ----
function initStore() {
  const saved = localStorage.getItem('ne:graph');
  graph = saved ? Graph.fromJSON(JSON.parse(saved)) : new Graph();
  manuscript = graph.get('novel:manuscript');
  if (!manuscript) {
    manuscript = new Block({ id: 'novel:manuscript', type: 'text' });
    graph.add(manuscript);
  }
  text = manuscript.content || '';
  cursor = text.length;
  committedTo = cursor;
}
// Electron 上では 書類/novel-editor/ に実ファイルとしても自動保存(ブラウザ実行時は localStorage のみ)
const ipc = typeof window !== 'undefined' && window.require ? window.require('electron').ipcRenderer : null;
async function save() {
  const r = manuscript.applyPatch(text);
  localStorage.setItem('ne:graph', JSON.stringify(graph.toJSON()));
  let where = 'localStorage';
  if (ipc) {
    try {
      const p = await ipc.invoke('save-file', { name: 'manuscript.txt', content: text });
      await ipc.invoke('save-file', { name: 'graph.json', content: JSON.stringify(graph.toJSON()) });
      where = p;
    } catch (e) { where = 'localStorage(ディスク保存失敗)'; }
  }
  status(`保存 (${r.action}) — 履歴 ${manuscript.totalHistory} 版 → ${where}`);
  llmHarvest(); // 保存のついでに原稿から固有名詞を採取
}

// ---- 出力先ルーティング(本文 or 練習バッファ) + 作法エンジン(決定的な入力時整形) ----
const NO_INDENT = new Set([...'「『（――……　\n']); // セリフ・リーダー行は字下げしない
function out(s) {
  if (tut) { tut.buf += s; tutCheck(); return; }
  viewSpread = -1; // 書いたら最終見開きへ戻る
  if (s && s !== '\n') {
    const first = s[0];
    const before = text.slice(0, cursor);
    // 地の文の行頭は全角一字下げ(小説作法)
    if ((cursor === 0 || before.endsWith('\n')) && !NO_INDENT.has(first)) {
      text = before + '　' + text.slice(cursor); cursor++;
    }
    // ！？の後に文が続くなら全角アキ
    else if (/[！？]$/.test(before) && !'」』）！？。、　\n'.includes(first)) {
      text = before + '　' + text.slice(cursor); cursor++;
    }
    // 閉じ括弧の前の句点は落とす(「〜だ。」→「〜だ」)
    if (first === '」' && text.slice(0, cursor).endsWith('。')) {
      text = text.slice(0, cursor - 1) + text.slice(cursor);
      cursor--;
      committedTo = Math.min(committedTo, cursor);
    }
  }
  text = text.slice(0, cursor) + s + text.slice(cursor);
  cursor += s.length;
  if (!/^[ぁ-んー]+$/.test(s)) committedTo = cursor; // 記号・改行・漢字は打った時点で確定
}

// カーソル移動: 未確定と予約閉じを片付けてから動く(置き去り事故防止)
function moveCursor(p) {
  if (tut) return;
  if (mode === 'CAND') cancel();
  while (closers.length) out(closers.pop());
  committedTo = cursor;
  cursor = Math.max(0, Math.min(text.length, p));
  committedTo = cursor;
  render();
}
globalThis.__neMove = moveCursor; // e2e 用

// ---- 打鍵・変換イベントログ(書類/novel-editor/log.jsonl、完全ローカル) ----
// 用途: 配列の実測再最適化(キー間遷移時間)・弱点ドリル・審査員の採用率・速度曲線
let logBuf = [];
let logHash = localStorage.getItem('ne:logHash') || '0';
function fnv(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
function logEvt(type, data) {
  // 各行が前行のハッシュを含む append-only チェーン。
  // 決定的エンジン+このログ=原稿を打鍵から再導出できる=「人が書いた」検証可能な証拠
  const body = JSON.stringify({ t: Date.now(), e: type, ...data, p: logHash });
  logHash = fnv(logHash + body);
  localStorage.setItem('ne:logHash', logHash);
  logBuf.push(body);
  if (logBuf.length >= 500) flushLog();
}
globalThis.__neLogLast = () => logBuf[logBuf.length - 1]; // e2e 用

// 公証: 1日1回、打鍵チェーンの現在ハッシュを OpenTimestamps に刻む(「人が書いた」の外部証明)
async function anchorNow(force) {
  if (!ipc) return;
  const today = new Date().toISOString().slice(0, 10);
  if (!force && localStorage.getItem('ne:lastAnchorDay') === today) return;
  if (localStorage.getItem('ne:lastAnchoredHash') === logHash) return; // 書いていない日は刻まない
  flushLog();
  try {
    const r = await ipc.invoke('anchor-hash', { hash: logHash });
    localStorage.setItem('ne:lastAnchorDay', today);
    localStorage.setItem('ne:lastAnchoredHash', logHash);
    status(`公証: 打鍵チェーンを刻みました(${r.count}カレンダー / ${r.sha256.slice(0, 12)}…)`);
  } catch {}
}
globalThis.__neAnchor = anchorNow; // e2e 用
function flushLog() {
  if (!logBuf.length || !ipc) { logBuf = []; return; }
  const chunk = logBuf.join('\n') + '\n';
  logBuf = [];
  ipc.invoke('append-file', { name: 'log.jsonl', content: chunk }).catch(() => {});
}
globalThis.__neLogSize = () => logBuf.length; // e2e 用

// ---- バックアップ/復元: 原稿(履歴ごと)+学習データ+設定を1つのJSONに ----
function exportBundle() {
  manuscript.applyPatch(text); // いまの原稿をコミットしてから書き出す
  localStorage.setItem('ne:graph', JSON.stringify(graph.toJSON()));
  return JSON.stringify({
    app: 'novel-editor', v: 1, at: new Date().toISOString(),
    graph: graph.toJSON(),
    userDict, autoDict, observed,
    settings: {
      tate: tategaki ? 'on' : 'off',
      sound: soundOn ? 'on' : 'off',
      llm: llmOn ? 'on' : 'off',
      chart: chartOn ? 'on' : 'off',
      tutStage: localStorage.getItem('ne:tutStage') || '0',
    },
    logHash, lastScanLen,
  });
}
function importBundle(json) {
  const b = JSON.parse(json);
  if (b.app !== 'novel-editor') throw new Error('not a backup');
  graph = Graph.fromJSON(b.graph || []);
  manuscript = graph.get('novel:manuscript');
  if (!manuscript) { manuscript = new Block({ id: 'novel:manuscript', type: 'text' }); graph.add(manuscript); }
  text = manuscript.content || '';
  cursor = text.length; committedTo = cursor; closers = []; mode = 'NONE'; reading = '';
  userDict = b.userDict || {}; autoDict = b.autoDict || {}; observed = b.observed || {};
  logHash = b.logHash || logHash; lastScanLen = b.lastScanLen || 0;
  localStorage.setItem('ne:graph', JSON.stringify(graph.toJSON()));
  localStorage.setItem('ne:userDict', JSON.stringify(userDict));
  localStorage.setItem('ne:autoDict', JSON.stringify(autoDict));
  localStorage.setItem('ne:observed', JSON.stringify(observed));
  localStorage.setItem('ne:logHash', logHash);
  localStorage.setItem('ne:lastScanLen', String(lastScanLen));
  for (const [k, v] of Object.entries(b.settings || {})) localStorage.setItem('ne:' + (k === 'tutStage' ? 'tutStage' : k), v);
  rebuildSelfPred();
  render();
}
globalThis.__neExport = exportBundle; // e2e 用
globalThis.__neImport = importBundle;

// ---- コピペ(Electron clipboard。選択範囲は未実装なのでコピーは全文) ----
const eClipboard = typeof window !== 'undefined' && window.require ? window.require('electron').clipboard : null;
function pasteText(raw) {
  if (tut || !raw) return;
  const t = raw.replace(/\r\n?/g, '\n'); // 改行コード正規化。作法エンジンは通さず原文のまま挿入
  if (mode === 'CAND') confirmCand();
  text = text.slice(0, cursor) + t + text.slice(cursor);
  cursor += t.length;
  committedTo = cursor;
  viewSpread = -1;
  status(`${t.length}字を貼り付けました`);
  render();
}
globalThis.__nePaste = pasteText; // e2e 用
function copyAll() {
  if (eClipboard) eClipboard.writeText(text);
  else navigator.clipboard?.writeText(text);
  status(`全文(${text.length}字)をコピーしました`);
}

// クリック位置 → 本文オフセット(縦書きは data-i、横書きは caretRangeFromPoint で算出)
function clickOffset(ev) {
  const t = ev.target?.closest?.('[data-i]');
  if (t) return Number(t.dataset.i);
  if (typeof document.caretRangeFromPoint !== 'function') return null;
  const r = document.caretRangeFromPoint(ev.clientX, ev.clientY);
  if (!r) return null;
  const SKIP = new Set(['ghost', 'closers', 'candinfo', 'cand', 'caret', 'nl']);
  let off = 0, found = false;
  const walk = (node) => {
    if (found) return;
    if (node === r.startContainer) { off += r.startOffset; found = true; return; }
    if (node.nodeType === 3) { off += node.textContent.length; return; }
    if (node.classList && [...node.classList].some((c) => SKIP.has(c))) return;
    for (const ch of node.childNodes) walk(ch);
  };
  walk(document.getElementById('text'));
  return found ? Math.min(off, text.length) : null;
}

// ---- 変換 ----
function lookup(yomi) {
  const user = userDict[yomi] || {};
  const corpus = dict[yomi] || [];
  const score = {};
  for (const [s, n] of corpus) score[s] = n;
  for (const [s, n] of Object.entries(autoDict[yomi] || {})) score[s] = (score[s] || 0) + n * 1e3; // 自動登録(原稿採取)
  for (const [s, n] of Object.entries(user)) score[s] = (score[s] || 0) + n * 1e6; // 自分の確定が常に勝つ
  const list = Object.entries(score).sort((a, b) => b[1] - a[1]).map(([s]) => s);
  for (const [s] of baseDict[yomi] || []) if (!list.includes(s)) list.push(s); // 基底はコスト順 [表記,cost]
  if (yomi === 'かっこ') for (const p of ['『』', '（）', '「」']) { const i = list.indexOf(p); if (i >= 0) list.splice(i, 1); list.unshift(p); } // ペア候補(確定でカーソルが中に)
  if (!list.includes(yomi)) list.push(yomi); // 末尾=ひらがな無変換(循環で「開く」が選べる)
  const kata = hiraToKata(yomi);
  if (!list.includes(kata)) list.push(kata); // 最末尾=カタカナ(辞書に無い語もカタカナにできる)
  return list;
}
// ---- 効果音(WebAudio 合成、音声ファイル不要) ----
let audioCtx = null;
let soundOn = localStorage.getItem('ne:sound') !== 'off';
function beep(freq, dur = 0.03, gain = 0.05, type = 'sine') {
  if (!soundOn || typeof AudioContext === 'undefined') return;
  audioCtx ??= new AudioContext();
  const o = audioCtx.createOscillator(), g = audioCtx.createGain();
  o.type = type;
  o.frequency.value = freq;
  g.gain.setValueAtTime(gain, audioCtx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + dur);
  o.connect(g);
  g.connect(audioCtx.destination);
  o.start();
  o.stop(audioCtx.currentTime + dur);
}
const snd = {
  tap: () => beep(720, 0.02, 0.03, 'triangle'),
  chord: () => beep(520, 0.03, 0.04, 'triangle'),
  conv: () => { beep(880, 0.05, 0.04); setTimeout(() => beep(1175, 0.07, 0.04), 45); },
  cycle: () => beep(990, 0.018, 0.025, 'square'),
  err: () => beep(170, 0.12, 0.05, 'sawtooth'),
  done: () => { beep(784, 0.06, 0.05); setTimeout(() => beep(988, 0.06, 0.05), 70); setTimeout(() => beep(1319, 0.1, 0.05), 140); },
};
function toggleSound() {
  soundOn = !soundOn;
  localStorage.setItem('ne:sound', soundOn ? 'on' : 'off');
  const b = document.getElementById('sound');
  if (b) b.textContent = soundOn ? '♪' : '♪̸';
  if (soundOn) snd.conv();
}

const hiraToKata = (s) => s.replace(/[ぁ-ん]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));

// ---- ローカルLLM審査員(同梱 llama-server / TinySwallow-1.5B) ----
// 役割は「候補の番号を言う」だけ。文字は一切生成しない=公理0(内容を書かない)は無傷
const LLM_URL = 'http://127.0.0.1:18434';
let llmReady = false;
let llmOn = localStorage.getItem('ne:llm') !== 'off';
let llmSeq = 0;
function updateLlmBtn() {
  const b = document.getElementById('llm');
  if (b) b.textContent = !llmReady ? '審✕' : llmOn ? '審' : '審OFF';
}
async function llmInit() {
  const tries = ipc ? 60 : 3; // Electron ならモデルロードを待つ
  for (let i = 0; i < tries && !llmReady; i++) {
    try {
      const r = await fetch(LLM_URL + '/health', { signal: AbortSignal.timeout(1500) });
      if ((await r.json()).status === 'ok') llmReady = true;
    } catch {}
    if (!llmReady) await new Promise((r2) => setTimeout(r2, 1000));
  }
  updateLlmBtn();
  if (llmReady) status('審査員(ローカルLLM)が起動しました');
}
async function llmRerank(seq) {
  if (!llmReady || !llmOn || tut || cands.length < 2) return;
  // 文脈は「直前の1〜2文」だけを文境界で切って渡す(ぶつ切りより判断が安定する)
  const sentences = text.slice(0, cursor).split(/(?<=[。！？\n])/).filter((x) => x.trim());
  const context = sentences.slice(-2).join('').slice(-120);
  const list = cands.slice(0, Math.min(8, cands.length));
  const prompt = `日本語のかな漢字変換の候補審査です。文脈の続きとして自然な候補の番号だけを、自然な順にカンマ区切りで挙げてください。不自然な候補は含めないでください。\n文脈:「${context}」\n候補:\n${list.map((c, i) => `${i + 1}. ${c}`).join('\n')}\n番号:`;
  try {
    const r = await fetch(LLM_URL + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: prompt }], temperature: 0, max_tokens: 24 }),
      signal: AbortSignal.timeout(8000),
    });
    const nums = ((await r.json()).choices[0].message.content.match(/\d+/g) || []).map(Number);
    if (seq !== llmSeq || mode !== 'CAND' || candIdx !== 0) return; // ユーザが先に動いたら黙る
    if (!nums.length) return;
    // 並べ替え+フィルタ。ただし: 表示中の第一候補/自分の語彙(確定学習・コーパス)/ひらがな/カタカナは絶対に残す
    const own = new Set([reading, hiraToKata(reading)]);
    Object.keys(userDict[reading] || {}).forEach((x) => own.add(x));
    (dict[reading] || []).forEach(([x]) => own.add(x));
    const oldIdx = new Map(cands.map((c, i) => [c, i]));
    const chosen = [];
    const add = (c) => { if (c != null && oldIdx.has(c) && !chosen.includes(c)) chosen.push(c); };
    // 最初の変換は審査員に任せる: 審査員の選択順を先頭に、元の第一候補はその後ろに残す
    for (const k of nums) if (k >= 1 && k <= list.length) add(list[k - 1]);
    add(cands[0]);
    for (const c of cands) if (own.has(c)) add(c);
    for (const c of cands.slice(8)) add(c); // 審査対象外(9番目以降)は据え置き
    if (chosen.length < 1) return;
    const removed = cands.length - chosen.length;
    if (candPaths) candPaths = chosen.map((c) => candPaths[oldIdx.get(c)]);
    const moved = cands[0] !== chosen[0];
    logEvt('judge', { y: reading, pick: chosen[0], mv: moved ? 1 : 0, rm: removed });
    cands = chosen;
    if (candIdx >= cands.length) candIdx = 0;
    status(`審査員: ${moved ? `「${chosen[0]}」を第一候補に` : '第一候補を支持'}${removed > 0 ? `・不自然${removed}件を除外` : ''}`);
    render();
  } catch {}
}
// ---- 自動辞書登録: LLMが確定済み原稿から固有名詞を採取し、2回観察で autoDict に登録 ----
async function llmHarvest() {
  if (!llmReady || !llmOn || tut) return;
  const committed = text.slice(0, committedTo);
  if (committed.length - lastScanLen < 60) return; // 新しく書けた分が貯まってから
  if (lastScanLen > committed.length) lastScanLen = committed.length; // 原稿が縮んだ場合の防御
  const chunk = committed.slice(Math.max(0, lastScanLen - 40)).slice(-500);
  lastScanLen = committed.length;
  localStorage.setItem('ne:lastScanLen', String(lastScanLen));
  const prompt = `以下の小説本文から固有名詞(人名・地名・組織名・技名など)と珍しい語だけを抜き出し、1行に「表記,読み(ひらがな)」の形式で列挙してください。説明や一般語は不要です。\n本文:「${chunk}」`;
  try {
    const r = await fetch(LLM_URL + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: prompt }], temperature: 0, max_tokens: 200 }),
      signal: AbortSignal.timeout(20000),
    });
    const content = (await r.json()).choices[0].message.content;
    let added = [];
    for (const ln of content.split('\n')) {
      const m = ln.match(/^\s*([^,、\s]+)\s*[,、]\s*([ぁ-んー]+)\s*$/);
      if (!m) continue;
      const [, surf, yomi] = m;
      if (surf === yomi || yomi.length < 2) continue;
      const occ = chunk.split(surf).length - 1;
      if (occ < 1) continue; // 原稿に実在しない抽出は捨てる(幻覚ガード)
      const key = surf + '\t' + yomi;
      observed[key] = (observed[key] || 0) + occ;
      if (observed[key] >= 2 && !autoDict[yomi]?.[surf]) {
        (autoDict[yomi] ??= {})[surf] = observed[key];
        added.push(`${surf}(${yomi})`);
      }
    }
    localStorage.setItem('ne:observed', JSON.stringify(observed));
    if (added.length) {
      localStorage.setItem('ne:autoDict', JSON.stringify(autoDict));
      rebuildSelfPred();
      status(`辞書に自動登録: ${added.join('、')}`);
    }
  } catch {}
}

// 後置変換: 本文末尾のかな列から「辞書に当たる最長 suffix」を対象に変換する(前置マーク廃止)
function hasCands(y) {
  return (
    (dict[y]?.length || baseDict[y]?.length ||
      Object.keys(userDict[y] || {}).length || Object.keys(autoDict[y] || {}).length) > 0
  );
}
// 予測: 未確定かな列の末尾を prefix として、自分の語彙から続きを補完する
function rebuildSelfPred() {
  const score = {};
  for (const [y, arr] of Object.entries(dict))
    score[y] = (score[y] || 0) + arr.reduce((s, [, n]) => s + n, 0);
  for (const [y, m] of Object.entries(autoDict))
    score[y] = (score[y] || 0) + Object.values(m).reduce((a, b) => a + b, 0) * 1e3; // 自動登録も予測に乗る
  for (const [y, m] of Object.entries(userDict))
    score[y] = (score[y] || 0) + Object.values(m).reduce((a, b) => a + b, 0) * 1e6;
  selfPred = Object.entries(score);
}
function predict() {
  if (tut || mode !== 'NONE') return null;
  const run = text.slice(committedTo, cursor).match(/[ぁ-んー]+$/)?.[0];
  if (!run || run.length < 2) return null;
  for (let len = Math.min(run.length, 10); len >= 2; len--) {
    const S = run.slice(-len);
    let best = null;
    for (const [r, sc] of selfPred)
      if (r.length > S.length && r.startsWith(S) && (!best || sc > best.sc)) best = { r, sc };
    if (best) return { S, reading: best.r, ghost: best.r.slice(S.length) };
  }
  return null;
}
// ---- ラティス変換: 全分割を最小コスト経路で解く(「助詞の前に名詞」級の判断はここがやる) ----
const FUNC = new Set(['は','が','を','に','で','と','の','も','へ','や','から','まで','より','だ','です','ます','ました','する','した','して','している','いる','いた','います','ない','なかった','よう','こと','もの','ん','な','ね','よ','か','さ','わ','たち','など','って','ば','たら','なら','けど','でも','し','そう','という','ていう','られ','られる','れる','せる','たり','ながら','のだ','のか','んだ']);
function wordCands(sub) {
  const res = [];
  const u = userDict[sub];
  if (u) Object.entries(u).sort((a, b) => b[1] - a[1]).slice(0, 2).forEach(([s2]) => res.push([s2, 60]));
  (dict[sub] || []).slice(0, 2).forEach(([s2]) => res.push([s2, 160]));
  (baseDict[sub] || []).slice(0, 3).forEach(([s2, c]) => res.push([s2, c]));
  const seen = new Set();
  return res.filter(([s2]) => !seen.has(s2) && seen.add(s2));
}
function latticeBest(run, K = 8) {
  const ch = [...run], n = ch.length;
  const dp = [[{ cost: 0, out: '', segs: [], lastKind: '' }]];
  for (let i = 1; i <= n; i++) {
    const acc = [];
    for (let j = Math.max(0, i - 12); j < i; j++) {
      if (!dp[j]?.length) continue;
      const sub = ch.slice(j, i).join('');
      const opts = wordCands(sub).map(([s2, c]) => [s2, c, 'w']);
      opts.push([sub, FUNC.has(sub) ? 60 : 200 * (i - j), 'k']); // かな素通し(機能語は安い)
      for (const [surf, wc, kind] of opts)
        for (const p of dp[j]) {
          const pen = kind === 'k' && p.lastKind === 'k' ? 150 : 0; // 素通し連続は軽く罰
          acc.push({ cost: p.cost + wc + 100 + pen, out: p.out + surf, segs: p.segs.concat([[sub, surf]]), lastKind: kind });
        }
    }
    acc.sort((a, b) => a.cost - b.cost);
    const seen = new Set();
    dp[i] = [];
    for (const p of acc) {
      if (seen.has(p.out)) continue;
      seen.add(p.out);
      dp[i].push(p);
      if (dp[i].length >= K) break;
    }
  }
  return dp[n] || [];
}
function henkan() {
  if (mode === 'CAND') { snd.cycle(); candIdx = (candIdx + 1) % cands.length; render(); return; }
  if (mode !== 'NONE') return;
  const src = tut ? tut.buf : text;
  const upto = tut ? src.length : cursor;
  // ……は記号変換の入口: ――(棒線)や括弧ペア(カーソルが中に来る)へ。――からは逆方向も
  const tail2 = src.slice(upto - 2, upto);
  if (!tut && (tail2 === '……' || tail2 === '――')) {
    const others = tail2 === '……' ? ['――', '「」', '『』', '（）'] : ['……', '「」', '『』', '（）'];
    text = text.slice(0, cursor - 2) + text.slice(cursor);
    cursor -= 2;
    committedTo = Math.min(committedTo, cursor);
    reading = tail2;
    convRestore = tail2;
    cands = [...others, tail2]; candPaths = null; candIdx = 0; mode = 'CAND';
    render();
    return;
  }
  const m = (tut ? src : src.slice(committedTo, cursor)).match(/[ぁ-んー]+$/); // 未確定領域だけが変換対象
  if (!m) return;
  const run = m[0];
  let exact = null;
  for (let len = run.length; len >= 1; len--) {
    const y = run.slice(run.length - len);
    if (hasCands(y)) { exact = y; break; }
  }
  const pred = predict();
  const begin = (yomi, removed, list, paths) => {
    if (tut) tut.buf = src.slice(0, src.length - removed.length);
    else {
      text = text.slice(0, cursor - removed.length) + text.slice(cursor);
      cursor -= removed.length;
    }
    reading = yomi;
    convRestore = removed;
    cands = list; candPaths = paths; candIdx = 0; mode = 'CAND';
    logEvt('conv', { y: yomi, c0: list[0] });
    render();
    llmSeq++;
    llmRerank(llmSeq); // 裏で審査員に聞く(候補拘束・非同期・落ちてても無害)
  };
  // 予測が「打った文字より長い読み」を持っているなら予測込み単語変換
  if (pred && (!exact || pred.S.length > exact.length)) {
    begin(pred.reading, pred.S, lookup(pred.reading), null);
    return;
  }
  // 未確定全体が一語として辞書にあるなら、従来の深い候補循環
  if (exact === run) {
    begin(run, run, lookup(run), null);
    return;
  }
  // それ以外はラティス(複数語の同時変換)
  const paths = latticeBest(run, 8).filter((p) => p.segs.some(([y, s2]) => y !== s2));
  if (!paths.length) {
    if (exact) { begin(exact, exact, lookup(exact), null); return; } // 末尾一語だけでも変換
    snd.err(); status(`「${run}」に候補なし`); return;
  }
  const list = paths.map((p) => p.out);
  const pathArr = paths.slice();
  if (!list.includes(run)) { list.push(run); pathArr.push(null); }
  const kata = hiraToKata(run);
  if (!list.includes(kata)) { list.push(kata); pathArr.push(null); }
  begin(run, run, list, pathArr);
}
function confirmCand() {
  if (mode !== 'CAND') return;
  const surf = cands[candIdx];
  // 「ひらがなのまま確定」(開く選択)も学習対象。開き閉じの習慣が候補順に乗る
  const chosenPath = candPaths ? candPaths[candIdx] : null;
  if (chosenPath) {
    for (const [y, s2] of chosenPath.segs) {
      if (y === s2 && FUNC.has(y)) continue; // 機能語の素通しは学習しない
      (userDict[y] ??= {});
      userDict[y][s2] = (userDict[y][s2] || 0) + 1;
    }
  } else {
    (userDict[reading] ??= {});
    userDict[reading][surf] = (userDict[reading][surf] || 0) + 1;
  }
  localStorage.setItem('ne:userDict', JSON.stringify(userDict));
  rebuildSelfPred(); // 確定学習を予測にも即反映
  logEvt('pick', { y: reading, s: surf, i: candIdx });
  mode = 'NONE'; reading = ''; candPaths = null;
  const isPair = !tut && surf.length === 2 && PAIR[surf[0]] === surf[1]; // 「」等はカーソルを中に
  const insert = isPair ? surf[0] : surf;
  if (!tut && insert !== '') {
    lastConv = { pos: cursor, len: insert.length, until: Date.now() + 1200 };
    clearTimeout(lastConvTimer);
    lastConvTimer = setTimeout(render, 1250);
  }
  if (isPair) closers.push(surf[1]);
  out(insert);
  if (!tut) committedTo = cursor; // 変換の決定=確定
  snd.conv();
}
function cancel() {
  if (mode === 'CAND') { // 打った分だけかなに戻す(予測変換なら予測前の状態へ)
    const r = convRestore || reading;
    mode = 'NONE'; reading = ''; convRestore = ''; candPaths = null;
    out(r);
  }
  render();
}

// ---- 文字入力 ----
function emit(ch) {
  if (ch === '…') ch = '……'; // 三点リーダは偶数が組版規約 → 一打で2個
  if (tut && tut.type === 'kana') { tutEmit(ch); return; }
  if (mode === 'CAND') confirmCand();
  if (ch === '゛') {
    if (tut) {
      const last = tut.buf.slice(-1);
      if (CYCLE[last]) { tut.buf = tut.buf.slice(0, -1) + CYCLE[last]; tutCheck(); }
    } else {
      const last = text.slice(cursor - 1, cursor);
      if (CYCLE[last]) text = text.slice(0, cursor - 1) + CYCLE[last] + text.slice(cursor);
    }
  } else {
    if (!tut) {
      if (PAIR[ch]) closers.push(PAIR[ch]); // 開き→閉じを予約
      else if (closers.length && closers[closers.length - 1] === ch) closers.pop(); // 閉じは予約を消化
    }
    out(ch);
  }
  render();
}
function backspace() {
  if (mode === 'CAND') { cancel(); return; } // 候補をやめてかなに戻す
  if (tut) { tutBackspace(); return; }
  if (cursor === 0) return;
  const lastCh = text.slice(cursor - 1, cursor);
  if (PAIR[lastCh] && closers[closers.length - 1] === PAIR[lastCh]) closers.pop();
  const delN = text.slice(cursor - 2, cursor) === '……' ? 2 : 1; // ……は単位で消す
  text = text.slice(0, cursor - delN) + text.slice(cursor);
  cursor -= delN;
  committedTo = Math.min(committedTo, cursor);
  render();
}

// ---- 練習モード(出題は全部、自分の小説コーパスから) ----
const STAGES = [
  { name: 'ホーム段(単打)', type: 'kana' },
  { name: '単打面ぜんぶ', type: 'kana' },
  { name: 'シフト面(Shift+キー)', type: 'kana' },
  { name: '゛変形(濁音・半濁・小書き)', type: 'kana' },
  { name: '変換(Space)', type: 'conv' },
  { name: '実文(自分の小説・変換込み)', type: 'conv' },
];
const ITEMS_PER_STAGE = 10;
const pick = (arr) => arr[(Math.random() * arr.length) | 0];

function rowOf(ch) {
  const code = keyOfPlain[ch] ?? keyOfChord[ch];
  if (!code) return -1;
  const label = Object.entries(CODE_OF).find(([, c]) => c === code)?.[0];
  return ROWS.findIndex((r) => r.includes(label));
}
function typeable(ch) {
  return keyOfPlain[ch] !== undefined || keyOfChord[ch] !== undefined || COMPOSED[ch] !== undefined;
}
const isKanji = (c) => /[一-鿿々]/.test(c);
function stageItems(si) {
  // 出題は全部、実在する自分の語彙・文(ランダム文字列は使わない)
  if (si === 4) {
    const ws = drills.convWords.filter(([, y]) => [...y].every(typeable));
    return Array.from({ length: ITEMS_PER_STAGE }, () => pick(ws));
  }
  if (si === 5) {
    const evenDots = (s) => (s.match(/…+/g) || []).every((r) => r.length % 2 === 0);
    const ls = drills.lines.filter(
      ([s, y]) =>
        [...s].every((c) => typeable(c) || isKanji(c)) && [...y].every(typeable) &&
        evenDots(s) && evenDots(y)
    );
    return Array.from({ length: ITEMS_PER_STAGE }, () => pick(ls));
  }
  const plainSet = new Set(Object.values(plainMap).filter((c) => c !== '゛' && c !== '　'));
  const chordSet = new Set(Object.values(chordMap).filter((c) => c !== '　'));
  const homeSet = new Set([...plainSet].filter((c) => rowOf(c) === 1));
  const words = drills.words.filter((w) => [...w].every(typeable));
  let pool;
  if (si === 0) pool = words.filter((w) => [...w].every((c) => homeSet.has(c)));
  else if (si === 1) pool = words.filter((w) => [...w].every((c) => plainSet.has(c)));
  else if (si === 2)
    pool = words.filter(
      (w) => [...w].every((c) => plainSet.has(c) || chordSet.has(c)) && [...w].some((c) => chordSet.has(c))
    );
  else pool = words.filter((w) => [...w].some((c) => COMPOSED[c]));
  if (pool.length < 10) pool = words; // 該当語が少なければ全語彙から
  return Array.from({ length: ITEMS_PER_STAGE }, () => pick(pool));
}
// 打鍵経路: target → 正解バッファ状態の列 + 各文字の完了位置
function pathFor(target) {
  const p = [''], marks = [];
  let cur = '';
  const arr = [...target];
  for (let i = 0; i < arr.length; i++) {
    const ch = arr[i];
    if (ch === '…' && arr[i + 1] === '…') { // ……は一打で2個出る
      cur += '……'; p.push(cur);
      marks.push(p.length - 1, p.length - 1);
      i++;
      continue;
    }
    const comp = COMPOSED[ch];
    if (comp) {
      let c = comp.base;
      cur += c; p.push(cur);
      for (let i = 0; i < comp.steps; i++) { c = CYCLE[c]; cur = cur.slice(0, -1) + c; p.push(cur); }
    } else { cur += ch; p.push(cur); }
    marks.push(p.length - 1);
  }
  return { p, marks };
}
function startTut(si) {
  const stage = si ?? Number(localStorage.getItem('ne:tutStage') || 0);
  tut = { si: stage, type: STAGES[stage].type, items: stageItems(stage), ii: 0, errors: 0, hits: 0, t0: Date.now() };
  loadDrill();
}
function loadDrill() {
  const item = tut.items[tut.ii];
  if (tut.type === 'conv') { tut.target = item[0]; tut.yomi = item[1]; tut.path = null; }
  else { tut.target = item; const { p, marks } = pathFor(item); tut.path = p; tut.marks = marks; }
  tut.buf = ''; tut.pi = 0;
  mode = 'NONE'; reading = '';
  render();
}
function stopTut() {
  tut = null; mode = 'NONE'; reading = '';
  const btn = document.getElementById('tut-btn');
  if (btn) btn.textContent = '練習';
  render();
}
function drillDone() {
  snd.done();
  tut.ii++;
  if (tut.ii >= tut.items.length) {
    const next = Math.min(tut.si + 1, STAGES.length - 1);
    localStorage.setItem('ne:tutStage', String(next));
    const mins = (Date.now() - tut.t0) / 60000;
    status(`ステージ「${STAGES[tut.si].name}」完了! ${(tut.hits / mins).toFixed(0)}字/分・ミス${tut.errors}`);
    if (tut.si === STAGES.length - 1) { stopTut(); return; }
    startTut(next);
    document.getElementById('tut-stage').value = String(next);
  } else loadDrill();
}
function tutEmit(ch) {
  if (ch === '゛') {
    const last = tut.buf.slice(-1);
    if (CYCLE[last]) tut.buf = tut.buf.slice(0, -1) + CYCLE[last];
  } else tut.buf += ch;
  tutCheck();
  render();
}
function tutCheck() {
  if (tut.type === 'conv') {
    if (mode !== 'NONE') return;
    if (tut.buf === tut.target) { tut.hits += tut.target.length; drillDone(); }
    else if (tut.buf && !tut.target.startsWith(tut.buf)) { tut.errors++; tut.buf = ''; flash(); snd.err(); }
    return;
  }
  const next = tut.path[tut.pi + 1];
  if (tut.buf === next) { tut.pi++; tut.hits++; }
  else if (tut.buf !== tut.path[tut.pi]) { tut.errors++; logEvt('miss', { st: tut.si, at: tut.path[tut.pi + 1]?.slice(-1) }); tut.buf = tut.path[tut.pi]; flash(); snd.err(); }
  if (tut.pi === tut.path.length - 1) drillDone();
}
function tutBackspace() {
  if (tut.type === 'conv') {
    tut.buf = tut.buf.slice(0, -1); // CAND中のBackspaceは backspace() 側で cancel 済み
  } else { tut.pi = Math.max(0, tut.pi - 1); tut.buf = tut.path[tut.pi]; }
  render();
}
function flash() {
  const el = document.getElementById('text');
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 150);
}
// 次に押すキーのヒント
function tutHint() {
  if (tut.type === 'conv')
    return { label: `よみ「${tut.yomi}」を打つ → Space=変換・候補送り → Enter で決定`, code: null, chord: false };
  const next = tut.path[tut.pi + 1];
  if (next === undefined) return null;
  if (next.length === tut.buf.length)
    return { label: `゛で変形 → ${next.slice(-1)}`, code: keyOfPlain['゛'], chord: false };
  const ch = next.slice(-1);
  if (keyOfPlain[ch]) return { label: ch, code: keyOfPlain[ch], chord: false };
  if (keyOfChord[ch]) return { label: `${ch}(Shift+)`, code: keyOfChord[ch], chord: true };
  return null;
}

// ---- キーイベント(配列デコード。シフト面=Shiftキー、判定窓なし) ----
function onKeydown(e) {
  const code = e.code;
  if (!e.repeat) logEvt('k', { c: code, s: e.shiftKey ? 1 : 0, m: tut ? 't' : tategaki ? 'v' : 'h' });
  document.querySelectorAll(`[data-code="${code}"]`).forEach((k) => k.classList.add('hit'));
  statusKey(code);

  // 変換系キーは modifier 判定より先に拾う(右Cmd は metaKey を立てるため)
  if (HENKAN_CODES.includes(code)) {
    e.preventDefault();
    if (e.repeat) return;
    if (tut && tut.type === 'kana') return;
    henkan(); return;
  }
  if (CANCEL_CODES.includes(code)) {
    e.preventDefault();
    if (tut && tut.type === 'kana') return;
    cancel(); return;
  }
  if (e.metaKey || e.ctrlKey) {
    if (code === 'KeyS') { e.preventDefault(); save(); }
    else if (code === 'KeyV') {
      e.preventDefault();
      if (eClipboard) pasteText(eClipboard.readText());
      else navigator.clipboard?.readText().then(pasteText);
    } else if (code === 'KeyC') { e.preventDefault(); copyAll(); }
    return;
  }
  if (code === 'Escape' && tut) { stopTut(); return; }
  if (!tut && (code === 'ArrowLeft' || code === 'ArrowRight')) {
    e.preventDefault();
    moveCursor(cursor + (code === 'ArrowLeft' ? -1 : 1));
    return;
  }
  if (tategaki && (code === 'PageUp' || code === 'PageDown')) {
    e.preventDefault();
    const cur = viewSpread < 0 ? totalSpreads - 1 : viewSpread;
    viewSpread = code === 'PageUp' ? Math.max(0, cur - 1) : cur + 1;
    if (viewSpread >= totalSpreads - 1) viewSpread = -1;
    render(); return;
  }

  const fnDigit = code.match(/^F([1-9]|10)$/); // 数字はファンクションキー(F1〜F9=1〜9、F10=0)。全角で出す
  if (fnDigit) {
    e.preventDefault();
    if (mode === 'CAND') confirmCand();
    out('１２３４５６７８９０'[Number(fnDigit[1]) - 1]);
    render(); return;
  }
  if (KATAKANA_CODES.includes(code)) { // カタカナ変換(8)。候補表示中はカタカナ候補へ直行、通常時は未確定かな列を即カタカナ確定
    e.preventDefault();
    if (mode === 'CAND') {
      const i = cands.indexOf(hiraToKata(reading));
      if (i >= 0) candIdx = i;
      render(); return;
    }
    if (mode !== 'NONE') return;
    const src = tut ? tut.buf : text;
    const m = (tut ? src : src.slice(committedTo, cursor)).match(/[ぁ-んー]+$/);
    if (!m) return;
    const run = m[0], kata = hiraToKata(run);
    if (tut) { tut.buf = src.slice(0, src.length - run.length) + kata; tutCheck(); }
    else {
      const start = cursor - run.length;
      text = text.slice(0, start) + kata + text.slice(cursor);
      cursor = start + kata.length;
      lastConv = { pos: start, len: kata.length, until: Date.now() + 1200 };
      clearTimeout(lastConvTimer);
      lastConvTimer = setTimeout(render, 1250);
      committedTo = cursor;
    }
    render(); return;
  }
  if (code === 'Tab') { // 予測をひらがなのまま受け入れる(青字のままなので続けて変換も可)
    e.preventDefault();
    if (!tut && mode === 'NONE') {
      const pr = predict();
      if (pr) { out(pr.ghost); render(); }
    }
    return;
  }
  if (code === 'Backspace') { e.preventDefault(); backspace(); return; }
  if (code === 'Enter') {
    e.preventDefault();
    if (e.repeat) return; // キーリピートで「決定+改行」が連発するのを防ぐ
    if (mode === 'CAND') {
      if (mode === 'CAND') confirmCand();
      render(); return; // Enter=変換の決定(改行しない)
    }
    if (tut) { tut.errors++; loadDrill(); return; } // Enter=この問をスキップ
    if (cursor > committedTo || closers.length) { // 未確定かな確定+予約閉じの実体化。改行はしない
      while (closers.length) out(closers.pop());
      committedTo = cursor;
      render(); return;
    }
    out('\n');
    render(); return;
  }

  if (plainMap[code] !== undefined) {
    e.preventDefault();
    if (e.repeat) return;
    if (e.shiftKey) { snd.chord(); emit(chordMap[code] ?? plainMap[code]); }
    else { snd.tap(); emit(plainMap[code]); }
    return;
  }
}
function onKeyup(e) {
  document.querySelectorAll(`[data-code="${e.code}"]`).forEach((k) => k.classList.remove('hit'));
}

// ---- 縦書きレイアウト(電撃文庫仕様: 42字×17行・見開き・ぶら下がり・禁則) ----
const LINE_LEN = 42, PAGE_LINES = 17;
const HANG = new Set([...'。、']); // 句読点はぶら下げ(43字目)
const KINSOKU_HEAD = new Set([...'。、」』）！？…ーゃゅょっぁぃぅぇぉ々']); // 行頭に置けない→追い込み
const KINSOKU_TAIL = new Set([...'「『（']); // 行末に置けない→次行へ送る
function layoutLines(tokens) {
  const lines = [];
  let cur = [], count = 0;
  const realLast = () => { for (let k = cur.length - 1; k >= 0; k--) if (!cur[k].caret) return cur[k]; return null; };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.caret) { cur.push(t); continue; }
    if (t.c === '\n') {
      cur.push({ c: '⏎', cls: 'nl', i: t.i }); // 改行マーク(字数には数えない)
      lines.push(cur); cur = []; count = 0; continue;
    }
    cur.push(t); count++;
    if (count >= LINE_LEN) {
      let j = i + 1;
      while (j < tokens.length && tokens[j].caret) j++;
      const nx = tokens[j];
      if (nx && nx.c !== '\n' && (HANG.has(nx.c) || KINSOKU_HEAD.has(nx.c))) {
        for (let k = i + 1; k <= j; k++) cur.push(tokens[k]); // ぶら下がり/追い込み(43字目)
        i = j;
      }
      let carry = [];
      if (KINSOKU_TAIL.has(realLast()?.c)) {
        while (cur.length) { const x = cur.pop(); carry.unshift(x); if (!x.caret) break; } // 開き括弧は次行へ
      }
      lines.push(cur);
      cur = carry;
      count = carry.filter((x) => !x.caret).length;
    }
  }
  lines.push(cur);
  return lines;
}
globalThis.__neLayout = layoutLines; // e2e 用

// ---- 描画 ----
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const escNL = (s) => esc(s).replace(/\n/g, '<span class="nl">⏎</span>\n'); // 改行マーク表示
function composingHtml() {
  if (mode === 'CAND')
    return `<span class="cand">▼${esc(cands[candIdx])}</span><span class="candinfo">(${candIdx + 1}/${cands.length})</span>`;
  return '';
}
function render() {
  document.querySelectorAll('.key.hint, .key.hint-chord, .key.cross').forEach((k) => k.classList.remove('hint', 'hint-chord', 'cross'));
  const chartsEl = document.getElementById('charts');
  const showChart = tut || chartOn; // 練習中は強制表示、それ以外は盤ボタンの設定(縦書きでも出せる)
  if (chartsEl && chartsEl.style) chartsEl.style.display = showChart ? '' : 'none';
  if (typeof document.body?.classList?.toggle === 'function')
    document.body.classList.toggle('with-chart', showChart); // 縦書きのページサイズ計算に反映
  const el = document.getElementById('text');
  if (tut) { renderTut(el); return; }
  el.classList.remove('tut');
  if (tategaki) { renderTate(el); return; }
  el.classList.remove('tate');
  // 未確定のかな列(青字)はカーソル直前
  const pendM = text.slice(committedTo, cursor).match(/[ぁ-んー]+$/);
  const pendStart = cursor - (pendM ? pendM[0].length : 0);
  const head = text.slice(0, pendStart);
  let body;
  if (lastConv && Date.now() < lastConv.until && head.length >= lastConv.pos + lastConv.len) {
    const { pos, len } = lastConv;
    body =
      escNL(head.slice(0, pos)) +
      `<span class="conv-flash">${esc(head.slice(pos, pos + len))}</span>` +
      escNL(head.slice(pos + len));
  } else {
    lastConv = null;
    body = escNL(head);
  }
  if (pendStart < cursor) body += `<span class="pend">${esc(text.slice(pendStart, cursor))}</span>`;
  const pr = predict(); // 予測ゴースト(薄青)
  el.innerHTML =
    body + composingHtml() + '<span class="caret"></span>' +
    (pr ? `<span class="ghost">${esc(pr.ghost)}</span>` : '') +
    (closers.length ? `<span class="closers">${esc(closers.slice().reverse().join(''))}</span>` : '') +
    escNL(text.slice(cursor)) +
    '<div id="curline"></div>';
  // タイプライタースクロール: 入力中の行を常に画面の縦中央へ + カーソル行の帯
  const caretEl = el.querySelector('.caret');
  if (caretEl && typeof caretEl.offsetTop === 'number') {
    el.scrollTop = Math.max(0, caretEl.offsetTop - el.clientHeight * 0.5);
    const cl = el.querySelector('#curline');
    if (cl) cl.style.top = caretEl.offsetTop - 6 + 'px';
  }
  document.getElementById('mode').textContent =
    mode === 'NONE' ? '─' : '▼';
  document.getElementById('count').textContent = `${text.length}字`;
}
function renderTate(el) {
  el.classList.add('tate');
  const tokens = [];
  let ti = 0; // 本文の絶対位置(クリックでのカーソル移動用)
  const pushText = (str, cls) => { for (const c of str) tokens.push({ c, cls, i: ti++ }); };
  const pushUi = (str, cls) => { for (const c of str) tokens.push({ c, cls, i: null }); };
  const pendM = text.slice(committedTo, cursor).match(/[ぁ-んー]+$/);
  const pendStart = cursor - (pendM ? pendM[0].length : 0);
  const head = text.slice(0, pendStart);
  if (lastConv && Date.now() < lastConv.until && head.length >= lastConv.pos + lastConv.len) {
    pushText(head.slice(0, lastConv.pos));
    pushText(head.slice(lastConv.pos, lastConv.pos + lastConv.len), 'conv-flash');
    pushText(head.slice(lastConv.pos + lastConv.len));
  } else { lastConv = null; pushText(head); }
  pushText(text.slice(pendStart, cursor), 'pend');
  if (mode === 'CAND') pushUi('▼' + cands[candIdx], 'cand');
  tokens.push({ caret: true });
  const pr = predict();
  if (pr) pushUi(pr.ghost, 'ghost');
  if (closers.length) pushUi(closers.slice().reverse().join(''), 'closers');
  pushText(text.slice(cursor));

  const lines = layoutLines(tokens);
  const pages = [];
  for (let i = 0; i < lines.length; i += PAGE_LINES) pages.push(lines.slice(i, i + PAGE_LINES));
  totalSpreads = Math.max(1, Math.ceil(pages.length / 2));
  const si = viewSpread < 0 ? totalSpreads - 1 : Math.min(viewSpread, totalSpreads - 1);
  const lineHtml = (ln) =>
    `<div class="vl${ln.some((t) => t.caret) ? ' cur-line' : ''}">` +
    ln.map((t) =>
      t.caret ? '<span class="caret"></span>'
      : `<span${t.i != null ? ` data-i="${t.i}"` : ''}${t.cls ? ` class="${t.cls}"` : ''}>${esc(t.c)}</span>`
    ).join('') +
    '</div>';
  const pageHtml = (pg, num) =>
    `<div class="page"><div class="pagein">${(pg || []).map(lineHtml).join('')}</div><div class="pageno">${num}</div></div>`;
  el.innerHTML = `<div class="spread">${pageHtml(pages[si * 2], si * 2 + 1)}${pageHtml(pages[si * 2 + 1], si * 2 + 2)}</div>`;
  document.getElementById('mode').textContent = mode === 'NONE' ? '─' : '▼';
  document.getElementById('count').textContent = `${text.length}字 ・ 見開き ${si + 1}/${totalSpreads}`;
}
function renderTut(el) {
  el.classList.add('tut');
  const st = STAGES[tut.si];
  let targetHtml = '';
  if (tut.type === 'conv') {
    const done = tut.target.startsWith(tut.buf) ? tut.buf.length : 0;
    targetHtml =
      `<span class="done">${esc(tut.target.slice(0, done))}</span>` +
      `<span class="rest">${esc(tut.target.slice(done))}</span>` +
      `<span class="yomi">(${esc(tut.yomi)})</span>`;
  } else {
    const done = tut.marks.filter((m) => m <= tut.pi).length;
    targetHtml =
      `<span class="done">${esc(tut.target.slice(0, done))}</span>` +
      `<span class="cur">${esc(tut.target[done] ?? '')}</span>` +
      `<span class="rest">${esc(tut.target.slice(done + 1))}</span>`;
  }
  const hint = tutHint();
  if (hint?.code) {
    document
      .querySelector(`#chart [data-code="${hint.code}"]`)
      ?.classList.add(hint.chord ? 'hint-chord' : 'hint');
    // 十字エフェクト: 同じ列(指の縦ライン)と同じ段を薄く照らして交点に誘導
    const label = Object.entries(CODE_OF).find(([, c]) => c === hint.code)?.[0];
    const row = ROWS.findIndex((rw) => rw.includes(label));
    const col = row >= 0 ? ROWS[row].indexOf(label) : -1;
    if (col >= 0) {
      for (const l2 of ROWS[row]) if (l2 !== label)
        document.querySelector(`#chart [data-code="${CODE_OF[l2]}"]`)?.classList.add('cross');
      for (let r2 = 0; r2 < 3; r2++) if (r2 !== row)
        document.querySelector(`#chart [data-code="${CODE_OF[ROWS[r2][col]]}"]`)?.classList.add('cross');
    }
    if (hint.chord) { // 逆側の手の Shift を光らせる(正しい運指)
      const side = col < 5 ? 'ShiftRight' : 'ShiftLeft';
      document.querySelector(`#chart [data-code="${side}"]`)?.classList.add('hint-chord');
    }
  }
  const mins = (Date.now() - tut.t0) / 60000;
  el.innerHTML = `
    <div class="drill">
      <div class="stagename">ステージ${tut.si + 1}/6 — ${st.name}　(${tut.ii + 1}/${tut.items.length})</div>
      <div class="target${tut.target.length > 12 ? ' long' : ''}">${targetHtml}</div>
      <div class="typed">${esc(tut.buf)}${composingHtml()}<span class="caret"></span></div>
      <div class="hintline">${hint ? '次: ' + esc(hint.label) : ''}</div>
      <div class="stats">ミス ${tut.errors} ・ ${mins > 0.05 ? (tut.hits / mins).toFixed(0) : '─'} 字/分 ・ Enter=スキップ ・ Esc=終了</div>
    </div>`;
  document.getElementById('mode').textContent = mode === 'NONE' ? '練' : '▼';
}
function status(msg) { document.getElementById('status').textContent = msg; }
function statusKey(code) { document.getElementById('keycode').textContent = code; }

// ---- 配列チャート(1枚: 各キーの上段=Shift面、下段=単打) ----
const SMALL_KANA = new Set([...'ぁぃぅぇぉゃゅょっゎ']);
const GYO = ['あいうえお', 'かきくけこ', 'さしすせそ', 'たちつてと', 'なにぬねの', 'はひふへほ', 'まみむめも', 'やゆよ', 'らりるれろ', 'わをん'];
const gyoOf = (ch) => GYO.findIndex((g) => g.includes(ch));
function buildCharts(layout) {
  const charAt = (slots, id) => {
    const ch = Object.entries(slots).find(([, v]) => v === id)?.[0] ?? '';
    return ch === '　' ? '□' : ch;
  };
  const cls = (ch, base) => {
    if (SMALL_KANA.has(ch)) return `${base} small-kana`; // っ/つ の見分け用(えんじ)
    const g = gyoOf(ch);
    return g >= 0 ? `${base} gyo-${g}` : base; // 行ごとに緑系の別色
  };
  let html = '';
  for (let r = 0; r < 3; r++) {
    html += '<div class="krow">';
    if (r === 2) html += '<div class="key shiftkey" data-code="ShiftLeft"><span class="kana">⇧</span><span class="label">Shift</span></div>';
    for (const label of ROWS[r]) {
      const code = CODE_OF[label];
      const top = charAt(layout.slots, label + '+SP');
      const bottom = charAt(layout.slots, label);
      html += `<div class="key${r === 1 && !'GH'.includes(label) ? ' home' : ''}" data-code="${code}">` +
        `<span class="${cls(top, 'chord')}">${top}</span>` +
        `<span class="${cls(bottom, 'kana')}">${bottom}</span>` +
        `<span class="label">${label}</span></div>`;
    }
    if (r === 2) html += '<div class="key shiftkey" data-code="ShiftRight"><span class="kana">⇧</span><span class="label">Shift</span></div>';
    html += '</div>';
  }
  document.getElementById('chart').innerHTML = html;
}

// ---- 起動 ----
async function main() {
  const [layout, d, base, dr] = await Promise.all([
    fetch('./layout.json').then((r) => r.json()),
    fetch('./dict.json').then((r) => r.json()),
    fetch('./basedict.json').then((r) => r.json()),
    fetch('./drills.json').then((r) => r.json()),
  ]);
  dict = d; baseDict = base; drills = dr;
  rebuildSelfPred();
  for (const [ch, id] of Object.entries(layout.slots)) {
    const label = id.replace('+SP', '');
    const code = CODE_OF[label];
    if (id.endsWith('+SP')) { chordMap[code] = ch; keyOfChord[ch] = code; }
    else { plainMap[code] = ch; keyOfPlain[ch] = code; }
  }
  // 変形後の字 → {base, steps} を導出
  for (const base of [...Object.values(plainMap), ...Object.values(chordMap)]) {
    if (!CYCLE[base]) continue;
    let c = CYCLE[base], steps = 1;
    while (c && c !== base) {
      if (!keyOfPlain[c] && !keyOfChord[c]) COMPOSED[c] = { base, steps };
      c = CYCLE[c]; steps++;
    }
  }
  initStore();
  buildCharts(layout);
  document.addEventListener('keydown', onKeydown);
  document.addEventListener('keyup', onKeyup);
  // クリックでカーソル移動(確認→必要なら改行を入れて書き始める)
  document.getElementById('text').addEventListener?.('mousedown', (ev) => {
    if (tut) return;
    const p = clickOffset(ev);
    if (p == null || p === cursor) return;
    ev.preventDefault();
    if (!window.confirm('カーソルをここに移動して書きますか?')) return;
    moveCursor(p);
    const midLine = cursor > 0 && text[cursor - 1] !== '\n' && cursor < text.length && text[cursor] !== '\n';
    if (midLine && window.confirm('改行を入れてから書きますか?')) out('\n');
    render();
  });
  // システムIMEがONだと打鍵がOSに横取りされる → 検知して警告
  document.addEventListener('compositionstart', () => {
    status('⚠ システムの日本語IMEがONです。メニューバーから入力ソースをABC(英数)にしてください');
  });
  document.getElementById('save').onclick = save;
  const sb = document.getElementById('sound');
  sb.textContent = soundOn ? '♪' : '♪̸';
  sb.onclick = toggleSound;
  const tb = document.getElementById('tate');
  tb.textContent = tategaki ? '縦' : '横';
  tb.onclick = () => {
    tategaki = !tategaki;
    localStorage.setItem('ne:tate', tategaki ? 'on' : 'off');
    tb.textContent = tategaki ? '縦' : '横';
    viewSpread = -1;
    render();
  };
  const cb = document.getElementById('chartbtn');
  cb.textContent = chartOn ? '盤' : '盤̸';
  cb.onclick = () => {
    chartOn = !chartOn;
    localStorage.setItem('ne:chart', chartOn ? 'on' : 'off');
    cb.textContent = chartOn ? '盤' : '盤̸';
    render();
  };
  const lb = document.getElementById('llm');
  lb.onclick = () => { llmOn = !llmOn; localStorage.setItem('ne:llm', llmOn ? 'on' : 'off'); updateLlmBtn(); };
  updateLlmBtn();
  llmInit();
  document.getElementById('export').onclick = async () => {
    if (ipc) {
      const p = await ipc.invoke('export-dialog', { defaultName: 'manuscript.txt', content: text });
      status(p ? `txt書き出し → ${p}` : '書き出しをキャンセルしました');
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
      a.download = 'manuscript.txt';
      a.click();
    }
  };
  document.getElementById('exp-json').onclick = async () => {
    if (ipc) {
      const p = await ipc.invoke('export-dialog', { defaultName: 'novel-editor-backup.json', content: exportBundle() });
      status(p ? `バックアップ書き出し → ${p}` : 'キャンセルしました');
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([exportBundle()], { type: 'application/json' }));
      a.download = 'novel-editor-backup.json';
      a.click();
    }
  };
  const fi = document.getElementById('imp-file');
  document.getElementById('imp-json').onclick = () => fi.click?.();
  if (fi) fi.onchange = (ev) => {
    const f = ev.target.files?.[0];
    if (!f) return;
    if (!window.confirm('現在の原稿と学習データをバックアップの内容に置き換えます。よろしいですか?')) { fi.value = ''; return; }
    const rd = new FileReader();
    rd.onload = () => {
      try { importBundle(rd.result); status('バックアップから復元しました'); }
      catch { status('復元失敗: novel-editor のバックアップではありません'); }
      fi.value = '';
    };
    rd.readAsText(f);
  };
  const sel = document.getElementById('tut-stage');
  sel.innerHTML = STAGES.map((s, i) => `<option value="${i}">${i + 1}. ${s.name}</option>`).join('');
  sel.value = localStorage.getItem('ne:tutStage') || '0';
  document.getElementById('tut-btn').onclick = () => {
    if (tut) { stopTut(); return; }
    startTut(Number(sel.value));
    document.getElementById('tut-btn').textContent = '練習終了';
  };
  sel.onchange = () => { if (tut) startTut(Number(sel.value)); };
  setInterval(() => { if (!tut && text !== (manuscript.content || '')) save(); }, 10000); // 10秒ごと自動保存
  setInterval(() => { // 5分ごとに完全バックアップ(原稿履歴+学習+設定)を自動で書く
    if (ipc) ipc.invoke('save-file', { name: 'backup-auto.json', content: exportBundle() }).catch(() => {});
  }, 300000);
  setInterval(llmHarvest, 60000); // 1分ごとに固有名詞の採取
  setInterval(flushLog, 30000); // 打鍵ログの書き出し
  setTimeout(() => anchorNow(false), 20000); // 起動後に当日分の公証
  setInterval(() => anchorNow(false), 3600000); // 1時間ごとに「今日まだなら」公証
  if (typeof window !== 'undefined')
    window.addEventListener('beforeunload', () => { if (text !== (manuscript.content || '')) save(); });
  render();
  status(`自分辞書 ${Object.keys(dict).length} 語 + 基底 ${Object.keys(baseDict).length} 語 / ドリル ${drills.lines.length} 文 / 履歴 ${manuscript.totalHistory} 版`);
}
main();
