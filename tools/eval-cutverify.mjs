// 段階2検証: 区切り制約の「口」が正しく効くかを、gold cuts を実機構に流して確認する。
// オラクルテスト(eval-oracle: beam フィルタ近似)と違い、これは latticeBest の allowed 制約を
// 直接使う厳密版。完璧わかち時の top1 を再現し、機構が壊れていないことを固定する。
// usage: node tools/eval-cutverify.mjs [/tmp/ne-eval.json]   env: K=300 MAXDEEP=6000
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
const cases = JSON.parse(fs.readFileSync(EVAL,'utf8'));
const cutsArr = (segs) => { const a=[]; let s=0; for(const [y] of segs){ s+=[...y].length; a.push(s); } return a; };

let n=0, hit=0, miss=0, sampled=0;
let FIXED=0, EMPTY=0, KANJI=0, UNREACH=0, MISMATCH=0;
const estMiss = Math.max(1, Math.round(cases.length*0.3116));
const stride = Math.max(1, Math.floor(estMiss/MAXDEEP));
let missSeen=0;

for(const c of cases){
  const pl = conv(c.yomi, c.ctx);
  const top1 = ((pl&&pl.list)||[])[0];
  n++;
  if(top1===c.expect){ hit++; continue; }
  miss++;
  if((missSeen++ % stride)!==0) continue;
  if(sampled>=MAXDEEP) continue;
  sampled++;
  const deep = lat(c.yomi, c.ctx, K);            // 自由ラティスから gold 経路の区切りを得る
  const gold = deep.find(p=>p.out===c.expect);
  if(!gold){ UNREACH++; continue; }
  const gc = cutsArr(gold.segs);
  const constrained = lat(c.yomi, c.ctx, K, gc); // ★区切り制約を実機構で注入
  if(!constrained.length){ EMPTY++; continue; }  // gold 区切りが12字窓を超える等で構築不能
  const ctop = constrained[0].out;               // 制約下の最安 = 完璧わかち時のエンジン top1
  if(ctop===c.expect) FIXED++;
  else KANJI++;
  // 健全性: 制約結果の区切りが本当に gold と一致しているか
  if(cutsArr(constrained[0].segs).join(',')!==gc.join(',')) MISMATCH++;
}

const pct=(a,b)=>(100*a/b).toFixed(2)+'%';
const missRate = miss/n;
const fixRate = FIXED/sampled;
const ceil = hit/n + missRate*fixRate;
console.log(`\n=== 区切り制約 検証 (厳密, K=${K}, sampled=${sampled}, stride=${stride}) ===`);
console.log(`現状 top1        : ${pct(hit,n)}`);
console.log(`FIXED(救える)    : ${FIXED} (${pct(FIXED,sampled)})`);
console.log(`KANJI(漢字で残る): ${KANJI} (${pct(KANJI,sampled)})`);
console.log(`EMPTY(構築不能)  : ${EMPTY} (${pct(EMPTY,sampled)})`);
console.log(`UNREACH          : ${UNREACH} (${pct(UNREACH,sampled)})`);
console.log(`\n>>> 完璧わかち時 top1(厳密) : ${(100*ceil).toFixed(2)}%  (+${(100*(ceil-hit/n)).toFixed(2)}pt)`);
console.log(`健全性チェック MISMATCH(制約と結果の区切り不一致) : ${MISMATCH}  ← 0 であるべき`);
