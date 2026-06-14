// 失敗分類: 決定論ラティスの top-1 ミスを SEG(分割ミス)/ KANJI(漢字ミス)/ UNREACH(到達不能) に分ける。
// SEG    = 正解が深いラティスに存在し、その区切り(かな長の列)が top-1 と違う → 分割を直せば取れる
// KANJI  = 正解が存在し区切りは top-1 と同じだが漢字が違う → ランキング/単漢字/再ランクの領域
// UNREACH= 正解が深いラティス(ビーム幅 K)に存在しない → 辞書/単漢字フロアの recall 問題
// usage: node tools/eval-taxo.mjs [/tmp/ne-eval.json]   env: K=200 MAXDEEP=8000 SHOW=20
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const EVAL = process.argv[2] || '/tmp/ne-eval.json';
const K = +(process.env.K || 200);
const MAXDEEP = +(process.env.MAXDEEP || 8000);
const SHOW = +(process.env.SHOW || 20);

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

// 区切りの指紋 = 各セグメントの「読みの文字数」の累積位置。これが一致 = 同じ分割。
const cuts = (segs) => { const a=[]; let s=0; for(const [y] of segs){ s+=[...y].length; a.push(s); } return a.join(','); };

let n=0, t1=0;                       // 全件: top-1 正答
let miss=0;                          // top-1 ミス総数
let deepDone=0;                      // 深掘り分類した件数(サンプル)
const cat={SEG:0,KANJI:0,UNREACH:0,OTHER:0};
const ex={SEG:[],KANJI:[],UNREACH:[]};
// ミスを全体に渡ってサンプリングするためのストライド(深掘りコールを MAXDEEP 以内に)
const estMiss = Math.max(1, Math.round(cases.length*0.32));
const stride = Math.max(1, Math.floor(estMiss/MAXDEEP));
let missSeen=0;

for(const c of cases){
  const pl = conv(c.yomi, c.ctx);
  const list = (pl&&pl.list)||[];
  const top1 = list[0];
  n++; if(top1===c.expect){ t1++; continue; }
  miss++;
  // ストライドサンプリング
  if((missSeen++ % stride)!==0) continue;
  if(deepDone>=MAXDEEP) continue;
  deepDone++;
  const deep = lat(c.yomi, c.ctx, K);
  const m = new Map();
  for(const p of deep) if(!m.has(p.out)) m.set(p.out, p.segs);
  const goldSegs = m.get(c.expect);
  const topSegs  = m.get(top1);
  if(!goldSegs){ cat.UNREACH++; if(ex.UNREACH.length<SHOW) ex.UNREACH.push({ctx:c.ctx,yomi:c.yomi,expect:c.expect,top1}); continue; }
  if(!topSegs){ cat.OTHER++; continue; } // top1 がラティス外(生かな/カタカナ等)。分類対象外
  if(cuts(goldSegs)!==cuts(topSegs)){ cat.SEG++; if(ex.SEG.length<SHOW) ex.SEG.push({ctx:c.ctx,yomi:c.yomi,expect:c.expect,top1,gold:cuts(goldSegs),got:cuts(topSegs)}); }
  else { cat.KANJI++; if(ex.KANJI.length<SHOW) ex.KANJI.push({ctx:c.ctx,yomi:c.yomi,expect:c.expect,top1}); }
}

const pct=(a,b)=>(100*a/b).toFixed(2)+'%';
const cls = cat.SEG+cat.KANJI+cat.UNREACH+cat.OTHER;
console.log(`\n=== 全体 ===`);
console.log(`N=${n}  top1=${pct(t1,n)}  miss=${miss} (${pct(miss,n)})  K=${K}`);
console.log(`\n=== 分類サンプル (deep=${deepDone}件, stride=${stride}, K=${K}) ===`);
console.log(`SEG   分割ミス  : ${cat.SEG}\t(${pct(cat.SEG,cls)})  ← LLMわかちが直撃する分`);
console.log(`KANJI 漢字ミス  : ${cat.KANJI}\t(${pct(cat.KANJI,cls)})  ← ランキング/単漢字/再ランク`);
console.log(`UNREACH到達不能 : ${cat.UNREACH}\t(${pct(cat.UNREACH,cls)})  ← 辞書/単漢字フロア(K=${K}ビーム外)`);
console.log(`OTHER          : ${cat.OTHER}\t(${pct(cat.OTHER,cls)})  ← top1がラティス外(分類対象外)`);

const dump=(name)=>{ console.log(`\n--- ${name} 例 ---`); for(const e of ex[name]) console.log(`  ctx「${e.ctx}」${e.yomi}  期待:${e.expect}  top1:${e.top1}${e.gold?`  [gold cuts ${e.gold} / got ${e.got}]`:''}`); };
if(SHOW){ dump('SEG'); dump('KANJI'); dump('UNREACH'); }
