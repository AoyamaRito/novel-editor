// novel-editor: オリジナル配列 + space和音シフト + SKK式前置変換 + 自己コーパス辞書 + 練習モード
// 公理0: 本文の全文字は打鍵から決定的に導出される。LLMは本文生成経路に存在しない。
// substrate: yume-lite (Block = 原稿の保存単位、versions = 履歴)。../yume-lite は読み取り専用の依存
import { Graph, Block } from './vendor/yume-lite-core.js'; // yume-lite core を同梱(パッケージ自己完結のため)

// ---- 設定(キーが反応しないときはここを実際の code に合わせる。最下部に押した code が出る) ----
// かなキーは macOS が入力ソース切替に横取りすることがあるため、右Cmd を確実な代替にしている
const HENKAN_CODES = ['Space', 'Lang1', 'KanaMode', 'HiraganaKatakana', 'MetaRight']; // 変換/候補送り(Space)
const HIRAKU_CODES = ['Quote']; // ：=表記を開く(すべてカタカナ⇄すべてひらがな。候補表示中からも戻せる)。数字キー4578はがだじで
const CANCEL_CODES = ['Lang2', 'NonConvert', 'Convert', 'AltLeft', 'AltRight']; // ▽破棄/キャンセル

// ---- 物理キー(JIS 3段×10列) ----
const ROWS = ['QWERTYUIOP', 'ASDFGHJKL;', 'ZXCVBNM,./'];
const CODE_OF = {};
ROWS.join('').split('').forEach((ch) => {
  CODE_OF[ch] =
    ch === ';' ? 'Semicolon' : ch === ',' ? 'Comma' : ch === '.' ? 'Period' : ch === '/' ? 'Slash' : 'Key' + ch;
});
'0123456789'.split('').forEach((d) => (CODE_OF[d] = 'Digit' + d)); // 数字段(4578=最頻濁音の単打専用席)

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
let ctxDict = JSON.parse(localStorage.getItem('ne:ctxDict') || '{}'); // 文脈学習: 「直前1字|読み」→{表記:回数}
let lastPick = JSON.parse(localStorage.getItem('ne:lastPick') || '{}'); // 直近性: 「読み|表記」→確定通番
let pickSeq = Number(localStorage.getItem('ne:pickSeq') || 0);
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
let symJump = 0;
let abcMode = false; // @キー(Pの隣、JIS=BracketLeft)または英数キーでトグル。刻印どおりのQWERTYを素通し。英数はOS切替・F11はデスクトップ表示に取られるため@に落ち着いた // 句読点を透かして変換した時、確定後にカーソルを記号の後ろへ戻す量
let undoStack = [], redoStack = [], lastSnapT = 0; // Undo/Redo(状態スナップショット)
let curDocId = localStorage.getItem('ne:curDoc') || 'novel:manuscript'; // 複数原稿
let lastQuery = ''; // 検索
let posDict = JSON.parse(localStorage.getItem('ne:posDict') || '{}'); // 手動登録語の品詞(読み\t表記 -> 品詞)
let followCaret = true, progScroll = false, wheelAcc = 0; // スクロール追従の解放
let candPaths = null; // ラティス候補の分割情報(確定学習用)。従来型候補のときは null
let closers = []; // 自動閉じカッコ(実体で即挿入済み。スタックは「Enterで飛び越える数」と削除道連れの管理)
let tategaki = localStorage.getItem('ne:tate') === 'on';
let chartOn = localStorage.getItem('ne:chart') !== 'off';
let viewSpread = -1; // -1=最終見開きに追従
let totalSpreads = 1;
const PAIR = { '「': '」', '（': '）', '『': '』', '(': ')' };

// ---- yume-lite 保存層 ----
function initStore() {
  const saved = localStorage.getItem('ne:graph');
  graph = saved ? Graph.fromJSON(JSON.parse(saved)) : new Graph();
  manuscript = graph.get(curDocId);
  if (!manuscript) {
    manuscript = new Block({ id: curDocId, type: 'text' });
    graph.add(manuscript);
  }
  text = manuscript.content || '';
  cursor = text.length;
  committedTo = cursor;
}
function listDocs() { return graph.all().filter((b) => b.type === 'text'); }
function refreshDocSel() {
  const sel = document.getElementById('doc');
  if (!sel) return;
  const escAttr = (x) => esc(x).replace(/"/g, '&quot;');
  sel.innerHTML = listDocs()
    .map((b) => `<option value="${escAttr(b.id)}"${b.id === curDocId ? ' selected' : ''}>${esc(b.id.replace('novel:', ''))}</option>`)
    .join('');
}
function switchDoc(id) {
  if (!id || id === curDocId) { refreshDocSel(); return; }
  manuscript.applyPatch(text); // 現作品をコミットしてから切替
  localStorage.setItem('ne:graph', JSON.stringify(graph.toJSON()));
  curDocId = id;
  localStorage.setItem('ne:curDoc', id);
  manuscript = graph.get(id);
  if (!manuscript) { manuscript = new Block({ id, type: 'text' }); graph.add(manuscript); }
  text = manuscript.content || '';
  cursor = text.length; committedTo = cursor;
  closers = []; mode = 'NONE'; reading = '';
  undoStack = []; redoStack = []; viewSpread = -1; followCaret = true;
  logEvt('doc', { id });
  refreshDocSel();
  render();
  status(`作品: ${id.replace('novel:', '')}`);
}
function renameDoc() {
  const cur = curDocId.replace('novel:', '');
  const name = typeof window !== 'undefined' && window.prompt ? window.prompt('作品名を変更:', cur) : null;
  if (!name || !name.trim() || name.trim() === cur) return;
  const newId = 'novel:' + name.trim();
  if (graph.has(newId)) { status('その名前の作品は既にあります'); return; }
  manuscript.applyPatch(text); // 最新を確定してから移す
  const moved = new Block({ id: newId, type: 'text', versions: manuscript.versions }); // 履歴ごと引き継ぐ
  graph.add(moved);
  graph.blocks.delete(curDocId);
  logEvt('doc-rename', { from: curDocId, to: newId });
  curDocId = newId;
  localStorage.setItem('ne:curDoc', newId);
  manuscript = moved;
  localStorage.setItem('ne:graph', JSON.stringify(graph.toJSON()));
  refreshDocSel();
  status(`作品名を「${name.trim()}」に変更しました(履歴も引き継ぎ)`);
}
globalThis.__neRename = renameDoc; // e2e用(promptはwindow経由なので実機のみ)
function newDoc() {
  const name = typeof window !== 'undefined' && window.prompt ? window.prompt('新しい作品名:') : null;
  if (!name || !name.trim()) return;
  switchDoc('novel:' + name.trim());
}
globalThis.__neDoc = switchDoc; // e2e 用

async function registerWord(surf, yomi, at) {
  (userDict[yomi] ??= {});
  userDict[yomi][surf] = (userDict[yomi][surf] || 0) + 3; // 手動登録は強め
  localStorage.setItem('ne:userDict', JSON.stringify(userDict));
  rebuildSelfPred();
  logEvt('reg', { y: yomi, s: surf });
  status(`登録: ${surf}(${yomi})`);
  render();
  if (!llmReady || !llmOn) return;
  try { // 品詞はLLMが文脈から特定(失敗しても登録自体は成立)
    const p0 = at >= 0 ? at : text.indexOf(surf);
    const ctx = text.slice(Math.max(0, p0 - 40), Math.max(0, p0) + surf.length + 40);
    const r = await fetch(smartUrl() + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: `次の文脈における語「${surf}」の品詞を、次から一語だけで答えてください: 固有名詞/名詞/動詞/形容詞/副詞/その他\n文脈:「${ctx}」\n品詞:` }],
        temperature: 0, max_tokens: 8,
      }),
      signal: AbortSignal.timeout(8000),
    });
    const pos = ((await r.json()).choices[0].message.content.match(/(固有名詞|名詞|動詞|形容詞|副詞|その他)/) || [])[1];
    if (pos) {
      posDict[yomi + '\t' + surf] = pos;
      localStorage.setItem('ne:posDict', JSON.stringify(posDict));
      logEvt('regpos', { y: yomi, s: surf, pos });
      status(`登録: ${surf}(${yomi})・品詞=${pos}`);
    }
  } catch {}
}
globalThis.__neReg = registerWord; // e2e 用

function findNext(q) {
  if (!q) return -1;
  lastQuery = q;
  let i = text.indexOf(q, cursor);
  if (i < 0) i = text.indexOf(q); // 末尾まで無ければ先頭から
  if (i < 0) { status(`「${q}」は見つかりません`); return -1; }
  moveCursor(i + q.length);
  status(`検索「${q}」: ${i + 1}字目(Cmd+Gで次)`);
  return i;
}
globalThis.__neFind = findNext; // e2e 用
// Electron 上では 書類/novel-editor/ に実ファイルとしても自動保存(ブラウザ実行時は localStorage のみ)
let ipc = typeof window !== 'undefined' && window.require ? window.require('electron').ipcRenderer : null;
async function save() {
  const r = manuscript.applyPatch(text);
  localStorage.setItem('ne:graph', JSON.stringify(graph.toJSON()));
  let where = 'localStorage';
  if (ipc && curDir && curName) {
    try {
      where = await ipc.invoke('write-abs', { p: curDir + '/' + curName, content: text }); // 話=100%ベタtxt(.bak一世代)
      if (ledger) { ledger.files[curName] = ledgerEntry(); await saveLedger(); } // 証明は台帳へ(sha+チェーン錨)
    } catch (e) { where = 'localStorage(ディスク保存失敗)'; }
  } else if (ipc) {
    try {
      const p = await ipc.invoke('save-file', { name: curDocId.replace('novel:', '') + '.txt', content: text });
      await ipc.invoke('save-file', { name: 'graph.json', content: JSON.stringify(graph.toJSON()) });
      where = p;
    } catch (e) { where = 'localStorage(ディスク保存失敗)'; }
  }
  refreshEpisodeSel(); // 目次の字数を更新
  setTimeout(summarizeEpisodes, 1500); // 変わった話だけLLMが一行要約(台帳キャッシュ)
  status(`保存 (${r.action}) — 履歴 ${manuscript.totalHistory} 版 → ${where}`);
  logEvt('state', { sha: sha256hex(text), len: text.length, d: curDocId }); // 原稿状態の時系列をチェーンに固定(作品ID付き)
  llmHarvest(); // 保存のついでに原稿から固有名詞を採取
}

// ---- 出力先ルーティング(本文 or 練習バッファ) + 作法エンジン(決定的な入力時整形) ----
const NO_INDENT = new Set([...'「『（――……　\n']); // セリフ・リーダー行は字下げしない
function out(s) {
  if (tut) { tut.buf += s; tutCheck(); return; }
  snap(false);
  followCaret = true;
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
    if ('」』）'.includes(first) && text.slice(0, cursor).endsWith('。')) {
      text = text.slice(0, cursor - 1) + text.slice(cursor);
      cursor--;
      committedTo = Math.min(committedTo, cursor);
    }
  }
  text = text.slice(0, cursor) + s + text.slice(cursor);
  cursor += s.length;
  if (!/^[ぁ-んー]+$/.test(s)) committedTo = cursor; // 記号・改行・漢字は打った時点で確定
}

// 実体の閉じカッコを飛び越える(。」の句点はここでも落とす)
function closeOver(n) {
  for (let i = 0; i < n && closers.length; i++) {
    const ch = closers[closers.length - 1];
    closers.pop();
    if (text[cursor] !== ch) continue; // 実体が編集で消えていたら予約だけ破棄
    if ('」』）'.includes(ch) && text.slice(0, cursor).endsWith('。')) {
      text = text.slice(0, cursor - 1) + text.slice(cursor);
      cursor--;
    }
    cursor++;
  }
  committedTo = cursor;
}

