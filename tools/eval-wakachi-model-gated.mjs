// モデル provider に confidence ゲートを足す: 自由ラティスの margin(top1/top2コスト差)が
// 低い(=迷ってる)ケースだけモデルの区切りを適用。高margin(自信)の正解は保護する。
// usage: node tools/eval-wakachi-model-gated.mjs   env: MODEL=... THI=0.9 TLO=0.1
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { feats } from './wakachi-feats.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const EVAL = process.argv[2] || '/tmp/ne-eval.json';
const MODEL = process.env.MODEL || '/tmp/ne-wakachi-model.json';
const THI = +(process.env.THI || 0.9), TLO = +(process.env.TLO || 0.1);

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
const W = new Map(Object.entries(JSON.parse(fs.readFileSync(MODEL,'utf8'))));
const sig=(z)=>1/(1+Math.exp(-z));
const prob=(chars,p)=>{ let z=0; for(const f of feats(chars,p)) z+=W.get(f)||0; return sig(z); };
const pct=(a,b)=>(100*a/b).toFixed(2)+'%';
const modelCon=(run)=>{ const chars=[...run]; const force=[],forbid=[]; for(let p=1;p<chars.length;p++){ const pr=prob(chars,p); if(pr>=THI)force.push(p); else if(pr<=TLO)forbid.push(p);} return (force.length||forbid.length)?{force,forbid}:null; };

// 前計算: baseline top1, free margin
setW(null);
let n=0, base=0;
const recs=[];
for(const c of cases){ n++; const b=((conv(c.yomi,c.ctx)||{}).list||[])[0]===c.expect; if(b)base++;
  const d=lat(c.yomi,c.ctx,8); const m=d.length>1?d[1].cost-d[0].cost:1e9; recs.push({c,b,m}); }
console.log(`baseline=${pct(base,n)}  THI/TLO=${THI}/${TLO}\n適用域(margin<X) | NET top1 | 純利得 | 直った | 壊れた | 適用件数`);

for(const thr of [0, 40, 80, 150, 300, 1e9]){
  let hit=0, fixed=0, broke=0, applied=0;
  for(const r of recs){
    let g;
    if(r.m < thr){ applied++; setW(modelCon); g=((conv(r.c.yomi,r.c.ctx)||{}).list||[])[0]===r.c.expect; setW(null); }
    else g=r.b;
    if(g)hit++; if(!r.b&&g)fixed++; if(r.b&&!g)broke++;
  }
  const lbl = thr===1e9?'全適用':thr===0?'無適用':`<${thr}`;
  console.log(`  ${lbl.padStart(8)} | ${pct(hit,n)} | ${hit>=base?'+':''}${(100*(hit-base)/n).toFixed(2)}pt | ${String(fixed).padStart(4)} | ${String(broke).padStart(5)} | ${applied}`);
}
console.log(`\n注: in-domain(楽観的)。kuromoji分割 vs ラティス勝ち筋分割のミスマッチが残るため、ゲートで緩和できるかの確認。`);
