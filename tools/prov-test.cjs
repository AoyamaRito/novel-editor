// 真正性コア(prov.cjs)の不変条件テスト。electron 不要・単独実行(node tools/prov-test.cjs)。
// これが落ちたら「人が書いた」証明の write 側の保証が壊れている = CI を赤にする。
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeProvenance, verifyChain, isChainFile, sha } = require('../prov.cjs');

let n = 0;
const ok = (m) => { console.log('  ✔', m); n++; };

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-'));
const P = makeProvenance(dir);

// 1. append が正本チェーンを伸ばし、renderer 由来の p/rt を破棄して main が受信時刻を刻む
const r1 = P.append([{ t: 1, e: 'k', c: 'KeyA', p: 'FORGED' }, { t: 2, e: 'k', c: 'Backspace', u: 1, p: 'FORGED2' }], 1000);
assert(r1.n === 2 && /^[0-9a-f]{64}$/.test(r1.head), 'append が正本 head を返す');
const log1 = fs.readFileSync(P.logPath, 'utf8');
const v1 = verifyChain(log1);
assert(v1.ok && v1.head === r1.head, 'チェーンが検証一致(main 所有)');
const first = JSON.parse(log1.split('\n').filter(Boolean)[0]);
assert(first.p === '0' && first.rt === 1000 && first.c === 'KeyA', 'renderer 由来の p/rt は破棄され main が受信時刻 rt を刻む');
assert(!log1.includes('FORGED'), 'renderer が主張したハッシュは記録されない=偽造不能');
ok('append=正本チェーン / renderer由来p破棄 / 受信時刻刻印 / 偽造不能');

// 2. 再ロード(再起動)で head を継続
const P2 = makeProvenance(dir);
assert(P2.getHead() === r1.head, '再起動後も head を継続(chainhead/log から復元)');
P2.append([{ e: 'state', sha: 'x', len: 3, d: 'novel:t' }], 2000);
assert(verifyChain(fs.readFileSync(P.logPath, 'utf8')).ok, '追記後もチェーン整合');
ok('再ロード継続 / 追記整合');

// 3. 改ざん検出(append-only の核)
const lines = fs.readFileSync(P.logPath, 'utf8').split('\n').filter(Boolean);
lines[0] = lines[0].replace('KeyA', 'KeyZ');
assert(verifyChain(lines.join('\n')).ok === false, '中間行の改ざんを検出');
ok('改ざん検出');

// 4. 裏口封じ(log.jsonl/chainhead.txt は prov-append のみ)
assert(isChainFile('log.jsonl') && isChainFile('chainhead.txt'), 'チェーンファイルは保護対象');
assert(!isChainFile('doc.txt') && !isChainFile('anchors.jsonl'), '他ファイルは通常書き込み可');
ok('isChainFile=直接書き込みの裏口封じ');

// 5. SHA-256 が独立検証ツール court-verify.html と同一(独立検証の成立条件)
const html = fs.readFileSync(path.join(__dirname, '..', 'court-verify.html'), 'utf8');
const js = html.slice(html.indexOf('const SHA_K='), html.indexOf('// ===== ファイル読み込み'));
const verifierSha = new Function(js + '; return sha256hex;')();
assert(verifierSha('abc') === sha('abc') && verifierSha('こんにちは世界') === sha('こんにちは世界'), 'court-verify.html の SHA が prov.cjs と一致');
ok('独立検証ツールと SHA 一致(第三者の独立検証が成立)');

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\nprov 不変条件 ${n} 件 全通過`);
process.exit(0);
