// 答え合わせ: 学習した境界分類器を partial provider に繋ぎ、実パイプラインの net top1 を測る。
// provider(run): 各内部位置の確率 → p≥THI を force(切る), p≤TLO を forbid(切らない), 中間は abstain。
// 読みはラティスが常に保つので安全。現状正解も含む全件で baseline と比較(破壊込みの真の net)。
// usage: node tools/eval-wakachi-model.mjs   env: MODEL=/tmp/ne-wakachi-model.json
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { feats } from './wakachi-feats.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const EVAL = process.argv[2] || '/tmp/ne-eval.json';
const MODEL = process.env.MODEL || '/tmp/ne-wakachi-model.json';

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
const setW = globalThis.__neSetWakachi;
const cases = JSON.parse(fs.readFileSync(EVAL,'utf8'));
const W = new Map(Object.entries(JSON.parse(fs.readFileSync(MODEL,'utf8'))));
const sigmoid=(z)=>1/(1+Math.exp(-z));
const prob=(chars,p)=>{ let z=0; for(const f of feats(chars,p)) z+=W.get(f)||0; return sigmoid(z); };
const pct=(a,b)=>(100*a/b).toFixed(2)+'%';

// baseline
setW(null);
let n=0, base=0;
for(const c of cases){ n++; if(((conv(c.yomi,c.ctx)||{}).list||[])[0]===c.expect) base++; }
console.log(`baseline top1 = ${pct(base,n)}  (N=${n})\n`);
console.log(`  THI / TLO  |  NET top1  | 純利得 | 直った | 壊れた`);
console.log(`-------------|------------|--------|--------|--------`);

for(const [THI,TLO] of [[0.9,0.1],[0.85,0.15],[0.8,0.2],[0.7,0.3]]){
  setW((run)=>{
    const chars=[...run]; const force=[], forbid=[];
    for(let p=1;p<chars.length;p++){ const pr=prob(chars,p); if(pr>=THI) force.push(p); else if(pr<=TLO) forbid.push(p); }
    return (force.length||forbid.length) ? {force,forbid} : null;
  });
  let hit=0, fixed=0, broke=0;
  for(const c of cases){
    setW(null); const b=((conv(c.yomi,c.ctx)||{}).list||[])[0]===c.expect;
    setWModel(THI,TLO); const a=((conv(c.yomi,c.ctx)||{}).list||[])[0]===c.expect;
    if(a) hit++; if(!b&&a) fixed++; if(b&&!a) broke++;
  }
  setW(null);
  console.log(`  ${THI} / ${TLO}  |  ${pct(hit,n)}  | ${hit>=base?'+':''}${(100*(hit-base)/n).toFixed(2)}pt | ${fixed} | ${broke}`);
}
function setWModel(THI,TLO){
  setW((run)=>{
    const chars=[...run]; const force=[], forbid=[];
    for(let p=1;p<chars.length;p++){ const pr=prob(chars,p); if(pr>=THI) force.push(p); else if(pr<=TLO) forbid.push(p); }
    return (force.length||forbid.length) ? {force,forbid} : null;
  });
}
console.log(`\n注: 評価セットは学習と同じコーパス由来(in-domain・楽観的)。真の汎化は別コーパス保留で要確認。`);
