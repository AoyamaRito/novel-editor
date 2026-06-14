// partial constraint の効果測定: モデルが「自分の誤りを認識して abstain(自由に委ねる)」と
// 破壊がどれだけ減るか。q=校正度(誤り位置のうち abstain できる割合)。q=0 は exact(全pin=destructive)。
// 各内部位置 p: gold判定を確率(1-a)で反転=誤り。誤り位置は確率 q で abstain(pinしない)、
// それ以外は(誤った)ラベルで pin(cut→force / nocut→forbid)。残り=自由ラティス。
// usage: node tools/eval-wakachi-partial.mjs   env: K=300 MAXDEEP=8000 SEED=12345
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const EVAL = process.argv[2] || '/tmp/ne-eval.json';
const K = +(process.env.K || 300);
const MAXDEEP = +(process.env.MAXDEEP || 8000);
let SEED0 = +(process.env.SEED || 12345);
let SEED = SEED0;
const rng = () => { SEED |= 0; SEED = (SEED + 0x6D2B79F5) | 0; let t = Math.imul(SEED ^ (SEED >>> 15), 1 | SEED); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

const realST = setTimeout;
const sleep = (ms) => new Promise((r) => realST(r, ms));
class FakeEl { constructor(id){this.id=id;this.innerHTML='';this.textContent='';this.value='';this.classList={add(){},remove(){}};this.scrollTop=0;} get scrollHeight(){return 0;} querySelector(){return new FakeEl('q');} querySelectorAll(){return [];} }
const els={}; const el=(id)=>(els[id]??=new FakeEl(id));
globalThis.document={getElementById:el,querySelector:()=>new FakeEl('q'),querySelectorAll:()=>[],createElement:()=>new FakeEl('a'),addEventListener:()=>{}};
globalThis.localStorage={_m:{},getItem(k){return this._m[k]??null;},setItem(k,v){this._m[k]=String(v);}};
globalThis.localStorage.setItem('ne:llm','off');
globalThis.setInterval=()=>0; globalThis.setTimeout=()=>0;
globalThis.URL={createObjectURL:()=>''}; globalThis.Blob=class{};
globalThis.fetch=async(p)=>{ const u=String(p).replace('./',''); const fp=path.join(ROOT,u); return { json: async()=>JSON.parse(fs.readFileSync(fp,'utf8')) }; };

await import('../editor.js');
let ready=false;
for(let i=0;i<200;i++){ await sleep(50); const pl=globalThis.__neConv('こくはく'); if(pl&&pl.list&&pl.list.includes('告白')){ready=true;break;} }
if(!ready){ console.error('辞書ロード待ちタイムアウト'); process.exit(1); }

const conv = globalThis.__neConv;
const lat  = globalThis.__neLat;
const setW = globalThis.__neSetWakachi;
const cases = JSON.parse(fs.readFileSync(EVAL,'utf8'));
const cutsArr = (segs) => { const a=[]; let s=0; for(const [y] of segs){ s+=[...y].length; a.push(s); } return a; };
const pct=(x,y)=>(100*x/y).toFixed(2)+'%';

setW(null);
let n=0, baseHit=0;
const CAP = Math.floor(MAXDEEP/2);
const missEst = Math.max(1, Math.round(cases.length*0.3116)), hitEst = cases.length-missEst;
const mStride = Math.max(1, Math.floor(missEst/CAP)), hStride = Math.max(1, Math.floor(hitEst/CAP));
let miss=0, mSeen=0, hSeen=0;
const missSamp=[], hitSamp=[];
for(const c of cases){
  n++;
  const t0 = ((conv(c.yomi,c.ctx)||{}).list||[])[0];
  const hit = t0===c.expect; if(!hit) miss++; if(hit) baseHit++;
  const want = hit ? (hSeen++%hStride===0 && hitSamp.length<CAP) : (mSeen++%mStride===0 && missSamp.length<CAP);
  if(!want) continue;
  const deep = lat(c.yomi, c.ctx, K);
  const gold = deep.find(p=>p.out===c.expect); if(!gold) continue;
  (hit?hitSamp:missSamp).push({ yomi:c.yomi, ctx:c.ctx, expect:c.expect, inner:new Set(cutsArr(gold.segs).slice(0,-1)), len:[...c.yomi].length });
}
const baseTop1=baseHit/n, missRate=miss/n, hitRate=baseHit/n;
console.log(`baseline top1=${pct(baseHit,n)}  missサンプル=${missSamp.length} hitサンプル=${hitSamp.length}\n`);

// a=境界精度, q=校正度(誤りをabstainできる割合)。{force,forbid} を作る。
function partialCon(s, a, q){
  const force=[], forbid=[];
  for(let p=1;p<s.len;p++){
    const goldCut = s.inner.has(p);
    const err = rng() > a;
    if(err && rng() < q) continue;       // 自分の誤りを認識して abstain(自由に委ねる)
    const cut = err ? !goldCut : goldCut; // pin するラベル(誤りならgold反転)
    (cut?force:forbid).push(p);
  }
  return { force, forbid };
}
const measure = (samp, a, q, isHit) => {
  let ok=0;
  for(const s of samp){
    setW((run)=> run===s.yomi ? partialCon(s, a, q) : null);
    const t = ((conv(s.yomi,s.ctx)||{}).list||[])[0];
    if(t===s.expect) ok++;
  }
  setW(null);
  return ok/samp.length;
};
const netAt = (a,q) => {
  SEED=SEED0; const fix=measure(missSamp,a,q,false);
  SEED=SEED0; const keep=measure(hitSamp,a,q,true);
  return { fix, brk:1-keep, net: hitRate*keep+missRate*fix };
};

for(const a of [0.96, 0.93, 0.90, 0.85]){
  console.log(`== 境界精度 a=${a.toFixed(2)} ==   (q=校正度: 誤りをabstainできる割合)`);
  console.log(`   q   | 直せる | 壊れる |  NET   | 純利得`);
  for(const q of [0.0, 0.5, 0.8, 0.95, 1.0]){
    const r = netAt(a,q);
    const tag = q===0?'exact':'';
    console.log(`  ${q.toFixed(2)} | ${(100*r.fix).toFixed(1).padStart(4)}% | ${(100*r.brk).toFixed(1).padStart(4)}% | ${(100*r.net).toFixed(2)}% | ${r.net>=baseTop1?'+':''}${(100*(r.net-baseTop1)).toFixed(2)}pt ${tag}`);
  }
  console.log('');
}
console.log(`baseline=${pct(baseHit,n)}。q=0は exact(全pin=destructive)。校正(q↑)で破壊が減り、低精度でも純利得が正に戻るかを見る。`);
