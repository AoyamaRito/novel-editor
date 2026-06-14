// オラクル分割テスト: 「完璧なLLMわかち」を与えたとき top-1 がどこまで上がるかの上限を測る。
// 手順(各 top-1 ミスについて):
//   1. 深いラティス(K)から gold(=expect)の経路を探し、その区切り gc を取る。
//   2. gc と同じ区切りを持つ経路の中で最安のものを取る = 「正しい区切りを与えた時のエンジンの top-1」。
//   3. それが expect と一致 → わかちがこのミスを救う(FIXED)。一致しない → 区切りは正しいが漢字で外す(KANJI残)。
//   gold が K ビームに無い → UNREACH(わかちの対象外: 辞書/単漢字)。
// usage: node tools/eval-oracle.mjs [/tmp/ne-eval.json]   env: K=300 MAXDEEP=6000 SHOW=12
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const EVAL = process.argv[2] || '/tmp/ne-eval.json';
const K = +(process.env.K || 300);
const MAXDEEP = +(process.env.MAXDEEP || 6000);
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

const conv = globalThis.__neConv;
const lat  = globalThis.__neLat;
const cases = JSON.parse(fs.readFileSync(EVAL,'utf8'));
const cuts = (segs) => { const a=[]; let s=0; for(const [y] of segs){ s+=[...y].length; a.push(s); } return a.join(','); };

let n=0, hit=0, miss=0;
let sampled=0;
let FIXED=0, KANJI=0, UNREACH=0;     // サンプル中のミスの内訳
const ex={FIXED:[],KANJI:[]};
const estMiss = Math.max(1, Math.round(cases.length*0.3116));
const stride = Math.max(1, Math.floor(estMiss/MAXDEEP));
let missSeen=0;

for(const c of cases){
  const pl = conv(c.yomi, c.ctx);
  const list = (pl&&pl.list)||[];
  const top1 = list[0];
  n++;
  if(top1===c.expect){ hit++; continue; }
  miss++;
  if((missSeen++ % stride)!==0) continue;
  if(sampled>=MAXDEEP) continue;
  sampled++;
  const deep = lat(c.yomi, c.ctx, K);           // cost 昇順
  const gold = deep.find(p=>p.out===c.expect);
  if(!gold){ UNREACH++; continue; }
  const gc = cuts(gold.segs);
  const best = deep.find(p=>cuts(p.segs)===gc); // gold 区切りを持つ最安 = オラクル分割での top1
  if(best && best.out===c.expect){ FIXED++; if(ex.FIXED.length<SHOW) ex.FIXED.push({ctx:c.ctx,yomi:c.yomi,expect:c.expect,top1}); }
  else { KANJI++; if(ex.KANJI.length<SHOW) ex.KANJI.push({ctx:c.ctx,yomi:c.yomi,expect:c.expect,top1,oracle:best&&best.out}); }
}

const pct=(a,b)=>(100*a/b).toFixed(2)+'%';
const missRate = miss/n;
const fixRate = FIXED/sampled;                  // 全ミス中、わかち完璧で救える割合(サンプル推定)
const oracleTop1 = hit/n + missRate*fixRate;    // 完璧わかち時の top1 上限
console.log(`\n=== オラクル分割テスト (K=${K}, sampled misses=${sampled}, stride=${stride}) ===`);
console.log(`現状 top1            : ${pct(hit,n)}  (N=${n})`);
console.log(`ミス中わかちで救える : FIXED=${FIXED} (${pct(FIXED,sampled)})`);
console.log(`ミス中 漢字で残る    : KANJI=${KANJI} (${pct(KANJI,sampled)})`);
console.log(`ミス中 到達不能      : UNREACH=${UNREACH} (${pct(UNREACH,sampled)})`);
console.log(`\n>>> 完璧わかち時の top1 上限 : ${(100*oracleTop1).toFixed(2)}%   (現状 ${pct(hit,n)} から +${(100*(oracleTop1-hit/n)).toFixed(2)}pt)`);
console.log(`>>> 残り漢字ミスの天井      : ${(100*(1-(hit/n+missRate*(FIXED+0)/sampled))).toFixed(2)}% はわかちでは取れない(再ランク/単漢字の領域)`);

const dump=(name,label)=>{ if(!SHOW)return; console.log(`\n--- ${label} 例 ---`); for(const e of ex[name]) console.log(`  ctx「${e.ctx}」${e.yomi}  期待:${e.expect}  現top1:${e.top1}${e.oracle?`  オラクル区切りでも:${e.oracle}`:''}`); };
dump('FIXED','わかちで救える(分割さえ正せば正解)');
dump('KANJI','区切り正でも漢字で外す(わかち無関係)');