// ---- Undo/Redo: 打鍵の節目ごとに状態スナップショット ----
function snap(force) {
  if (tut) return;
  const now = Date.now();
  if (!force && now - lastSnapT < 1200) return;
  lastSnapT = now;
  undoStack.push({ text, cursor, committedTo });
  if (undoStack.length > 200) undoStack.shift();
  redoStack = [];
}
function applyState(st) {
  text = st.text; cursor = st.cursor; committedTo = st.committedTo;
  closers = []; mode = 'NONE'; reading = ''; convRestore = ''; candPaths = null; symJump = 0;
  followCaret = true;
  render();
}
function undo() {
  if (!undoStack.length) return;
  redoStack.push({ text, cursor, committedTo });
  applyState(undoStack.pop());
  logEvt('undo', { sha: sha256hex(text), len: text.length }); // 復元結果を固定(リプレイ乖離の検出点)
}
function redo() {
  if (!redoStack.length) return;
  undoStack.push({ text, cursor, committedTo });
  applyState(redoStack.pop());
  logEvt('redo', { sha: sha256hex(text), len: text.length });
}

// カーソル移動: 未確定を確定してから動く(閉じは実体済みなのでスタックだけ畳む)
function moveCursor(p) {
  if (tut) return;
  if (mode === 'CAND') cancel();
  closers = [];
  committedTo = cursor;
  cursor = Math.max(0, Math.min(text.length, p));
  committedTo = cursor;
  logEvt('mv', { to: cursor });
  render();
}
globalThis.__neMove = moveCursor; // e2e 用

// ---- 打鍵・変換イベントログ(書類/novel-editor/log.jsonl、完全ローカル) ----
// 用途: 配列の実測再最適化(キー間遷移時間)・弱点ドリル・審査員の採用率・速度曲線
let logBuf = [];
let logHash = localStorage.getItem('ne:logHash') || '0';
// SHA-256(チェーン用)。Electron では node crypto、無ければ同期純JS実装(e2e で node:crypto と一致検証済み)
const nodeCrypto = typeof window !== 'undefined' && window.require ? window.require('crypto') : null;
const SHA_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];
function sha256hex(str) {
  if (nodeCrypto) return nodeCrypto.createHash('sha256').update(str).digest('hex');
  const bytes = new TextEncoder().encode(str);
  const bitLen = bytes.length * 8;
  const padded = new Uint8Array((((bytes.length + 8) >> 6) + 1) << 6);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000));
  dv.setUint32(padded.length - 4, bitLen >>> 0);
  const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w = new Uint32Array(64);
  const rr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rr(w[i - 15], 7) ^ rr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rr(w[i - 2], 17) ^ rr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e2, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = rr(e2, 6) ^ rr(e2, 11) ^ rr(e2, 25);
      const ch = (e2 & f) ^ (~e2 & g);
      const t1 = (h + S1 + ch + SHA_K[i] + w[i]) >>> 0;
      const S0 = rr(a, 2) ^ rr(a, 13) ^ rr(a, 22);
      const mj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + mj) >>> 0;
      h = g; g = f; f = e2; e2 = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e2) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
  }
  return H.map((x) => x.toString(16).padStart(8, '0')).join('');
}
globalThis.__neSha = sha256hex; // e2e 用(node:crypto との一致検証)
function logEvt(type, data) {
  // 各行が前行のハッシュを含む append-only チェーン(SHA-256)。
  // 決定的エンジン+このログ=原稿を打鍵から再導出できる=「人が書いた」検証可能な証拠
  const body = JSON.stringify({ t: Date.now(), e: type, ...data, p: logHash });
  logHash = sha256hex(logHash + body);
  localStorage.setItem('ne:logHash', logHash);
  logBuf.push(body);
  if (globalThis.__neTap) globalThis.__neTap(type, data); // e2e 用(flushで消えないイベント観測点)
  if (logBuf.length >= 500) flushLog();
}
globalThis.__neLogLast = () => logBuf[logBuf.length - 1]; // e2e 用
globalThis.__neLogAll = () => logBuf.slice();

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
  ipc.invoke('save-file', { name: 'chainhead.txt', content: logHash }).catch(() => {}); // localStorage 消失への保険
}
globalThis.__neLogSize = () => logBuf.length; // e2e 用

// ---- 著者証明レポート(証ボタン): ログを集計・チェーン検証して提出物を生成 ----
function buildCertReport(logText, anchorsText, expectedHead) {
  const lines = (logText || '').split('\n').filter(Boolean);
  const anchors = (anchorsText || '').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const anchorHeads = new Set(anchors.map((a) => a.logHash));
  const foundHeads = new Set();
  let head = lines.length ? (JSON.parse(lines[0]).p ?? '0') : '0';
  let broken = -1;
  const st = { k: 0, rep: 0, conv: 0, pick: 0, paste: [], imports: 0, openext: [], extedit: 0, states: [], modes: { h: 0, v: 0, t: 0 } };
  let tMin = null, tMax = null, sessions = 0, lastT = 0;
  for (let i = 0; i < lines.length; i++) {
    let e;
    try { e = JSON.parse(lines[i]); } catch { if (broken < 0) broken = i; continue; }
    if (broken < 0) {
      if (e.p !== head) broken = i;
      else {
        head = sha256hex(head + lines[i]);
        if (anchorHeads.has(head)) foundHeads.add(head); // 公証headが中間headとして再現するか(前方切り詰め検出)
      }
    }
    if (tMin === null) tMin = e.t;
    tMax = e.t;
    if (e.t - lastT > 1800000) sessions++;
    lastT = e.t;
    if (e.e === 'k') { st.k++; if (e.r) st.rep++; if (e.m) st.modes[e.m] = (st.modes[e.m] || 0) + 1; }
    else if (e.e === 'conv') st.conv++;
    else if (e.e === 'pick') st.pick++;
    else if (e.e === 'paste') st.paste.push({ at: new Date(e.t).toISOString(), len: [...(e.s || '')].length });
    else if (e.e === 'voice') st.voice = (st.voice || 0) + 1;
    else if (e.e === 'stt') st.sttChars = (st.sttChars || 0) + [...(e.s || '')].length;
    else if (e.e === 'import') st.imports++;
    else if (e.e === 'openext') st.openext.push({ f: e.f, len: e.len || 0 });
    else if (e.e === 'extedit') st.extedit++;
    else if (e.e === 'state') { if (!e.d || e.d === curDocId) st.states.push({ at: new Date(e.t).toISOString(), sha: e.sha, len: e.len }); }
  }
  const pasteTotal = st.paste.reduce((a, p) => a + p.len, 0);
  const chainOk = broken < 0 && (!expectedHead || head === expectedHead);
  const anchorOk = anchorHeads.size === 0 || foundHeads.size === anchorHeads.size;
  const fmt = (iso) => iso.replace('T', ' ').slice(0, 19);
  return [
    '# 著者証明レポート(novel-editor)',
    `発行: ${new Date().toISOString()}`,
    `対象原稿: ${curDocId.replace('novel:', '')}(${curDocId})/ ${text.length}字 / sha256: ${sha256hex(text)}`,
    '',
    '## 打鍵チェーン検証(SHA-256)',
    `- 記録イベント: ${lines.length}行`,
    chainOk
      ? anchorHeads.size > 0 && anchorOk
        ? `- チェーン整合性: ✓ 最古のアンカー時点まで完全性を検証(末尾 head: ${head.slice(0, 16)}…)`
        : `- チェーン整合性: ✓ 末尾からの連鎖一致を検証(末尾 head: ${head.slice(0, 16)}…)`
      : `- チェーン整合性: ✗ ${broken >= 0 ? broken + 1 + '行目で不整合' : '末尾headが現在値と不一致'}`,
    `- アンカー照合: ${foundHeads.size}/${anchorHeads.size} 件の公証headが中間headとして再現${anchorHeads.size > 0 && !anchorOk ? '(⚠ 前方欠落の可能性)' : ''}`,
    '',
    '## 執筆統計',
    `- 総打鍵: ${st.k}(うちキーリピート ${st.rep})`,
    `- 変換: ${st.conv}回 / 確定: ${st.pick}回`,
    tMin ? `- 期間: ${fmt(new Date(tMin).toISOString())} 〜 ${fmt(new Date(tMax).toISOString())} / セッション数(30分無操作区切り): ${sessions}` : '- 期間: 記録なし',
    `- モード内訳: 横書き ${st.modes.h || 0} / 縦書き ${st.modes.v || 0} / 練習 ${st.modes.t || 0} 打鍵`,
    '',
    '## 外部由来テキスト(全件開示)',
    `- 貼り付け: ${st.paste.length}件 / 合計 ${pasteTotal}字`,
    ...st.paste.slice(-20).map((p) => `  - ${fmt(p.at)} に ${p.len}字`),
    `- 外部ファイル取込: ${st.openext.length}件 / 合計 ${st.openext.reduce((a, o) => a + o.len, 0)}字` + (st.openext.length ? `(${st.openext.slice(-10).map((o) => o.f).join(', ')})` : ''),
    `- 外部編集の再基準化: ${st.extedit}回`,
    `- バックアップ復元: ${st.imports}件`,
    `- 音声入力: 録音 ${st.voice || 0}件 / 書き起こし ${st.sttChars || 0}字(本人発話。音声はsha付きでチェーン固定・保存)`,
    '',
    '## 原稿状態チェックポイント(対象作品のみ・保存毎にチェーンへ固定)',
    `- ${st.states.length}件。直近:`,
    ...st.states.slice(-5).map((x) => `  - ${fmt(x.at)} / ${x.len}字 / sha256 ${x.sha.slice(0, 12)}…`),
    '',
    '## 第三者タイムスタンプ(OpenTimestamps、pending証明)',
    `- ${anchors.length}件`,
    ...anchors.slice(-10).map((a) => `  - ${fmt(a.at)} / ${a.sha256.slice(0, 12)}… / ${a.proofs.length}カレンダー`),
    '',
    '## 本エディタの保証事項',
    '- 公理0: 本文の全文字は人間の打鍵から決定的に導出される',
    '- ローカルLLMの役割は変換候補の選別(あり得ない候補の除去・並べ替え)のみである。',
    '  出力は既存候補の番号に拘束され、本文の文字を生成・変更する経路は存在しない。',
    '  人間の打鍵を変更する動作は一切行わない',
    '- 外部由来テキスト(貼り付け・復元)は全てログに全文記録され、本レポートに開示される',
    '- ログは各行が前行の SHA-256 を含む append-only チェーンであり、部分改ざんは検出される',
  ].join('\n');
}
globalThis.__neCert = buildCertReport; // e2e 用
async function issueCertificate() {
  flushLog();
  let logText = '', anchorsText = '';
  if (ipc) {
    try { logText = (await ipc.invoke('read-file', { name: 'log.jsonl' })) || ''; } catch {}
    try { anchorsText = (await ipc.invoke('read-file', { name: 'anchors.jsonl' })) || ''; } catch {}
  }
  const report = buildCertReport(logText, anchorsText, logHash);
  if (ipc) {
    const d = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const p = await ipc.invoke('export-dialog', { defaultName: `著者証明-${d}.txt`, content: report });
    status(p ? `証明書を発行 → ${p}` : '発行をキャンセルしました');
  } else {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([report], { type: 'text/plain' }));
    a.download = 'certificate.txt';
    a.click();
  }
}

