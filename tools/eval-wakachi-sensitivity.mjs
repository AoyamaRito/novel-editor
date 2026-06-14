// わかち感度曲線: 境界分類器が「精度 a」のとき top1 がどこまで上がるかを測る。
// gold cuts の各内部境界判定を確率 (1-a) で反転(=分類器の誤りを独立模擬)し、provider 経由で実 FIXED を測定。
// 出力: a ごとの FIXED率 と 実 top1。in-browser tiny 境界分類器が狙うべき精度を逆算するための曲線。
// usage: node tools/eval-wakachi-sensitivity.mjs   env: K=300 MAXDEEP=6000 SEED=12345
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const EVAL = process.argv[2] || '/tmp/ne-eval.json';
const K = +(process.env.K || 300);
const MAXDEEP = +(process.env.MAXDEEP || 6000);
let SEED = +(process.env.SEED || 12345);
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
const pct=(a,b)=>(100*a/b).toFixed(2)+'%';

// 1パス: baseline と、サンプルミスの gold cuts を収集
setW(null);
let n=0, baseHit=0;
const CAP = Math.floor(MAXDEEP/2); // miss/hit 各サンプル上限
const missEst = Math.max(1, Math.round(cases.length*0.3116));
const hitEst  = Math.max(1, cases.length - missEst);
const missStride = Math.max(1, Math.floor(missEst/CAP));
const hitStride  = Math.max(1, Math.floor(hitEst/CAP));
let miss=0, missSeen=0, hitSeen=0;
const missSamp=[]; // 現状ミス: 直せるか(upside)
const hitSamp=[];  // 現状正解: 壊れるか(downside)
for(const c of cases){
  n++;
  const t0 = ((conv(c.yomi,c.ctx)||{}).list||[])[0];
  const hit = t0===c.expect;
  if(!hit) miss++;
  // gold cuts(=expect を生む経路の区切り)を自由ラティスから取得
  const want = hit ? (hitSeen++%hitStride===0 && hitSamp.length<CAP)
                   : (missSeen++%missStride===0 && missSamp.length<CAP);
  if(hit) baseHit += 1;
  if(!want) continue;
  const deep = lat(c.yomi, c.ctx, K);
  const gold = deep.find(p=>p.out===c.expect);
  if(!gold) continue;
  const margin = deep.length>1 ? (deep[1].cost - deep[0].cost) : 1e9; // 自由ラティスの top1/top2 コスト差=確信度
  const rec = { yomi:c.yomi, ctx:c.ctx, expect:c.expect, gc:cutsArr(gold.segs), len:[...c.yomi].length, margin };
  (hit ? hitSamp : missSamp).push(rec);
}
const baseTop1 = baseHit/n, missRate = miss/n, hitRate = baseHit/n;
console.log(`baseline top1=${pct(baseHit,n)}  miss=${pct(miss,n)}  missサンプル=${missSamp.length}  hitサンプル=${hitSamp.length}\n`);

// 精度 a で gold 内部境界を独立反転 → cuts を作る
function perturb(gc, len, a){
  const goldInner = new Set(gc.slice(0,-1)); // 内部境界(末尾=len は除く)
  const cuts=[];
  for(let p=1;p<len;p++){
    let cut = goldInner.has(p);
    if(rng() > a) cut = !cut;        // 確率(1-a)で判定を反転
    if(cut) cuts.push(p);
  }
  cuts.push(len);
  return cuts;
}

// thresh=Infinity → 常にゲートで素通し(=何もしない)。thresh=0 → 全件適用(destructive)。
// margin < thresh のときだけ segmenter を適用(=自由ラティスが迷ってる時だけ再分割)。
const measure = (samp, a, thresh, isHit) => {
  let ok=0;
  for(const s of samp){
    if(s.margin >= thresh){ if(isHit) ok++; continue; } // ゲート素通し: 自由top1。hitなら正解、missなら不正解
    const cuts = a>=1.0 ? s.gc : perturb(s.gc, s.len, a);
    setW((run)=> run===s.yomi ? cuts : null);
    const t = ((conv(s.yomi,s.ctx)||{}).list||[])[0];
    if(t===s.expect) ok++;
  }
  setW(null);
  return ok/samp.length;
};
const netAt = (a, thresh) => {
  SEED = +(process.env.SEED || 12345); const fix  = measure(missSamp, a, thresh, false);
  SEED = +(process.env.SEED || 12345); const keep = measure(hitSamp,  a, thresh, true);
  return { fix, brk:1-keep, net: hitRate*keep + missRate*fix };
};

console.log(`【A】destructive(全入力に区切り強制 = thresh ∞)`);
console.log(`境界精度 a | 直せる | 壊れる |  NET   | 純利得`);
for(const a of [1.0, 0.99, 0.98, 0.96, 0.93, 0.90]){
  const r = netAt(a, Infinity);
  console.log(`  ${a.toFixed(2)}    | ${(100*r.fix).toFixed(1).padStart(4)}% | ${(100*r.brk).toFixed(1).padStart(4)}% | ${(100*r.net).toFixed(2)}% | ${r.net>=baseTop1?'+':''}${(100*(r.net-baseTop1)).toFixed(2)}pt`);
}

// margin の分布を見て妥当な閾値を選ぶ
const allM = [...missSamp,...hitSamp].map(s=>s.margin).filter(m=>m<1e8).sort((x,y)=>x-y);
const q = (p)=> allM[Math.floor(p*allM.length)]|0;
console.log(`\nmargin分位: p25=${q(.25)} p50=${q(.5)} p75=${q(.75)} p90=${q(.9)}`);
const missM = missSamp.map(s=>s.margin).filter(m=>m<1e8).sort((x,y)=>x-y);
const hitM  = hitSamp.map(s=>s.margin).filter(m=>m<1e8).sort((x,y)=>x-y);
const med=(arr)=>arr[Math.floor(arr.length/2)]|0;
console.log(`miss中央margin=${med(missM)}  hit中央margin=${med(hitM)}  ← miss(迷い)が低くhit(自信)が高ければゲートが効く`);

console.log(`\n【B】confidenceゲート: 自由margin<X の時だけ再分割(自由が迷う所だけ触る)。X小=控えめ, X=∞=全適用`);
for(const a of [0.99, 0.96, 0.93, 0.90]){
  console.log(`-- 境界精度 a=${a.toFixed(2)} --`);
  console.log(`  適用域   |  直せる | 壊れる |  NET   | 純利得`);
  for(const thr of [0, 60, 120, 250, 500, 1e9]){
    const r = netAt(a, thr);
    const lbl = thr===1e9?'全適用' : thr===0?'無適用' : `margin<${thr}`;
    console.log(`  ${lbl.padStart(8)} | ${(100*r.fix).toFixed(1).padStart(4)}% | ${(100*r.brk).toFixed(1).padStart(4)}% | ${(100*r.net).toFixed(2)}% | ${r.net>=baseTop1?'+':''}${(100*(r.net-baseTop1)).toFixed(2)}pt`);
  }
}
console.log(`\nbaseline=${pct(baseHit,n)}。誤りは位置独立模擬(概算)。ゲートで「自信のある正解」を保護できれば、低精度でも純利得が正に戻るはず。`);
