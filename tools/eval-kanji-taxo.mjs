// KANJIミス(区切りは top1 と同じだが漢字が違う)の中身を分類する。
//  HOMOPHONE : 両方とも漢字で違う = 真の同音語曖昧性(文脈で選ぶべき本丸)
//  OVER_KANJI: gold=かな / top1=漢字  = エンジンが閉じ過ぎ(著者はかな)
//  UNDER_KANJI: gold=漢字 / top1=かな = エンジンが開き過ぎ(著者は漢字)
//  KANA_FORM : 両方かな(ひらがな/カタカナ違い等)
// 区切りが同じ前提なのでセグメント1:1で対応。違うセグメントだけ見る。
// usage: node tools/eval-kanji-taxo.mjs   env: K=300 MAXDEEP=8000 SHOW=12
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const EVAL = process.argv[2] || '/tmp/ne-eval.json';
const K = +(process.env.K || 300);
const MAXDEEP = +(process.env.MAXDEEP || 8000);
const SHOW = +(process.env.SHOW || 12);

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

const conv = globalThis.__neConv, lat = globalThis.__neLat;
const cases = JSON.parse(fs.readFileSync(EVAL,'utf8'));
const cuts = (segs) => { const a=[]; let s=0; for(const [y] of segs){ s+=[...y].length; a.push(s); } return a.join(','); };
const isKana = (s) => /^[ぁ-んァ-ヶー]+$/.test(s);
const hasKanji = (s) => /[一-鿿々]/.test(s);
const pct=(a,b)=>(100*a/b).toFixed(2)+'%';

let n=0, miss=0, kanji=0, sampled=0, segMiss=0, unreach=0;
const cat={HOMOPHONE:0, OVER_KANJI:0, UNDER_KANJI:0, KANA_FORM:0};
const ex={HOMOPHONE:[], OVER_KANJI:[], UNDER_KANJI:[]};
const estMiss = Math.max(1, Math.round(cases.length*0.3116));
const stride = Math.max(1, Math.floor(estMiss/MAXDEEP));
let missSeen=0;

for(const c of cases){
  const top1 = ((conv(c.yomi,c.ctx)||{}).list||[])[0];
  n++; if(top1===c.expect) continue;
  miss++;
  if((missSeen++ % stride)!==0) continue;
  if(sampled>=MAXDEEP) continue;
  sampled++;
  const deep = lat(c.yomi, c.ctx, K);
  const g = deep.find(p=>p.out===c.expect);
  const t = deep.find(p=>p.out===top1);
  if(!g){ unreach++; continue; }
  if(!t || cuts(g.segs)!==cuts(t.segs)){ segMiss++; continue; } // SEGミス(別分類)
  kanji++;
  // 区切り同じ → セグメント対応。違うセグメントを分類。
  let label=null;
  for(let k=0;k<g.segs.length;k++){
    const gs=g.segs[k][1], ts=t.segs[k][1];
    if(gs===ts) continue;
    let l;
    if(hasKanji(gs) && hasKanji(ts)) l='HOMOPHONE';
    else if(isKana(gs) && hasKanji(ts)) l='OVER_KANJI';
    else if(hasKanji(gs) && isKana(ts)) l='UNDER_KANJI';
    else l='KANA_FORM';
    if(l==='HOMOPHONE'){ label='HOMOPHONE'; break; } // 同音語があれば最優先
    if(!label) label=l;
  }
  if(label){ cat[label]++; if(ex[label]&&ex[label].length<SHOW) ex[label].push({ctx:c.ctx,yomi:c.yomi,expect:c.expect,top1}); }
}

const cls = cat.HOMOPHONE+cat.OVER_KANJI+cat.UNDER_KANJI+cat.KANA_FORM;
console.log(`\n=== KANJIミスの内訳 (sampled misses=${sampled}, KANJI型=${kanji}, SEG=${segMiss}, UNREACH=${unreach}) ===`);
console.log(`HOMOPHONE  真の同音語(漢字vs漢字) : ${cat.HOMOPHONE}\t(${pct(cat.HOMOPHONE,cls)})  ← 文脈で選ぶ本丸`);
console.log(`OVER_KANJI 閉じ過ぎ(gold=かな)    : ${cat.OVER_KANJI}\t(${pct(cat.OVER_KANJI,cls)})  ← 開き/閉じ・eval ノイズ寄り`);
console.log(`UNDER_KANJI開き過ぎ(gold=漢字)    : ${cat.UNDER_KANJI}\t(${pct(cat.UNDER_KANJI,cls)})  ← 開き/閉じ`);
console.log(`KANA_FORM  かな形違い             : ${cat.KANA_FORM}\t(${pct(cat.KANA_FORM,cls)})`);
const dump=(name)=>{ if(!SHOW)return; console.log(`\n--- ${name} 例 ---`); for(const e of ex[name]) console.log(`  ctx「${e.ctx}」${e.yomi}  期待:${e.expect}  top1:${e.top1}`); };
dump('HOMOPHONE'); dump('OVER_KANJI'); dump('UNDER_KANJI');