// ---- 音声入力(同梱 whisper.cpp): 声のログ=生体証拠としても保存 ----
const VOICE_UI = false; // 音声入力はいったん休眠(精度が実用域に達したら true に戻す)。内部実装とテストは温存
const WHISPER_URL = 'http://127.0.0.1:18436';
let rec = null, recChunks = [], recStart = 0;
function updateMicBtn() {
  const b = document.getElementById('mic');
  if (b) { b.textContent = rec ? '⏺' : '🎤'; if (b.classList) b.classList[rec ? 'add' : 'remove']('rec'); }
}
function abToB64(buf) {
  const u8 = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(bin);
}
async function toWav16k(arrayBuf) {
  const ac = new AudioContext({ sampleRate: 16000 });
  const audio = await ac.decodeAudioData(arrayBuf.slice(0));
  ac.close();
  const ch = audio.getChannelData(0);
  let sum = 0;
  for (let i = 0; i < ch.length; i += 16) sum += ch[i] * ch[i];
  toWav16k.rms = Math.sqrt(sum / Math.max(1, ch.length / 16)); // 無音診断用
  const pcm = new Int16Array(ch.length);
  for (let i = 0; i < ch.length; i++) pcm[i] = Math.max(-32768, Math.min(32767, Math.round(ch[i] * 32767)));
  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const dv = new DataView(buf);
  const wstr = (o, str) => { for (let i = 0; i < str.length; i++) dv.setUint8(o + i, str.charCodeAt(i)); };
  wstr(0, 'RIFF'); dv.setUint32(4, 36 + pcm.length * 2, true); wstr(8, 'WAVE');
  wstr(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, 16000, true); dv.setUint32(28, 32000, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  wstr(36, 'data'); dv.setUint32(40, pcm.length * 2, true);
  new Int16Array(buf, 44).set(pcm);
  return buf;
}
let sttPairs = JSON.parse(localStorage.getItem('ne:sttPairs') || '[]'); // 過去の(raw→かな)補正例
let voiceCal = JSON.parse(localStorage.getItem('ne:voiceCal') || '[]'); // 音読キャリブレーション(聞き取り→正解かな)
let calib = null; // {items, idx} 実施中のキャリブレーション
function voiceInsert(t, sha, extra) {
  if (extra?.raw && extra?.kana) { // 自己改善: 過去の書き起こし補正を次回の例示に使う
    sttPairs.push([extra.raw, extra.kana]);
    if (sttPairs.length > 20) sttPairs.shift();
    localStorage.setItem('ne:sttPairs', JSON.stringify(sttPairs));
  }
  if (mode === 'CAND') confirmCand();
  snap(true);
  logEvt('stt', { sha, s: t, ...(extra || {}) }); // 最終文+raw/かな の三層を記録(監査可能)
  text = text.slice(0, cursor) + t + text.slice(cursor);
  cursor += t.length;
  committedTo = cursor;
  viewSpread = -1; followCaret = true;
  status(`音声入力: ${t.length}字`);
  render();
}
globalThis.__neVoice = voiceInsert; // e2e 用
// 自分の語彙(確定学習+自動登録)を whisper のバイアス用に
function ownSurfaces() {
  const set = new Set();
  for (const m of [userDict, autoDict]) for (const o of Object.values(m)) for (const s2 of Object.keys(o)) set.add(s2);
  return [...set].slice(0, 40).join('、');
}
// 音声パイプライン: whisper出力 → LLMで全ひらがな化 → 文節ごとに自前変換(辞書・開き癖が効く)
async function voicePipeline(raw, sha) {
  if (calib) { calibFeed(raw, sha); return; } // 声合わせ中: 挿入せず(聞き取り→正解)ペアを採取
  let kana = null;
  try {
    const r = await fetch(smartUrl() + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: `次の文を、句読点・記号はそのままに、すべてひらがなに直してください。説明不要、結果のみ。${voiceCal.slice(-3).map((c2) => `\n例:「${c2.h}」→「${c2.y}」`).join('')}${sttPairs.slice(-2).map(([r2, k2]) => `\n例:「${r2}」→「${k2}」`).join('')}\n文:「${raw}」\n結果:` }],
        temperature: 0, max_tokens: 400,
      }),
      signal: AbortSignal.timeout(30000),
    });
    kana = kataToHira(((await r.json()).choices[0].message.content || '').replace(/[「」\s]/g, '').trim());
    if (!/^[ぁ-んー。、！？…―()（）]+$/.test(kana)) kana = null; // かな化に失敗していたら使わない
  } catch {}
  if (!kana) {
    const k2 = kataToHira(raw); // whisperがカタカナで返す癖への保険
    if (/^[ぁ-んー。、！？…―()（）]+$/.test(k2)) kana = k2;
  }
  if (!kana) { voiceInsert(raw, sha, { raw }); return; } // フォールバック: whisper出力をそのまま
  // 文節ごとに自前ラティスで表記を決める(自分の辞書・固有名詞・開き癖が効く)
  // 未知のカタカナ固有名詞はラティスに入る前に保護(切り刻み防止)。原文の表記のまま温存する
  const prot = [];
  for (const K of new Set(raw.match(/[ァ-ヶー]{2,}/g) || [])) {
    const hira = kataToHira(K);
    if (/^[ぁ-んー]+$/.test(hira) && !baseDict[hira] && !dict[hira] && !userDict[hira] && !autoDict[hira] && !FUNC.has(hira))
      prot.push({ K, hira });
  }
  let work = kana;
  prot.forEach((p3, i) => { work = work.split(p3.hira).join(`\uE000${i}\uE001`); });
  const parts = work.split(/([。、！？…―]+)/);
  let outText = '';
  for (const p2 of parts) {
    if (!p2) continue;
    const bits = p2.split(/\uE000(\d+)\uE001/);
    for (let bi = 0; bi < bits.length; bi++) {
      if (bi % 2 === 1) { outText += prot[Number(bits[bi])].K; continue; }
      const b2 = bits[bi];
      if (!b2) continue;
      if (!/^[ぁ-んー]+$/.test(b2)) { outText += b2; continue; }
      const best = latticeBest(b2, 1)[0];
      outText += best ? best.out : b2;
    }
  }
  voiceInsert(outText, sha, { raw, kana });
}
globalThis.__neVoicePipe = voicePipeline; // e2e 用
async function handleVoice(blob, dur) {
  const buf = await blob.arrayBuffer();
  const b64 = abToB64(buf);
  const sha = sha256hex(b64);
  const fname = `voice-${Date.now()}.webm`;
  if (ipc) { try { await ipc.invoke('save-voice', { name: fname, b64 }); } catch {} }
  logEvt('voice', { f: fname, sha, bytes: buf.byteLength, dur }); // 声そのものを証拠として固定
  status('書き起こし中…');
  try {
    const wav = await toWav16k(buf);
    if ((toWav16k.rms || 0) < 1e-4) { // 無音: whisperに送っても「(音楽)」幻聴になるだけ
      status('録音が無音でした — システム設定>プライバシーとセキュリティ>マイク で許可を確認してください');
      return;
    }
    const fd = new FormData();
    fd.append('file', new Blob([wav], { type: 'audio/wav' }), 'a.wav');
    fd.append('response_format', 'json');
    const bias = ownSurfaces();
    if (bias) fd.append('prompt', bias); // 自分の固有名詞でwhisperをバイアス
    const r = await fetch(WHISPER_URL + '/inference', { method: 'POST', body: fd, signal: AbortSignal.timeout(120000) });
    const t = ((await r.json()).text || '').replace(/\s+/g, '').trim();
    if (t) await voicePipeline(t, sha);
    else status('書き起こし結果が空でした');
  } catch { status('書き起こし失敗(whisper起動待ちの可能性)'); }
}
async function populateMics() {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) return;
  const sel = document.getElementById('micsel');
  if (!sel) return;
  try {
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
    const saved = localStorage.getItem('ne:micId') || '';
    sel.innerHTML = devs
      .map((d, i) => `<option value="${esc(d.deviceId)}"${d.deviceId === saved ? ' selected' : ''}>${esc(d.label || 'マイク' + (i + 1))}</option>`)
      .join('');
  } catch {}
}
function startCalib() {
  const ls2 = (drills.lines || []).filter(([s2, y]) => s2.length >= 8 && s2.length <= 24);
  if (ls2.length < 3) { status('教材が足りません'); return; }
  const items = [];
  for (let i = 0; i < 5; i++) items.push(ls2[(Math.random() * ls2.length) | 0]);
  calib = { items, idx: 0 };
  render();
  status('声合わせ: 表示された文を左Cmd押しながら音読→離す(Escで終了)');
}
function calibFeed(raw, sha) {
  const [orig, yomi] = calib.items[calib.idx];
  voiceCal.push({ h: raw, y: yomi, o: orig });
  if (voiceCal.length > 50) voiceCal.shift();
  localStorage.setItem('ne:voiceCal', JSON.stringify(voiceCal));
  logEvt('vcal', { sha, o: orig, h: raw });
  calib.idx++;
  if (calib.idx >= calib.items.length) {
    calib = null;
    status(`声合わせ完了: ${voiceCal.length}ペア蓄積(かな化補正の例示に使われます)`);
  } else status(`声合わせ ${calib.idx + 1}/${calib.items.length}`);
  render();
}
globalThis.__neCalib = { start: startCalib, feed: (r2, s2) => calibFeed(r2, s2), get: () => calib };
async function micToggle(viaPtt) {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) { status('マイク非対応環境です'); return; }
  if (rec) { rec.stop(); return; }
  try {
    const micId = document.getElementById('micsel')?.value || localStorage.getItem('ne:micId') || '';
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: micId ? { deviceId: { exact: micId } } : true,
    });
    recChunks = []; recStart = Date.now();
    rec = new MediaRecorder(stream, { mimeType: 'audio/webm' });
    rec._ptt = !!viaPtt;
    rec._cancel = false;
    rec.ondataavailable = (e) => recChunks.push(e.data);
    rec.onstop = async () => {
      stream.getTracks().forEach((tr) => tr.stop());
      const wasPtt = rec?._ptt, canceled = rec?._cancel;
      const blob = new Blob(recChunks, { type: 'audio/webm' });
      const dur = Date.now() - recStart;
      rec = null; updateMicBtn();
      if (canceled || (wasPtt && dur < 300)) { status('録音を破棄しました'); return; } // ショートカット誤爆/短すぎ
      await handleVoice(blob, dur);
    };
    rec.start();
    updateMicBtn();
    const dev = stream.getAudioTracks()[0]?.label || '不明なデバイス';
    status(viaPtt ? `録音中(${dev})…(左Cmdを離すと書き起こし)` : `録音中(${dev})…(🎤で停止→書き起こし)`);
  } catch { status('マイクの使用が許可されませんでした'); }
}

