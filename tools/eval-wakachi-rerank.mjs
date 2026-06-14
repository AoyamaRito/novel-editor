// 代替案: 区切りを強制せず、ラティス自身の top-K 候補(各々 segs を持つ)を
// モデルの境界確率で再ランク。score = cost - λ·Σ log P_model(その候補の境界判定)。
// ラティスが作れない区切りは押し付けない=安全。λ=0 は素のラティス。
// usage: node tools/eval-wakachi-rerank.mjs   env: MODEL=... K=8
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { feats } from './wakachi-feats.mjs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const EVAL = process.argv[2] || '/tmp/ne-eval.json';
const MODEL = process.env.MODEL || '/tmp/ne-wakachi-model.json';
const K = +(process.env.K || 8);

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

const lat  = globalThis.__neLat;
const cases = JSON.parse(fs.readFileSync(EVAL,'utf8'));
const W = new Map(Object.entries(JSON.parse(fs.readFileSync(MODEL,'utf8'))));
const sig=(z)=>1/(1+Math.exp(-z));
const prob=(chars,p)=>{ let z=0; for(const f of feats(chars,p)) z+=W.get(f)||0; return sig(z); };
const pct=(a,b)=>(100*a/b).toFixed(2)+'%';
const innerCuts=(segs)=>{ const s=new Set(); let a=0; for(let k=0;k<segs.length-1;k++){ a+=[...segs[k][0]].length; s.add(a);} return s; };

// 事前にケースごとの候補を集める
const data=[];
for(const c of cases){
  const cand = lat(c.yomi, c.ctx, K);
  if(!cand.length) continue;
  const chars=[...c.yomi]; const n=chars.length;
  const lp=new Array(n+1).fill(0); for(let p=1;p<n;p++) lp[p]=Math.log(prob(chars,p)+1e-9); // log P(cut)
  const lq=new Array(n+1).fill(0); for(let p=1;p<n;p++) lq[p]=Math.log(1-prob(chars,p)+1e-9); // log P(nocut)
  const scored = cand.map(p=>{ const cut=innerCuts(p.segs); let ll=0; for(let q=1;q<n;q++) ll += cut.has(q)?lp[q]:lq[q]; return {out:p.out, cost:p.cost, ll}; });
  data.push({ expect:c.expect, scored });
}
const N=data.length;

console.log(`再ランク対象=${N}(__neLat候補あり)  K=${K}`);
console.log(`   λ    | top1(再ランク) | 対λ0`);
const base = data.filter(d=>d.scored[0].out===d.expect).length;
console.log(`  0.000 | ${pct(base,N)} | (基準=素のラティス)`);
for(const lam of [0.2, 0.5, 1.0, 2.0, 4.0, 8.0]){
  let hit=0;
  for(const d of data){
    let best=d.scored[0], bs=d.scored[0].cost - lam*d.scored[0].ll;
    for(const s of d.scored){ const sc=s.cost - lam*s.ll; if(sc<bs){ bs=sc; best=s; } }
    if(best.out===d.expect) hit++;
  }
  console.log(`  ${lam.toFixed(3)} | ${pct(hit,N)} | ${hit>=base?'+':''}${(100*(hit-base)/N).toFixed(2)}pt`);
}
console.log(`\n注: in-domain(楽観的)。候補集合内の再ランクのみ=安全(作れない区切りは出ない)。λは cost vs モデル境界尤度の重み。`);
