// 段階3a e2e: わかち provider 配線が __neConv/planConversion を通して正しく効くか。
//  (1) provider 未設定 → 自由ラティス(回帰: 68.84%)
//  (2) gold cuts を返す mock provider → __neConv の top1 が上限(~83%)を再現 = 配線が忠実
//  (3) 不正な cuts(run を覆わない)→ 棄却され自由ラティスにフォールバック(top1 は素の値に戻る)
// usage: node tools/eval-wakachi-e2e.mjs   env: K=300 MAXDEEP=6000
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const EVAL = process.argv[2] || '/tmp/ne-eval.json';
const K = +(process.env.K || 300);
const MAXDEEP = +(process.env.MAXDEEP || 6000);

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

// --- pass: baseline (provider なし) ---
setW(null);
let n=0, baseHit=0;
for(const c of cases){ n++; const t=((conv(c.yomi,c.ctx)||{}).list||[])[0]; if(t===c.expect) baseHit++; }
console.log(`(1) provider未設定 baseline top1 = ${pct(baseHit,n)}  ← 68.84% であるべき(回帰)`);

// --- pass: gold-cuts mock provider on sampled misses ---
const estMiss = Math.max(1, Math.round(n*0.3116));
const stride = Math.max(1, Math.floor(estMiss/MAXDEEP));
let miss=0, sampled=0, fixed=0, fallbackOK=0, fallbackN=0, missSeen=0;
for(const c of cases){
  setW(null);
  const t0 = ((conv(c.yomi,c.ctx)||{}).list||[])[0];
  if(t0===c.expect) continue;
  miss++;
  if((missSeen++ % stride)!==0) continue;
  if(sampled>=MAXDEEP) continue;
  sampled++;
  // gold cuts を自由ラティスから得る
  const deep = lat(c.yomi, c.ctx, K);
  const gold = deep.find(p=>p.out===c.expect);
  if(!gold) continue; // UNREACH はスキップ
  const gc = cutsArr(gold.segs);
  // (2) gold cuts を返す provider を通す
  setW((run)=> run===c.yomi ? gc : null);
  const t1 = ((conv(c.yomi,c.ctx)||{}).list||[])[0];
  if(t1===c.expect) fixed++;
  // (3) 不正 cuts(末尾が run 長でない)→ 棄却され baseline に戻るはず
  fallbackN++;
  setW((run)=> run===c.yomi ? gc.slice(0,-1).concat([gc[gc.length-1]-1]) : null); // 末尾を1ずらして無効化
  const t2 = ((conv(c.yomi,c.ctx)||{}).list||[])[0];
  if(t2===t0) fallbackOK++;
}
setW(null);
const fixRate = fixed/sampled;
const ceil = baseHit/n + (miss/n)*fixRate;
console.log(`\n(2) gold-cuts provider経由 (sampled=${sampled}):`);
console.log(`    救えた FIXED = ${fixed} (${pct(fixed,sampled)})  ← cutverifyの46%台と一致すべき`);
console.log(`    >>> provider経由の完璧わかち top1 = ${(100*ceil).toFixed(2)}%  (+${(100*(ceil-baseHit/n)).toFixed(2)}pt)`);
console.log(`\n(3) 不正cuts棄却→フォールバック健全性: ${fallbackOK}/${fallbackN} (${pct(fallbackOK,fallbackN)})  ← 100% であるべき`);