// ---- 作品ファイル(正本): 本文プレーンtxt + 機械用メタ(sha/チェーン錨)の同居形式 ----
const WORK_MARKER = '\n――― novel-editor: 以下は機械用メタ(本文はこの行より上) ―――\n'; // 旧・埋め込み形式(読み込み互換のみ)
// 作品=フォルダ、話=中の素txt(100%ベタ)、証明=台帳 novel-editor.json(各txtの sha+チェーン錨)
let curDir = localStorage.getItem('ne:curDir') || null;
let curName = localStorage.getItem('ne:curName') || null; // いま開いている話のファイル名
let ledger = null; // { v, name, order:[], files:{ name:{sha,len,chainHead,savedAt} }, lastOpen }
const LEDGER_FILE = 'novel-editor.json';
const firstLineOf = (body) => (body.split('\n').find((l) => l.trim()) || '').trim().slice(0, 30);
function ledgerEntry() {
  const prev = (ledger && ledger.files[curName]) || {};
  return { ...prev, sha: sha256hex(text), len: text.length, chainHead: logHash, savedAt: new Date().toISOString(), head: firstLineOf(text) };
}
async function fillHeads() { // LLM不要の一行目フォールバックを全話ぶん埋める
  if (!ipc || !curDir || !ledger) return;
  let dirty = false;
  for (const name of ledger.order) {
    const f = ledger.files[name];
    if (!f || f.head !== undefined) continue;
    const body = (await ipc.invoke('read-abs', { p: curDir + '/' + name })) || '';
    f.head = firstLineOf(parseWork(body).body ?? body);
    dirty = true;
  }
  if (dirty) { await saveLedger(); refreshEpisodeSel(); }
}
function parseWork(content) { // 旧形式の互換読み(メタ埋め込みtxt)
  const i = content.lastIndexOf(WORK_MARKER);
  if (i < 0) return { body: content, meta: null, verified: false }; // 素txtは無加工(改行剥がしはsha不一致=偽extedit事故の元)
  const body = content.slice(0, i);
  let meta = null;
  try { meta = JSON.parse(content.slice(i + WORK_MARKER.length)); } catch {}
  return { body, meta, verified: !!meta && meta.sha === sha256hex(body) };
}
globalThis.__neWork = { entry: ledgerEntry, parse: parseWork, verify: (body, e2) => !!e2 && e2.sha === sha256hex(body) }; // e2e 用
async function loadLedger(dir) {
  try {
    const raw = await ipc.invoke('read-abs', { p: dir + '/' + LEDGER_FILE });
    if (raw) return JSON.parse(raw);
  } catch {}
  return { v: 1, name: dir.split('/').pop(), order: [], files: {}, lastOpen: null };
}
async function saveLedger() {
  if (!ipc || !curDir || !ledger) return;
  await ipc.invoke('write-abs', { p: curDir + '/' + LEDGER_FILE, content: JSON.stringify(ledger, null, 1) });
}
function refreshEpisodeSel() {
  const sel = document.getElementById('doc');
  if (!sel || !ledger) return;
  sel.innerHTML = ledger.order.map((n) => `<option value="${n.replace(/"/g, '&quot;')}"${n === curName ? ' selected' : ''}>${n.replace(/\.txt$/, '')}</option>`).join('');
  const fb = document.getElementById('filename');
  if (fb) fb.textContent = ledger.name;
  const toc = document.getElementById('toc'); // 右パネルの目次(クリックで話を切替+LLM一行要約)
  if (toc) {
    toc.innerHTML = ledger.order.map((n) => {
      const f = ledger.files[n] || {};
      const len = n === curName ? text.length : (f.len ?? '');
      const s1 = f.summary || f.head || ''; // 要約が無ければ本文一行目
      const sum = s1 ? `<div class="sum">${s1.replace(/</g, '&lt;')}</div>` : '';
      return `<div class="ep${n === curName ? ' cur' : ''}" data-ep="${n.replace(/"/g, '&quot;')}"><div class="eprow"><span>${n.replace(/\.txt$/, '')}</span><span class="len">${len !== '' ? len + '字' : ''}</span></div>${sum}</div>`;
    }).join('');
  }
}
function adoptEpisode(body) {
  curDocId = 'novel:' + (ledger ? ledger.name : '') + '/' + curName;
  localStorage.setItem('ne:curDoc', curDocId);
  localStorage.setItem('ne:curDir', curDir);
  localStorage.setItem('ne:curName', curName);
  text = body;
  cursor = text.length; committedTo = cursor;
  closers = []; mode = 'NONE'; reading = '';
  undoStack = []; redoStack = []; viewSpread = -1; followCaret = true;
  manuscript = graph.get(curDocId) || new Block({ id: curDocId, type: 'text' });
  if (!graph.has(curDocId)) graph.add(manuscript);
  refreshEpisodeSel();
  render();
}
async function openEpisode(name, opts = {}) {
  if (!ipc || !curDir) return;
  if (curName && curName !== name && !opts.noSave) await save(); // 移る前に今の話を保存
  const raw = (await ipc.invoke('read-abs', { p: curDir + '/' + name })) ?? '';
  const legacy = parseWork(raw);
  const body = legacy.meta ? legacy.body : raw; // 旧埋め込み形式は本文だけ剥がして移行、素txtは無加工
  const known = ledger.files[name];
  curName = name;
  if (!ledger.order.includes(name)) ledger.order.push(name);
  ledger.lastOpen = name;
  if (known && known.sha === sha256hex(body)) {
    adoptEpisode(body);
    logEvt('open', { f: name, sha: known.sha, head: known.chainHead });
    status(`${name.replace(/\.txt$/, '')} を開きました(台帳と整合 ✓)`);
  } else if (known) {
    if (!opts.force && !window.confirm(`「${name}」は外部で編集されています(台帳のshaと不一致)。開いて再基準化しますか?`)) { curName = null; return; }
    adoptEpisode(body);
    logEvt('extedit', { f: name, sha: sha256hex(body), len: body.length }); // 外部編集を正直に記録
    status(`${name.replace(/\.txt$/, '')} を開きました(外部編集を検出・再基準化)`);
  } else {
    adoptEpisode(body);
    logEvt('openext', { f: name, sha: sha256hex(body), len: body.length }); // 台帳に無い=外部由来として記録
    status(`${name.replace(/\.txt$/, '')} を取り込みました(外部由来として記録)`);
  }
  ledger.files[name] = ledgerEntry();
  await saveLedger();
}
async function openWork() {
  if (!ipc) { status('作品フォルダを開くのは Electron 実行時のみです'); return; }
  const dir = await ipc.invoke('open-dir-dialog');
  if (!dir) return;
  const guard = await ipc.invoke('read-abs', { p: dir + '/chainhead.txt' }); // データ置き場を作品にしない
  if (guard) { status('そこはアプリのデータ置き場です。別のフォルダを選んでください'); return; }
  curDir = dir; curName = null;
  ledger = await loadLedger(dir);
  const disk = await ipc.invoke('list-dir', { p: dir });
  ledger.order = ledger.order.filter((n) => disk.includes(n)).concat(disk.filter((n) => !ledger.order.includes(n)));
  if (!ledger.order.length) { // 空フォルダ=新しい作品
    curName = '第1話.txt';
    ledger.order = [curName];
    adoptEpisode('');
    logEvt('doc', { id: curDocId });
    await save();
    status(`新しい作品: ${ledger.name}(第1話から)`);
    return;
  }
  await openEpisode(ledger.lastOpen && ledger.order.includes(ledger.lastOpen) ? ledger.lastOpen : ledger.order[0], { noSave: true });
  if (memoOpen) loadMemo();
}
async function newEpisode() {
  if (!ipc || !curDir || !ledger) { status('先に「開く」で作品フォルダを選んでください'); return; }
  const def = `第${ledger.order.length + 1}話`;
  const name0 = window.prompt ? window.prompt('新しい話の名前:', def) : def;
  if (!name0) return;
  const name = name0.endsWith('.txt') ? name0 : name0 + '.txt';
  if (ledger.order.includes(name)) { status('同名の話があります'); return; }
  await save(); // 今の話を確定してから
  curName = name;
  ledger.order.push(name);
  ledger.lastOpen = name;
  adoptEpisode('');
  logEvt('doc', { id: curDocId });
  await save();
  status(`新しい話: ${name.replace(/\.txt$/, '')}`);
}
let memoOpen = localStorage.getItem('ne:memoOpen') !== 'off'; // 既定で開く(目次が見える方が親切)
let memoTimer = null;
async function loadMemo() {
  const ta = document.getElementById('memo');
  if (!ta) return;
  let v = '';
  if (ipc && curDir) {
    try {
      v = (await ipc.invoke('read-abs', { p: curDir + '/memo.txt' })) || '';
      if (!v) v = (await ipc.invoke('read-abs', { p: curDir + '/メモ.txt' })) || ''; // 旧名からの移行読み
    } catch {}
  }
  else v = localStorage.getItem('ne:memoText') || '';
  ta.value = v;
}
function saveMemoSoon() {
  clearTimeout(memoTimer);
  memoTimer = setTimeout(async () => {
    const ta = document.getElementById('memo');
    if (!ta) return;
    if (ipc && curDir) { try { await ipc.invoke('write-abs', { p: curDir + '/memo.txt', content: ta.value }); } catch {} }
    else localStorage.setItem('ne:memoText', ta.value);
  }, 800);
}
function toggleMemo() {
  memoOpen = !memoOpen;
  localStorage.setItem('ne:memoOpen', memoOpen ? 'on' : 'off');
  if (typeof document.body?.classList?.toggle === 'function') document.body.classList.toggle('with-memo', memoOpen);
  if (memoOpen) loadMemo();
  render();
}
let overview = false, ovData = null;
async function toggleOverview() {
  if (overview) { overview = false; ovData = null; render(); return; }
  if (!ipc || !curDir || !ledger) { status('俯瞰は作品フォルダを開いてから'); return; }
  await save(); // 現状を確定してから見渡す
  ovData = [];
  for (const name of ledger.order) {
    const body = name === curName ? text : (parseWork((await ipc.invoke('read-abs', { p: curDir + '/' + name })) || '').body || '');
    const f = ledger.files[name] || {};
    ovData.push({
      name,
      len: body.length,
      sum: f.summary || f.head || '',
      head: body.split('\n').filter((l) => l.trim()).slice(0, 3).join('\n'),
    });
  }
  overview = true;
  render();
}
function renderOverview(el) {
  el.classList.remove('tate');
  el.classList.add('ov');
  const total = ovData.reduce((a, d) => a + d.len, 0);
  el.innerHTML =
    `<div class="ovhead">俯瞰 — ${ledger.name}(全${ovData.length}話・${total.toLocaleString()}字)<span class="ovnote">クリックでその話へ / Escで戻る</span></div>` +
    `<div class="ovgrid">` +
    ovData.map((d) => `<div class="ovcard" data-ep="${d.name.replace(/"/g, '&quot;')}">` +
      `<div class="ovtitle">${d.name.replace(/\.txt$/, '')}<span class="ovlen">${d.len.toLocaleString()}字</span></div>` +
      (d.sum ? `<div class="ovsum">${d.sum.replace(/</g, '&lt;')}</div>` : '') +
      `<div class="ovbody">${d.head.replace(/</g, '&lt;')}</div>` +
      `</div>`).join('') +
    `</div>`;
  document.getElementById('mode').textContent = '俯';
}
let sumBusy = false;
async function summarizeEpisodes() { // 目次の一行要約(LLM)。本文には触れないメタデータで、台帳にキャッシュ
  if (sumBusy || !ipc || !curDir || !ledger || !llmReady || !llmOn) return;
  sumBusy = true;
  try {
    for (const name of ledger.order.slice()) {
      const f = ledger.files[name];
      if (!f || (f.summary && f.sumSha === f.sha)) continue;
      const body = name === curName ? text : ((await ipc.invoke('read-abs', { p: curDir + '/' + name })) || '');
      if (body.length < 40) continue; // 書き始めは要約しない
      const excerpt = body.length > 900 ? body.slice(0, 700) + '\n…\n' + body.slice(-200) : body;
      const prompt = `次の小説本文の内容を日本語20字以内で一行に要約してください。要約だけを出力:\n「${excerpt}」`;
      try {
        const r = await fetch(smartUrl() + '/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: [{ role: 'user', content: prompt }], temperature: 0, max_tokens: 48, stop: ['\n'] }),
          signal: AbortSignal.timeout(30000),
        });
        const sum = ((await r.json()).choices[0].message.content || '').trim().slice(0, 30);
        if (sum && ledger.files[name]) {
          ledger.files[name].summary = sum;
          ledger.files[name].sumSha = ledger.files[name].sha;
          if (ledger.files[name].head === undefined) ledger.files[name].head = firstLineOf(body);
          await saveLedger();
          refreshEpisodeSel();
        }
      } catch {}
    }
  } finally { sumBusy = false; }
}
globalThis.__neFile = { // e2e 用(偽ipcを注入してフォルダ正本系を通しテスト)
  setIpc: (v) => { ipc = v; },
  openWork, openEpisode, newEpisode, toggleOverview, fillHeads,
  state: () => ({ curDir, curName, ledger, overview }),
  reset: () => { curDir = null; curName = null; ledger = null; overview = false; ovData = null; },
};
async function initFileMode() { // 起動時: 前回の作品フォルダを復元(外部編集もここで検出)
  if (!ipc || !curDir) return;
  ledger = await loadLedger(curDir);
  const disk = await ipc.invoke('list-dir', { p: curDir });
  ledger.order = ledger.order.filter((n) => disk.includes(n)).concat(disk.filter((n) => !ledger.order.includes(n)));
  if (!ledger.order.length) { curDir = null; return; }
  const target = curName && ledger.order.includes(curName) ? curName : ledger.lastOpen || ledger.order[0];
  curName = null;
  await openEpisode(target, { noSave: true, force: true });
  fillHeads(); // 一行目フォールバックはLLM不要なので即
  setTimeout(summarizeEpisodes, 4000); // 審査員の起動を待ってから
}

