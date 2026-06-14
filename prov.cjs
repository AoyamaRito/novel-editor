// prov.cjs — 真正性コア(Trusted Computing Base)
// ============================================================
// 「人がAIなしで書いた」証明の write 側の核。electron に依存しない純粋なロジックなので、
// 単独でテスト・監査・凍結できる。main.cjs はこれを require して IPC に配線するだけ。
//
// 不変条件(これが崩れたら証明が崩れる。tools/prov-test.mjs が CI で検査):
//   1. 打鍵チェーンの正本は append() だけが伸ばす(renderer はハッシュを計算しない=偽造不能)
//   2. main が受信時刻 rt を刻む(renderer の主張する時刻・ハッシュは破棄)
//   3. log.jsonl / chainhead.txt への直接書き込みは禁止(isChainFile で弾く=裏口封じ)
//   4. 各行は前行の SHA-256 を含む append-only(改ざんは再計算で検出可能)
//   5. SHA-256 は editor.js / court-verify.html と同一(独立検証が成立する)
// ============================================================
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CHAIN_FILES = new Set(['log.jsonl', 'chainhead.txt']);
const isChainFile = (name) => CHAIN_FILES.has(name);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

// dir を注入(main は app.getPath、テストは一時ディレクトリ)。electron 非依存。
function makeProvenance(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const logPath = path.join(dir, 'log.jsonl');
  const headPath = path.join(dir, 'chainhead.txt');
  let head = null;

  function getHead() {
    if (head !== null) return head;
    try { if (fs.existsSync(headPath)) { head = (fs.readFileSync(headPath, 'utf8').trim() || '0'); return head; } } catch {}
    head = '0';
    try { if (fs.existsSync(logPath)) for (const line of fs.readFileSync(logPath, 'utf8').split('\n')) { if (line) head = sha(head + line); } } catch {}
    return head;
  }

  // 生イベント配列を受け、main の受信時刻 rt を刻み、自分でチェーンを伸ばして追記する。
  // renderer 由来の p（ハッシュ）と rt は破棄する＝正本は main が決める。now はテスト用に注入可。
  function append(events, now) {
    if (!Array.isArray(events) || !events.length) return { head: getHead(), n: 0 };
    let h = getHead();
    const rt = now == null ? Date.now() : now;
    const out = [];
    for (const ev of events) {
      const { p, rt: _rt, ...rest } = ev;
      const body = JSON.stringify({ ...rest, rt, p: h });
      h = sha(h + body);
      out.push(body);
    }
    fs.appendFileSync(logPath, out.join('\n') + '\n', 'utf8');
    head = h;
    try { fs.writeFileSync(headPath, h, 'utf8'); } catch {}
    return { head: h, n: out.length };
  }

  return { append, getHead, logPath, headPath };
}

// チェーン検証(court-verify.html と同じロジック。テスト・独立検証で共有)。
function verifyChain(logText) {
  const lines = (logText || '').split('\n').filter(Boolean);
  if (!lines.length) return { ok: false, broken: 0, head: '0', n: 0 };
  let head; try { head = JSON.parse(lines[0]).p ?? '0'; } catch { return { ok: false, broken: 0, head: '0', n: lines.length }; }
  let broken = -1;
  for (let i = 0; i < lines.length; i++) {
    let e; try { e = JSON.parse(lines[i]); } catch { broken = i; break; }
    if (e.p !== head) { broken = i; break; }
    head = sha(head + lines[i]);
  }
  return { ok: broken < 0, broken, head, n: lines.length };
}

module.exports = { makeProvenance, verifyChain, sha, isChainFile, CHAIN_FILES };
