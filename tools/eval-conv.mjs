// 決定論ラティスの top-1/top-3 正答率を測る(LLM審査は通さない)。
// editor.js を偽DOMで起動し、実dict/basedictをロードして __neConv で評価する。
// usage: node tools/eval-conv.mjs [/tmp/ne-eval.json]
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const EVAL = process.argv[2] || '/tmp/ne-eval.json';

const realST = setTimeout; // 起動後タイマを黙らせる前に退避
const sleep = (ms) => new Promise((r) => realST(r, ms));

class FakeEl { constructor(id){this.id=id;this.innerHTML='';this.textContent='';this.value='';this.classList={add(){},remove(){}};this.scrollTop=0;} get scrollHeight(){return 0;} querySelector(){return new FakeEl('q');} querySelectorAll(){return [];} }
const els={}; const el=(id)=>(els[id]??=new FakeEl(id));
globalThis.document={getElementById:el,querySelector:()=>new FakeEl('q'),querySelectorAll:()=>[],createElement:()=>new FakeEl('a'),addEventListener:()=>{}};
globalThis.localStorage={_m:{},getItem(k){return this._m[k]??null;},setItem(k,v){this._m[k]=String(v);}};
globalThis.localStorage.setItem('ne:llm','off');
globalThis.setInterval=()=>0; globalThis.setTimeout=()=>0; // 起動後の自動保存/採取/公証タイマを黙らせる
globalThis.URL={createObjectURL:()=>''}; globalThis.Blob=class{};
globalThis.fetch=async(p)=>{ const u=String(p).replace('./',''); const fp=path.join(ROOT,u); return { json: async()=>JSON.parse(fs.readFileSync(fp,'utf8')) }; };

await import('../editor.js');
let ready=false;
for(let i=0;i<200;i++){ await sleep(50); const pl=globalThis.__neConv('こくはく'); if(pl&&pl.list&&pl.list.includes('告白')){ready=true;break;} }
if(!ready){ console.error('辞書ロード待ちタイムアウト'); process.exit(1); }

const cases = JSON.parse(fs.readFileSync(EVAL,'utf8'));
const conv = globalThis.__neConv;
let t1=0,t3=0,n=0; const byTok={}; const miss=[];
for(const c of cases){
  const pl = conv(c.yomi, c.ctx);
  const list = (pl&&pl.list)||[];
  const i = list.indexOf(c.expect);
  const ok1 = i===0, ok3 = i>=0 && i<3;
  n++; if(ok1)t1++; if(ok3)t3++;
  (byTok[c.ntok] ??= {n:0,t1:0}); byTok[c.ntok].n++; if(ok1)byTok[c.ntok].t1++;
  if(!ok1 && miss.length<40) miss.push({ctx:c.ctx,yomi:c.yomi,expect:c.expect,got:list.slice(0,3)});
}
const pct=(a,b)=>(100*a/b).toFixed(2)+'%';
console.log(`N=${n}  top1=${pct(t1,n)}  top3=${pct(t3,n)}`);
for(const k of Object.keys(byTok).sort()) console.log(`  ntok=${k}: top1=${pct(byTok[k].t1,byTok[k].n)} (n=${byTok[k].n})`);
if(process.env.SHOW_MISS){ console.log('--- misses ---'); for(const m of miss) console.log(`ctx「${m.ctx}」${m.yomi} 期待:${m.expect} 出力:[${m.got.join(', ')}]`); }