// ---- バックアップ/復元: 原稿(履歴ごと)+学習データ+設定を1つのJSONに ----
function exportBundle() {
  manuscript.applyPatch(text); // いまの原稿をコミットしてから書き出す
  localStorage.setItem('ne:graph', JSON.stringify(graph.toJSON()));
  return JSON.stringify({
    app: 'novel-editor', v: 1, at: new Date().toISOString(),
    graph: graph.toJSON(),
    userDict, autoDict, observed, ctxDict, lastPick, pickSeq,
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
  ctxDict = b.ctxDict || {}; lastPick = b.lastPick || {}; pickSeq = Number(b.pickSeq || 0);
  localStorage.setItem('ne:ctxDict', JSON.stringify(ctxDict));
  localStorage.setItem('ne:lastPick', JSON.stringify(lastPick));
  localStorage.setItem('ne:pickSeq', String(pickSeq));
  if (logHash === '0' && b.logHash) { // 新規マシン移行(チェーン未開始)のときだけ継承。既存チェーンは絶対に上書きしない
    logHash = b.logHash;
    localStorage.setItem('ne:logHash', logHash);
  }
  lastScanLen = b.lastScanLen || 0;
  curDocId = 'novel:manuscript'; // 復元後の現在作品を manuscript に揃える(自動保存とstateの汚染防止)
  localStorage.setItem('ne:curDoc', curDocId);
  localStorage.setItem('ne:graph', JSON.stringify(graph.toJSON()));
  localStorage.setItem('ne:userDict', JSON.stringify(userDict));
  localStorage.setItem('ne:autoDict', JSON.stringify(autoDict));
  localStorage.setItem('ne:observed', JSON.stringify(observed));
  localStorage.setItem('ne:lastScanLen', String(lastScanLen));
  for (const [k, v] of Object.entries(b.settings || {})) localStorage.setItem('ne:' + (k === 'tutStage' ? 'tutStage' : k), v);
  // 設定のメモリ値とボタン表示も即同期(再起動待ちにしない)
  const st2 = b.settings || {};
  if (st2.tate) tategaki = st2.tate === 'on';
  if (st2.sound) soundOn = st2.sound === 'on';
  if (st2.llm) llmOn = st2.llm === 'on';
  if (st2.chart) chartOn = st2.chart === 'on';
  const tb2 = document.getElementById('tate'); if (tb2) tb2.textContent = tategaki ? '縦' : '横';
  const sb2 = document.getElementById('sound'); if (sb2) sb2.textContent = soundOn ? '♪' : '♪̸';
  const cb2 = document.getElementById('chartbtn'); if (cb2) cb2.textContent = chartOn ? '盤' : '盤̸';
  updateLlmBtn();
  rebuildSelfPred();
  undoStack = []; redoStack = [];
  refreshDocSel();
  logEvt('import', { bsha: sha256hex(json), importedHead: b.logHash || null, sha: sha256hex(text), len: text.length }); // 復元も記録(チェーンheadは不変)
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
  snap(true);
  logEvt('paste', { at: cursor, s: t }); // 外部由来テキストは全文を記録(証明力の根幹)
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
function lookup(yomi, ctx = '') {
  const user = userDict[yomi] || {};
  const corpus = dict[yomi] || [];
  const score = {};
  for (const [s, n] of corpus) score[s] = n;
  for (const [s, n] of Object.entries(autoDict[yomi] || {})) score[s] = (score[s] || 0) + n * 1e3; // 自動登録(原稿採取)
  for (const [s, n] of Object.entries(user)) score[s] = (score[s] || 0) + n * 1e6; // 自分の確定が常に勝つ
  if (ctx) for (const [s, n] of Object.entries(ctxDict[ctx + '|' + yomi] || {})) score[s] = (score[s] || 0) + n * 1e9; // 同じ文脈での確定が最優先(「彼女の髪」と「あの神」が並存)
  const list = Object.entries(score)
    .sort((a, b) => b[1] - a[1] || (lastPick[yomi + '|' + b[0]] || 0) - (lastPick[yomi + '|' + a[0]] || 0)) // 同点は直近に使った方が先
    .map(([s]) => s);
  for (const [s] of baseDict[yomi] || []) if (!list.includes(s)) list.push(s); // 基底はコスト順 [表記,cost]
  if (yomi === 'かっこ') for (const p of ['『』', '（）', '「」']) { const i = list.indexOf(p); if (i >= 0) list.splice(i, 1); list.unshift(p); } // ペア候補(確定でカーソルが中に)
  if (yomi === 'あっと') for (const p of ['＠', '@']) { const i = list.indexOf(p); if (i >= 0) list.splice(i, 1); list.unshift(p); } // @はトグル専任なので変換で出す(半角が第一候補)
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
const kataToHira = (s) => s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));

// ---- ローカルLLM審査員(同梱 llama-server / TinySwallow-1.5B) ----
// 役割は「候補の番号を言う」だけ。文字は一切生成しない=公理0(内容を書かない)は無傷
const LLM_URL = 'http://127.0.0.1:18434';   // 審査員A(軽量・高速)
const LLM2_URL = 'http://127.0.0.1:18437';  // 審査員B(賢い方。採取/品詞/かな化/棚卸しもこちら)
let llmReady = false, llm2Ready = false;
const smartUrl = () => (llm2Ready ? LLM2_URL : LLM_URL); // 重い仕事は賢い方が居れば賢い方へ
let llmOn = localStorage.getItem('ne:llm') !== 'off';
let llmSeq = 0;
function updateLlmBtn() {
  const b = document.getElementById('llm');
  if (b) b.textContent = !llmReady ? '審✕' : llmOn ? '審' : '審OFF';
}
async function llmInit() {
  const tries = ipc ? 60 : 3; // Electron ならモデルロードを待つ
  for (let i = 0; i < tries && !(llmReady && llm2Ready); i++) {
    try {
      if (!llmReady) {
        const r = await fetch(LLM_URL + '/health', { signal: AbortSignal.timeout(1500) });
        if ((await r.json()).status === 'ok') llmReady = true;
      }
      if (!llm2Ready) {
        const r2 = await fetch(LLM2_URL + '/health', { signal: AbortSignal.timeout(1500) });
        if ((await r2.json()).status === 'ok') llm2Ready = true;
      }
    } catch {}
    if (llmReady && i >= 2 && !ipc) break; // ブラウザ/e2e は B 無しでも先へ
    if (!(llmReady && llm2Ready)) await new Promise((r2) => setTimeout(r2, 1000));
  }
  updateLlmBtn();
  if (llmReady && llm2Ready) status('審査員が起動しました(2モデル合議)');
  else if (llmReady) status('審査員(ローカルLLM)が起動しました');
}
const ctxOf = (upto) =>
  text.slice(0, upto).split(/(?<=[。！？\n])/).filter((x) => x.trim()).slice(-2).join('').slice(-120);
async function llmAskOne(url, list, context) {
  const prompt = `日本語のかな漢字変換の候補審査です。文脈の続きとして自然な候補の番号だけを、自然な順にカンマ区切りで挙げてください。不自然な候補は含めないでください。\n文脈:「${context}」\n候補:\n${list.map((c, i) => `${i + 1}. ${c}`).join('\n')}\n番号:`;
  const r = await fetch(url + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: prompt }], temperature: 0, max_tokens: 24, stop: ['\n'] }),
    signal: AbortSignal.timeout(8000),
  });
  return ((await r.json()).choices[0].message.content.match(/\d+/g) || []).map(Number);
}
async function llmAsk(list, context) {
  // 合議: 2人の審査員の第一候補が一致した時だけ動く。不一致なら沈黙(=辞書+文脈学習の順のまま)。
  // 「LLMは間違うくらいなら黙る」——能動的な誤審がゼロになる(2026-06-13 実測で確認済み)
  if (!llm2Ready) return llmAskOne(LLM_URL, list, context); // 単独運転(B不在)は従来動作
  const [a, b] = await Promise.allSettled([llmAskOne(LLM_URL, list, context), llmAskOne(LLM2_URL, list, context)]);
  if (a.status !== 'fulfilled') return b.status === 'fulfilled' ? b.value : [];
  if (b.status !== 'fulfilled') return a.value;
  if (!a.value.length || !b.value.length) return [];
  return a.value[0] === b.value[0] ? b.value : []; // 一致→賢い方の並びを採用、不一致→沈黙
}
// 先読みキャッシュ: ひらがな入力中に裏で審査しておき、Space の瞬間に同期適用する
const specCache = new Map(); // key(読み+文脈+候補列) -> nums
let specDirty = false, specBusy = false;
// 常時追走(single-flight): ガリガリ打ち続けても、走者1人が常に最新の読みで審査し直す
function kickSpeculate() {
  specDirty = true;
  if (specBusy) return;
  specBusy = true;
  (async () => {
    while (specDirty) {
      specDirty = false;
      await new Promise((r) => setTimeout(r, 60)); // 連打を束ねる
      try { await speculate(); } catch {}
    }
    specBusy = false;
  })();
}
function specKey(yomi, context, list) { return yomi + '\x1f' + context + '\x1f' + list.join('\x1f'); }
async function speculate() {
  if (!llmReady || !llmOn || tut || mode !== 'NONE') return;
  const plan = planConversion();
  if (!plan || plan.list.length < 2) return;
  const context = ctxOf(cursor - plan.removed.length);
  const list = plan.list.slice(0, Math.min(8, plan.list.length));
  const key = specKey(plan.yomi, context, list);
  if (specCache.has(key)) return;
  specCache.set(key, null); // 飛行中マーク(同じ問い合わせの重複防止)
  try {
    const nums = await llmAsk(list, context);
    specCache.set(key, nums);
    if (specCache.size > 60) specCache.delete(specCache.keys().next().value);
  } catch { specCache.delete(key); }
}
function judgeApply(nums, list) {
  // 並べ替え+フィルタ。表示中の第一候補/自分の語彙/ひらがな/カタカナは絶対に残す
  {
    if (!nums.length) return false;
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
    if (chosen.length < 1) return false;
    const removed = cands.length - chosen.length;
    if (candPaths) candPaths = chosen.map((c) => candPaths[oldIdx.get(c)]);
    const moved = cands[0] !== chosen[0];
    logEvt('judge', { y: reading, pick: chosen[0], mv: moved ? 1 : 0, rm: removed });
    cands = chosen;
    if (candIdx >= cands.length) candIdx = 0;
    status(`審査員: ${moved ? `「${chosen[0]}」を第一候補に` : '第一候補を支持'}${removed > 0 ? `・不自然${removed}件を除外` : ''}`);
    return true;
  }
}
async function llmRerank(seq) {
  if (!llmReady || !llmOn || tut || cands.length < 2) return;
  const context = ctxOf(cursor);
  const list = cands.slice(0, Math.min(8, cands.length));
  try {
    const nums = await llmAsk(list, context);
    if (seq !== llmSeq || mode !== 'CAND' || candIdx !== 0) return; // ユーザが先に動いたら黙る
    if (judgeApply(nums, list)) render();
  } catch {}
}
// ---- 自動辞書登録: LLMが確定済み原稿から固有名詞を採取し、2回観察で autoDict に登録 ----
async function llmHarvest() {
  if (!llmReady || !llmOn || tut) return;
  const committed = text.slice(0, committedTo);
  if (committed.length - lastScanLen < 60) return; // 新しく書けた分が貯まってから
  if (lastScanLen > committed.length) lastScanLen = committed.length; // 原稿が縮んだ場合の防御
  const prevScan = lastScanLen;
  const chunk = committed.slice(Math.max(0, lastScanLen - 40)).slice(-500); // 文脈用(重複40字含む)
  const fresh = committed.slice(prevScan); // カウントは新規部分のみ(重複二重カウントで2回観察ガードが弱るのを防ぐ)
  lastScanLen = committed.length;
  localStorage.setItem('ne:lastScanLen', String(lastScanLen));
  const prompt = `以下の小説本文から固有名詞(人名・地名・組織名・技名など)と珍しい語だけを抜き出し、1行に「表記,読み(ひらがな)」の形式で列挙してください。説明や一般語は不要です。\n本文:「${chunk}」`;
  try {
    const r = await fetch(smartUrl() + '/v1/chat/completions', {
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
      if (!chunk.includes(surf)) continue; // 原稿に実在しない抽出は捨てる(幻覚ガード)
      const occ = fresh.split(surf).length - 1;
      if (occ < 1) continue; // 新規に書かれた分だけを観察として数える
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

// ---- 自動登録辞書の定期整理: LLMが誤読み・断片・一般語の汚れを棚卸し(1日1回) ----
async function llmCurate(force) {
  if (!llmReady || !llmOn || tut) return [];
  const today = new Date().toISOString().slice(0, 10);
  if (!force && localStorage.getItem('ne:lastCurateDay') === today) return [];
  const entries = [];
  for (const [yomi, m] of Object.entries(autoDict)) for (const surf of Object.keys(m)) entries.push([yomi, surf]);
  if (!entries.length) return [];
  const batch = entries.slice(0, 40);
  const prompt = `小説用の固有名詞辞書の棚卸しです。以下の項目のうち、明らかな誤り(読みと表記の不一致・意味のない断片・固有名詞でない一般語)の番号だけをカンマ区切りで挙げてください。問題なければ「なし」。\n${batch.map(([y, s2], i) => `${i + 1}. ${s2}(読み: ${y})`).join('\n')}\n番号:`;
  try {
    const r = await fetch(smartUrl() + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: prompt }], temperature: 0, max_tokens: 60 }),
      signal: AbortSignal.timeout(20000),
    });
    const content = (await r.json()).choices[0].message.content;
    const removed = [];
    if (!content.includes('なし')) {
      for (const k of (content.match(/\d+/g) || []).map(Number)) {
        const ent = batch[k - 1];
        if (!ent) continue;
        const [y, s2] = ent;
        if (autoDict[y]?.[s2] !== undefined) {
          delete autoDict[y][s2];
          if (!Object.keys(autoDict[y]).length) delete autoDict[y];
          removed.push(`${s2}(${y})`);
        }
      }
    }
    localStorage.setItem('ne:lastCurateDay', today);
    if (removed.length) {
      localStorage.setItem('ne:autoDict', JSON.stringify(autoDict));
      rebuildSelfPred();
      logEvt('curate', { rm: removed });
      status(`辞書整理: ${removed.length}件を除去(${removed.slice(0, 3).join('、')}${removed.length > 3 ? '…' : ''})`);
    }
    return removed;
  } catch { return []; }
}
globalThis.__neCurate = llmCurate; // e2e 用

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
const FUNC = new Set(['は','が','を','に','で','と','の','も','へ','や','から','まで','より','だ','です','ます','ました','する','した','して','している','やる','やった','やって','いる','いた','います','ない','なかった','よう','こと','もの','ん','な','ね','よ','か','さ','わ','たち','など','って','ば','たら','なら','けど','でも','し','そう','という','ていう','られ','られる','れる','せる','たり','ながら','のだ','のか','んだ']);
function wordCands(sub) {
  const res = [];
  const u = userDict[sub];
  if (u) Object.entries(u).sort((a, b) => b[1] - a[1]).slice(0, 2).forEach(([s2]) => res.push([s2, 60]));
  const a2 = autoDict[sub];
  if (a2) Object.entries(a2).sort((x, y) => y[1] - x[1]).slice(0, 2).forEach(([s2]) => res.push([s2, 90])); // 自動登録の固有名詞
  (dict[sub] || []).slice(0, 2).forEach(([s2]) => res.push([s2, 160]));
  (baseDict[sub] || []).slice(0, 3).forEach(([s2, c]) => res.push([s2, c]));
  const seen = new Set();
  return res.filter(([s2]) => !seen.has(s2) && seen.add(s2));
}
function latticeBest(run, K = 8, ctx = '') {
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
          const pen = kind === 'k' && p.lastKind === 'k' && !FUNC.has(sub) ? 150 : 0; // 素通し連続は軽く罰(機能語の連鎖は正当なので罰しない)
          const prev = p.out ? p.out.slice(-1) : ctx; // この区間の直前文字(経路依存)
          const cb = prev && ctxDict[prev + '|' + sub]?.[surf] ? 90 : 0; // 同じ文脈で確定した表記は割引
          acc.push({ cost: p.cost + wc + 100 + pen - cb, out: p.out + surf, segs: p.segs.concat([[sub, surf]]), lastKind: kind });
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
// 変換計画(純関数: 状態を変更しない)。henkan と先読み speculation が共用する
function planConversion() {
  if (mode !== 'NONE') return null;
  const src = tut ? tut.buf : text;
  const upto = tut ? src.length : cursor;
  const tail2 = src.slice(upto - 2, upto);
  if (!tut && (tail2 === '……' || tail2 === '――')) {
    const others = tail2 === '……' ? ['――', '「」', '『』', '（）'] : ['……', '「」', '『』', '（）'];
    return { kind: 'sym', yomi: tail2, removed: tail2, list: [...others, tail2], paths: null, symSkip: 0 };
  }
  let m = (tut ? src : src.slice(committedTo, cursor)).match(/[ぁ-んー]+$/);
  let symSkip = 0;
  if (!m && !tut) {
    // 句読点の後からでも直前のかな列を変換できるように、記号列を透かす(IMEの手癖)
    const m2 = text.slice(0, cursor).match(/([ぁ-んー]+)([。、！？…―」』）]{1,6})$/);
    if (m2) { symSkip = m2[2].length; m = [m2[1]]; }
  }
  if (!m) return null;
  const run = m[0];
  let exact = null;
  for (let len = run.length; len >= 1; len--) {
    const y = run.slice(run.length - len);
    if (hasCands(y)) { exact = y; break; }
  }
  const ctxAt = (len) => (tut ? '' : src.slice(upto - symSkip - len - 1, upto - symSkip - len)); // 変換開始位置の直前1字
  const pred = symSkip ? null : predict();
  if (pred && (!exact || pred.S.length > exact.length))
    return { kind: 'word', yomi: pred.reading, removed: pred.S, list: lookup(pred.reading, ctxAt(pred.S.length)), paths: null, symSkip };
  if (exact === run)
    return { kind: 'word', yomi: run, removed: run, list: lookup(run, ctxAt(run.length)), paths: null, symSkip };
  const paths = latticeBest(run, 8, ctxAt(run.length)).filter((p) => p.segs.some(([y, s2]) => y !== s2));
  if (!paths.length) {
    if (exact) return { kind: 'word', yomi: exact, removed: exact, list: lookup(exact, ctxAt(exact.length)), paths: null, symSkip };
    return { kind: 'none', run };
  }
  const list = paths.map((p) => p.out);
  const pathArr = paths.slice();
  if (!list.includes(run)) { list.push(run); pathArr.push(null); }
  const kata = hiraToKata(run);
  if (!list.includes(kata)) { list.push(kata); pathArr.push(null); }
  return { kind: 'word', yomi: run, removed: run, list, paths: pathArr, symSkip };
}
function henkan() {
  if (mode === 'CAND') { snd.cycle(); candIdx = (candIdx + 1) % cands.length; render(); return; }
  const plan = planConversion();
  if (!plan) return;
  if (plan.kind === 'none') { snd.err(); status(`「${plan.run}」に候補なし`); return; }
  if (plan.symSkip) { // 句読点透かし: 確定後に記号の後ろへ復帰
    symJump = plan.symSkip;
    cursor -= plan.symSkip;
    committedTo = Math.min(committedTo, cursor);
  }
  if (tut) {
    tut.buf = tut.buf.slice(0, tut.buf.length - plan.removed.length);
  } else {
    text = text.slice(0, cursor - plan.removed.length) + text.slice(cursor);
    cursor -= plan.removed.length;
    committedTo = Math.min(committedTo, cursor);
  }
  reading = plan.yomi;
  convRestore = plan.removed;
  cands = plan.list; candPaths = plan.paths; candIdx = 0; mode = 'CAND';
  logEvt('conv', { y: plan.yomi, c0: cands[0] });
  // 先読みキャッシュが当たっていれば同期適用(Space の瞬間に審査済み)
  let applied = false;
  if (!tut && llmReady && llmOn && plan.kind === 'word' && cands.length > 1) {
    const list8 = cands.slice(0, Math.min(8, cands.length));
    const nums = specCache.get(specKey(plan.yomi, ctxOf(cursor), list8));
    if (Array.isArray(nums)) applied = judgeApply(nums, list8);
  }
  render();
  if (!applied && plan.kind === 'word') {
    llmSeq++;
    llmRerank(llmSeq); // 先読みが無ければ従来の非同期審査
  }
}
function confirmCand() {
  if (mode !== 'CAND') return;
  snap(true);
  const surf = cands[candIdx];
  // 「ひらがなのまま確定」(開く選択)も学習対象。開き閉じの習慣が候補順に乗る
  const chosenPath = candPaths ? candPaths[candIdx] : null;
  const learnCtx = (prev, y, s2) => { // 文脈(直前1字)と直近性も学習 → 候補順の最適化
    if (prev) { (ctxDict[prev + '|' + y] ??= {}); ctxDict[prev + '|' + y][s2] = (ctxDict[prev + '|' + y][s2] || 0) + 1; }
    lastPick[y + '|' + s2] = ++pickSeq;
  };
  let prevC = tut ? '' : text.slice(cursor - 1, cursor);
  if (chosenPath) {
    for (const [y, s2] of chosenPath.segs) {
      if (y === s2 && FUNC.has(y)) { prevC = s2.slice(-1); continue; } // 機能語の素通しは学習しない
      (userDict[y] ??= {});
      userDict[y][s2] = (userDict[y][s2] || 0) + 1;
      learnCtx(prevC, y, s2);
      prevC = s2.slice(-1);
    }
  } else {
    (userDict[reading] ??= {});
    userDict[reading][surf] = (userDict[reading][surf] || 0) + 1;
    learnCtx(prevC, reading, surf);
  }
  localStorage.setItem('ne:ctxDict', JSON.stringify(ctxDict));
  localStorage.setItem('ne:lastPick', JSON.stringify(lastPick));
  localStorage.setItem('ne:pickSeq', String(pickSeq));
  localStorage.setItem('ne:userDict', JSON.stringify(userDict));
  rebuildSelfPred(); // 確定学習を予測にも即反映
  logEvt('pick', { y: reading, s: surf, i: candIdx });
  mode = 'NONE'; reading = ''; candPaths = null;
  const jumpBack = symJump; symJump = 0; // 透かした記号の後ろへ復帰(out の後で)
  const isPair = !tut && surf.length === 2 && PAIR[surf[0]] === surf[1]; // 「」等はカーソルを中に
  const insert = isPair ? surf[0] : surf;
  if (!tut && insert !== '') {
    lastConv = { pos: cursor, len: insert.length, until: Date.now() + 1200 };
    clearTimeout(lastConvTimer);
    lastConvTimer = setTimeout(render, 1250);
  }
  out(insert);
  if (isPair) {
    closers.push(surf[1]); // 閉じも実体で即挿入(カーソルは中)
    text = text.slice(0, cursor) + surf[1] + text.slice(cursor);
  }
  if (jumpBack && !tut) { cursor += jumpBack; }
  if (!tut) committedTo = cursor; // 変換の決定=確定
  snd.conv();
}
function cancel() {
  if (mode === 'CAND') { // 打った分だけかなに戻す(予測変換なら予測前の状態へ)
    const r = convRestore || reading;
    mode = 'NONE'; reading = ''; convRestore = ''; candPaths = null;
    out(r);
    if (symJump) { cursor += symJump; committedTo = cursor; symJump = 0; }
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
      if (CYCLE[last]) {
        snap(false);
        text = text.slice(0, cursor - 1) + CYCLE[last] + text.slice(cursor);
      }
    }
  } else {
    if (!tut && PAIR[ch]) {
      out(ch);
      closers.push(PAIR[ch]); // 閉じも実体で即挿入(カーソルは中)。Enterで飛び越える
      text = text.slice(0, cursor) + PAIR[ch] + text.slice(cursor);
    } else if (!tut && closers.length && closers[closers.length - 1] === ch && text[cursor] === ch) {
      snap(false);
      closeOver(1); // 閉じ字が候補から来たら実体を飛び越える(二重挿入しない)
    } else out(ch);
  }
  if (!tut && mode === 'NONE') kickSpeculate(); // 入力中じゅう、最新の読みで裏審査が追走する
  render();
}
function backspace() {
  if (mode === 'CAND') { cancel(); return; } // 候補をやめてかなに戻す
  if (tut) { tutBackspace(); return; }
  if (cursor === 0) return;
  snap(false);
  followCaret = true;
  const lastCh = text.slice(cursor - 1, cursor);
  if (PAIR[lastCh] && closers[closers.length - 1] === PAIR[lastCh] && text[cursor] === PAIR[lastCh]) {
    closers.pop();
    text = text.slice(0, cursor) + text.slice(cursor + 1); // 実体の閉じも道連れ
  }
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
function flipSpread(d) {
  const cur = viewSpread < 0 ? totalSpreads - 1 : viewSpread;
  const v = cur + d;
  viewSpread = v >= totalSpreads - 1 ? -1 : Math.max(0, v);
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
  if (e.target && (e.target.id === 'memo' || e.target.tagName === 'TEXTAREA')) return; // メモ欄はOSに任せる(チェーン対象外の私的ノート)
  const code = e.code;
  if (VOICE_UI && code === 'MetaLeft' && !e.repeat && !rec && !tut) { micToggle(true); return; } // 左Cmd長押し=プッシュトゥトーク(休眠中)
  if (code === 'Escape' && calib) { calib = null; render(); status('声合わせを終了しました'); return; }
  if (rec && rec._ptt && code !== 'MetaLeft') rec._cancel = true; // 他キーが来た=ショートカットだった→破棄
  if (!e.repeat || code === 'Backspace')
    logEvt('k', { c: code, s: e.shiftKey ? 1 : 0, m: tut ? 't' : tategaki ? 'v' : 'h', ...(e.repeat ? { r: 1 } : {}) });
  if (code === 'ShiftLeft' || code === 'ShiftRight') {
    if (typeof document.body?.classList?.toggle === 'function') document.body.classList.toggle('shift-held', true);
  }
  document.querySelectorAll(`[data-code="${code}"]`).forEach((k) => k.classList.add('hit'));
  statusKey(code);

  if (code === 'BracketLeft' && !tut && !e.metaKey && !e.ctrlKey) { e.preventDefault(); if (!e.repeat) abcToggle(); return; } // @(Pの隣)=ABCトグル

  if (overview) { // 俯瞰中は閲覧専用
    if (code === 'Escape') { e.preventDefault(); toggleOverview(); }
    return;
  }

  // ABCモード: 刻印どおりの半角英数を素通し(英数/Escでかなへ戻る)
  if (abcMode && !tut && !e.metaKey && !e.ctrlKey) {
    if (code === 'Lang2' || code === 'NonConvert' || code === 'Escape') {
      e.preventDefault(); abcToggle(); return;
    }
    if (code === 'Backspace') { e.preventDefault(); backspace(); render(); return; }
    if (code === 'Enter') { e.preventDefault(); if (!e.repeat) { out('\n'); render(); } return; }
    if (typeof e.key === 'string' && e.key.length === 1 && e.key.charCodeAt(0) >= 0x20 && e.key.charCodeAt(0) < 0x7f) {
      e.preventDefault();
      if (e.repeat) return;
      snap(false);
      followCaret = true;
      text = text.slice(0, cursor) + e.key + text.slice(cursor); // 作法エンジンは通さない(生のまま)
      cursor++; committedTo = cursor;
      render(); return;
    }
    if (plainMap[code] !== undefined || chordMap[code] !== undefined) { e.preventDefault(); return; } // かな発火を抑止
  }

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
    if (mode !== 'CAND' && !tut && (code === 'Lang2' || code === 'NonConvert')) { // 候補が無いときの英数=ABCモード入り
      abcToggle(); return;
    }
    cancel(); return;
  }
  if (e.metaKey || e.ctrlKey) {
    if (code === 'KeyS') { e.preventDefault(); save(); }
    else if (code === 'KeyV') {
      e.preventDefault();
      if (eClipboard) pasteText(eClipboard.readText());
      else navigator.clipboard?.readText().then(pasteText);
    } else if (code === 'KeyC') { e.preventDefault(); copyAll(); }
    else if (code === 'KeyZ') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
    else if (code === 'KeyF') {
      e.preventDefault();
      const q = typeof window !== 'undefined' && window.prompt ? window.prompt('検索:', lastQuery) : null;
      if (q) findNext(q);
    } else if (code === 'KeyG') { e.preventDefault(); findNext(lastQuery); }
    return;
  }
  if (code === 'Escape' && tut) { stopTut(); return; }
  if (!tut && (code === 'ArrowLeft' || code === 'ArrowRight')) {
    e.preventDefault();
    moveCursor(cursor + (code === 'ArrowLeft' ? -1 : 1));
    return;
  }
  if (code === 'PageUp' || code === 'PageDown') {
    e.preventDefault();
    if (tategaki) flipSpread(code === 'PageUp' ? -1 : 1);
    else {
      followCaret = false;
      const el2 = document.getElementById('text');
      el2.scrollTop += (code === 'PageUp' ? -1 : 1) * el2.clientHeight * 0.85;
    }
    return;
  }

  const fnDigit = code.match(/^F([1-9]|10)$/); // 数字はファンクションキー(F1〜F9=1〜9、F10=0)。全角で出す
  if (fnDigit) {
    e.preventDefault();
    if (e.repeat) return;
    if (mode === 'CAND') confirmCand();
    out('１２３４５６７８９０'[Number(fnDigit[1]) - 1]);
    render(); return;
  }
  if (HIRAKU_CODES.includes(code)) { // ：=表記を開く。押すたび すべてカタカナ⇄すべてひらがな。候補表示中からも戻せる
    e.preventDefault();
    if (e.repeat) return;
    if (mode === 'CAND') {
      const kata = hiraToKata(reading);
      if (cands.length === 2 && cands[0] === kata && cands[1] === reading) {
        candIdx = (candIdx + 1) % 2; // 2押し目以降は カタカナ⇄ひらがな の循環
      } else {
        cands = [kata, reading]; candPaths = null; candIdx = 0; // 漢字候補から表記を開いて戻す
        logEvt('conv', { y: reading, c0: kata, open: 1 });
      }
      snd.cycle(); render(); return;
    }
    if (mode !== 'NONE') return;
    const src = tut ? tut.buf : text;
    const m = (tut ? src : src.slice(committedTo, cursor)).match(/[ぁ-んー]+$/);
    if (!m) return;
    const run = m[0], kata = hiraToKata(run);
    if (tut) { tut.buf = src.slice(0, src.length - run.length) + kata; tutCheck(); render(); return; }
    // 通常時はカタカナ→ひらがなの2候補でCANDへ(もう一押しで戻せる。決定は次のかな/Enter)
    text = text.slice(0, cursor - run.length) + text.slice(cursor);
    cursor -= run.length;
    committedTo = Math.min(committedTo, cursor);
    reading = run; convRestore = run;
    cands = [kata, run]; candPaths = null; candIdx = 0; mode = 'CAND';
    logEvt('conv', { y: run, c0: kata, open: 1 });
    render(); return;
  }
  if (code === 'Tab') { // 予測をひらがなのまま受け入れる(青字のままなので続けて変換も可)
    e.preventDefault();
    if (!tut && mode === 'NONE') {
      const pr = predict();
      if (pr) { logEvt('tab', { g: pr.ghost }); out(pr.ghost); render(); }
    }
    return;
  }
  if (code === 'Backspace') { e.preventDefault(); backspace(); return; }
  if (code === 'Enter') {
    e.preventDefault();
    if (e.repeat) return; // キーリピートで「決定+改行」が連発するのを防ぐ
    if (mode === 'CAND') {
      confirmCand();
      render(); return; // Enter=変換の決定(改行しない)
    }
    if (tut) { tut.errors++; loadDrill(); return; } // Enter=この問をスキップ
    if (cursor > committedTo || closers.length) { // 未確定かな確定+閉じの外へ。改行はしない
      snap(false);
      closeOver(closers.length);
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
function abcToggle() {
  abcMode = !abcMode;
  if (abcMode) committedTo = cursor;
  status(abcMode ? 'ABC入力(@キーで戻る)' : 'かな入力に戻りました');
  render();
}
function onKeyup(e) {
  if (e.target && (e.target.id === 'memo' || e.target.tagName === 'TEXTAREA')) return;
  if ((e.code === 'ShiftLeft' || e.code === 'ShiftRight') && typeof document.body?.classList?.toggle === 'function')
    document.body.classList.toggle('shift-held', !!e.shiftKey); // 離したら単打面へ(もう片方のShiftが押されていれば維持)
  if (e.code === 'MetaLeft' && rec && rec._ptt) rec.stop(); // 左Cmdを離す→書き起こしへ
  document.querySelectorAll(`[data-code="${e.code}"]`).forEach((k) => k.classList.remove('hit'));
}

// ---- 縦書きレイアウト(電撃文庫仕様: 42字×17行・見開き・ぶら下がり・禁則) ----
const LINE_LEN = 42, PAGE_LINES = 17;
const HANG = new Set([...'。、']); // 句読点だけ43字目にぶら下げ(電撃式)
// 行頭に置けない字(JIS X 4051系): 閉じ類・小書き(ひら+カタ)・長音・リーダー・ダッシュ・繰返し記号など
const KINSOKU_HEAD = new Set([...'」』）〕》〉】！？!?…―ーゃゅょっゎぁぃぅぇぉャュョッヮァィゥェォヵヶ々ゝゞヽヾ・：；', '！？', '！！', '？？', '？！']);
const KINSOKU_TAIL = new Set([...'「『（〔《〈【']); // 行末に置けない→次行へ送る
function layoutLines(tokens) {
  // ！？/！！等の連続2つは縦中横で1マスに(電撃式)。本文データは2字のまま、表示だけ併合
  for (let k = 0; k < tokens.length - 1; k++) {
    const a = tokens[k];
    if (!a || a.caret || !'！？'.includes(a.c)) continue;
    let m = k + 1;
    while (m < tokens.length && tokens[m].caret) m++; // キャレットは挟んでよい(間にカーソルが居る時は併合しない方が自然だが、位置情報を保つため不可視のまま許す)
    const b = tokens[m];
    if (!b || !'！？'.includes(b.c) || a.cls !== b.cls || m !== k + 1) continue;
    a.c = a.c + b.c;
    a.cls = (a.cls ? a.cls + ' ' : '') + 'tcy';
    tokens.splice(m, 1);
  }
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
      const popReal = (carry) => { // 末尾の実文字1個(随伴キャレット込み)を次行へ
        while (cur.length) { const x = cur.pop(); carry.unshift(x); if (!x.caret) { count--; break; } }
      };
      // 次に続く「行頭に置けない連なり」(クラスタ)を実文字で最大3つ覗く
      const run = [];
      let j = i;
      for (let step = 0; step < 3; step++) {
        let k = j + 1;
        while (k < tokens.length && tokens[k].caret) k++;
        const t2 = tokens[k];
        if (!t2 || t2.c === '\n' || !(HANG.has(t2.c) || KINSOKU_HEAD.has(t2.c))) break;
        run.push(t2.c);
        j = k;
      }
      let carry = [];
      if (run.length && run.every((c) => HANG.has(c)) && run.length <= 2) {
        for (let k = i + 1; k <= j; k++) cur.push(tokens[k]); // 純句読点クラスタは43字目以降にぶら下げ
        i = j;
      } else if (run.length) {
        // 追い出し: 露出した行頭が安全な字になるまで前の字ごと次行へ(……の分割禁止もここで満たされる)
        let guard = 0;
        do { popReal(carry); guard++; }
        while (guard < 4 && count > 0 && carry.length && (KINSOKU_HEAD.has(carry.find((x) => !x.caret)?.c) || HANG.has(carry.find((x) => !x.caret)?.c)));
      }
      let guard2 = 0;
      while (guard2++ < 3 && KINSOKU_TAIL.has(realLast()?.c)) popReal(carry); // 開き括弧の連なりも行末に残さない
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
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
  if (typeof document.body?.classList?.toggle === 'function') {
    document.body.classList.toggle('with-chart', showChart); // 縦書きのページサイズ計算に反映
    document.body.classList.toggle('abc', abcMode); // ABCモードの可視化(盤がアルファベット表示+本文に色)
  }
  const el = document.getElementById('text');
  if (tut) { renderTut(el); return; }
  if (calib) {
    el.classList.add('tut');
    const [orig] = calib.items[calib.idx];
    el.innerHTML = `
    <div class="drill">
      <div class="stagename">声合わせ ${calib.idx + 1}/${calib.items.length} — 左Cmdを押しながら音読、離すと次へ(Esc=終了)</div>
      <div class="target${orig.length > 12 ? ' long' : ''}"><span class="rest">${esc(orig)}</span></div>
      <div class="stats">whisperの聞き間違いを採取して、かな化補正の正解例にします</div>
    </div>`;
    return;
  }
  el.classList.remove('tut');
  if (typeof document.body?.classList?.toggle === 'function') document.body.classList.toggle('ov-full', !!(overview && ovData));
  if (overview && ovData) { renderOverview(el); return; }
  el.classList.remove('ov');
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
    escNL(text.slice(cursor)) +
    '<div id="curline"></div>';
  // タイプライタースクロール: 入力中は中央固定、手動スクロール中は追従しない
  const caretEl = el.querySelector('.caret');
  if (caretEl && typeof caretEl.offsetTop === 'number') {
    if (followCaret) {
      progScroll = true;
      el.scrollTop = Math.max(0, caretEl.offsetTop - el.clientHeight * 0.5);
      setTimeout(() => { progScroll = false; }, 0);
    }
    const cl = el.querySelector('#curline');
    if (cl) cl.style.top = caretEl.offsetTop - 6 + 'px';
  }
  document.getElementById('mode').textContent =
    abcMode ? 'A' : mode === 'NONE' ? '─' : '▼';
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
  el.innerHTML =
    `<div class="tatewrap"><div class="spread">${pageHtml(pages[si * 2], si * 2 + 1)}${pageHtml(pages[si * 2 + 1], si * 2 + 2)}</div>` +
    `<input type="range" id="pgbar" min="1" max="${totalSpreads}" value="${si + 1}" title="見開き ${si + 1}/${totalSpreads}"></div>`;
  const pb = el.querySelector('#pgbar');
  if (pb) pb.oninput = (ev) => {
    const v = Number(ev.target.value);
    viewSpread = v >= totalSpreads ? -1 : v - 1;
    render();
  };
  document.getElementById('mode').textContent = abcMode ? 'A' : mode === 'NONE' ? '─' : '▼';
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
  let html = '<div class="krow numrow">';
  for (const label of '1234567890') {
    const ch = charAt(layout.slots, label);
    html += ch
      ? `<div class="key" data-code="Digit${label}"><span class="${cls(ch, 'kana')}">${ch}</span><span class="label">${label}</span></div>`
      : '<div class="key spacer"></div>';
  }
  html += '</div>';
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
    if (r === 0) html += '<div class="key fnkey" data-code="BracketLeft"><span class="kana">@</span><span class="label">ABC</span></div>'; // Pの隣=ABCトグル
    if (r === 1) html += '<div class="key fnkey" data-code="Quote"><span class="kana">：</span><span class="label">開く</span></div>'; // ;の隣=表記を開く
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
  // チェーン先頭の復元(localStorage 消失への保険)と FNV→SHA-256 移行
  if (ipc && logHash === '0') {
    try {
      const h = await ipc.invoke('read-file', { name: 'chainhead.txt' });
      if (h && /^[0-9a-f]{8,64}$/.test(h.trim())) {
        logHash = h.trim();
        localStorage.setItem('ne:logHash', logHash);
      }
    } catch {}
  }
  if (logHash !== '0' && logHash.length < 64) logEvt('rehash', { old: logHash }); // 旧FNVチェーンを新チェーンに巻き込む
  // 配列とエンジンの版をチェーンに固定(リプレイ時にどの版で導出すべきかを確定させる)
  let engineSha = null;
  try { engineSha = sha256hex(await (await fetch('./editor.js')).text()); } catch {}
  logEvt('boot', { layout: sha256hex(JSON.stringify(layout)), engine: engineSha });
  buildCharts(layout);
  if (!curDir && localStorage.getItem('ne:curFile')) { // 旧・単一ファイル正本からの移行: 親フォルダを作品にする
    const old = localStorage.getItem('ne:curFile');
    curDir = old.split('/').slice(0, -1).join('/');
    curName = old.split('/').pop();
    localStorage.removeItem('ne:curFile');
  }
  await initFileMode();
  document.addEventListener('keydown', onKeydown);
  document.addEventListener('keyup', onKeyup);
  // クリックでカーソル移動(ドラッグ選択は妨げない)。右クリック=選択語の辞書登録
  document.getElementById('text').addEventListener?.('click', (ev) => {
    if (tut || ev.button !== 0) return;
    if (typeof window !== 'undefined' && !window.getSelection?.().isCollapsed) return; // 選択中は移動しない
    const p = clickOffset(ev);
    if (p == null || p === cursor) return;
    ev.preventDefault();
    if (!window.confirm('カーソルをここに移動して書きますか?')) return;
    moveCursor(p);
    const midLine = cursor > 0 && text[cursor - 1] !== '\n' && cursor < text.length && text[cursor] !== '\n';
    if (midLine && window.confirm('改行を入れてから書きますか?')) { logEvt('ins', { s: '\n' }); out('\n'); }
    render();
  });
  document.getElementById('text').addEventListener?.('contextmenu', (ev) => {
    if (tut) return;
    const surf = (typeof window !== 'undefined' ? window.getSelection?.().toString() : '').trim();
    if (!surf || surf.length > 20 || surf.includes('\n')) return;
    ev.preventDefault();
    const yomi = window.prompt(`「${surf}」の読み(ひらがな):`);
    if (!yomi) return;
    if (!/^[ぁ-んー]+$/.test(yomi.trim())) { status('読みはひらがなで入力してください'); return; }
    registerWord(surf, yomi.trim(), clickOffset(ev) ?? -1);
  });
  // システムIMEがONだと打鍵がOSに横取りされる → 検知して警告
  document.addEventListener('compositionstart', (ev) => {
    if (ev.target && (ev.target.id === 'memo' || ev.target.tagName === 'TEXTAREA')) return; // メモ欄はOSのIMEで書く場所
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
  document.getElementById('cert').onclick = issueCertificate;
  const micBtn = document.getElementById('mic');
  const calBtn = document.getElementById('vcal');
  const micSel2 = document.getElementById('micsel');
  if (!VOICE_UI) { // 音声UIは休眠中
    for (const b of [micBtn, calBtn, micSel2]) if (b && b.style) b.style.display = 'none';
  } else {
    if (micBtn) micBtn.onclick = () => micToggle(false);
    if (calBtn) calBtn.onclick = startCalib;
  }
  const micSel = document.getElementById('micsel');
  if (micSel) micSel.onchange = (ev) => { localStorage.setItem('ne:micId', ev.target.value); status('マイクを切り替えました'); };
  populateMics();
  if (typeof navigator !== 'undefined' && navigator.mediaDevices)
    navigator.mediaDevices.ondevicechange = populateMics;
  const docSel = document.getElementById('doc');
  const nd = document.getElementById('newdoc');
  if (ipc) { // フォルダ=作品が正本: セレクタ=話リスト、＋=新しい話、開く=フォルダ選択
    const rn2 = document.getElementById('renamedoc');
    if (rn2 && rn2.style) rn2.style.display = 'none'; // 改名はOSのファイル名変更で
    const nb = document.getElementById('newfile');
    if (nb && nb.style) nb.style.display = 'none'; // 新規は＋(新しい話)に統合
    const ob = document.getElementById('openfile');
    if (ob) ob.onclick = openWork;
    if (nd) nd.onclick = newEpisode;
    if (docSel) docSel.onchange = (ev) => openEpisode(ev.target.value);
    const fb = document.getElementById('filename');
    if (fb) fb.textContent = curDir ? curDir.split('/').pop() : '(開くで作品フォルダを選ぶ)';
  } else {
    const ob = document.getElementById('openfile');
    const nb = document.getElementById('newfile');
    if (ob && ob.style) ob.style.display = 'none';
    if (nb && nb.style) nb.style.display = 'none';
    refreshDocSel();
    if (docSel) docSel.onchange = (ev) => switchDoc(ev.target.value);
    if (nd) nd.onclick = newDoc;
  }
  const rn = document.getElementById('renamedoc');
  if (rn) rn.onclick = renameDoc;
  const mb = document.getElementById('memobtn');
  if (mb) mb.onclick = toggleMemo;
  const ov = document.getElementById('ovbtn');
  if (ov) ov.onclick = toggleOverview;
  document.getElementById('text').addEventListener?.('click', (ev) => {
    if (!overview) return;
    const card = ev.target.closest?.('.ovcard');
    if (card && card.dataset?.ep) { const ep = card.dataset.ep; overview = false; ovData = null; openEpisode(ep); }
  });
  const tocEl = document.getElementById('toc');
  if (tocEl && tocEl.addEventListener) tocEl.addEventListener('click', (ev) => {
    const ep = ev.target.closest?.('.ep');
    if (ep && ep.dataset?.ep) openEpisode(ep.dataset.ep);
  });
  const ta = document.getElementById('memo');
  if (ta && ta.addEventListener) ta.addEventListener('input', saveMemoSoon);
  if (memoOpen) {
    if (typeof document.body?.classList?.toggle === 'function') document.body.classList.toggle('with-memo', true);
    loadMemo();
  }
  const textEl = document.getElementById('text');
  textEl.addEventListener?.('scroll', () => { if (!progScroll && !tategaki) followCaret = false; });
  textEl.addEventListener?.('wheel', (ev) => {
    if (!tategaki) return;
    wheelAcc += ev.deltaY;
    if (Math.abs(wheelAcc) > 80) { flipSpread(wheelAcc > 0 ? 1 : -1); wheelAcc = 0; }
  }, { passive: true });
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
  setTimeout(() => llmCurate(false), 40000); // 起動後に1日1回の辞書棚卸し
  setInterval(flushLog, 30000); // 打鍵ログの書き出し
  setTimeout(() => anchorNow(false), 20000); // 起動後に当日分の公証
  setInterval(() => anchorNow(false), 3600000); // 1時間ごとに「今日まだなら」公証
  if (typeof window !== 'undefined')
    window.addEventListener('beforeunload', () => { if (text !== (manuscript.content || '')) save(); });
  render();
  status(`自分辞書 ${Object.keys(dict).length} 語 + 基底 ${Object.keys(baseDict).length} 語 / ドリル ${drills.lines.length} 文 / 履歴 ${manuscript.totalHistory} 版`);
}
main();
