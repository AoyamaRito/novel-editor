// 過変換debug: 失敗例について、各かなsubの候補コスト内訳と、文のラティス上位経路(コスト付き)を出す。
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const realST = setTimeout; const sleep=(ms)=>new Promise(r=>realST(r,ms));
class FakeEl { constructor(id){this.id=id;this.innerHTML='';this.textContent='';this.value='';this.classList={add(){},remove(){}};this.scrollTop=0;} get scrollHeight(){return 0;} querySelector(){return new FakeEl('q');} querySelectorAll(){return [];} }
const els={}; const el=(id)=>(els[id]??=new FakeEl(id));
globalThis.document={getElementById:el,querySelector:()=>new FakeEl('q'),querySelectorAll:()=>[],createElement:()=>new FakeEl('a'),addEventListener:()=>{}};
globalThis.localStorage={_m:{},getItem(k){return this._m[k]??null;},setItem(k,v){this._m[k]=String(v);}};
globalThis.localStorage.setItem('ne:llm','off');
globalThis.setInterval=()=>0; globalThis.setTimeout=()=>0; globalThis.URL={createObjectURL:()=>''}; globalThis.Blob=class{};
globalThis.fetch=async(p)=>{ const u=String(p).replace('./',''); const fp=path.join(ROOT,u); return { json: async()=>JSON.parse(fs.readFileSync(fp,'utf8')) }; };
await import('../editor.js');
for(let i=0;i<200;i++){ await sleep(50); const pl=globalThis.__neConv('こくはく'); if(pl&&pl.list&&pl.list.includes('告白')) break; }
const cands=globalThis.__neCands, lat=globalThis.__neLat;

console.log('=== 単語サブのコスト内訳(かなで残すべき語が過変換される?) ===');
for(const sub of ['なる','かな','あっ','なり','なん','こと','もの','よん','わたし']){
  const r=cands(sub);
  console.log(`\n「${sub}」 isFunc=${r.isFunc} kanaPref=${r.kanaPref} → かなコスト=${r.kanaCost}`);
  for(const w of r.word) console.log(`   ${w.s2}\tcost=${w.c}\t${w.pos}`);
}

console.log('\n\n=== 文のラティス上位経路(コスト付き) ===');
for(const [ctx,yomi,want] of [['ト','がひつようになる','が必要になる'],['「','それはむずかしいかな','それは難しいかな'],['な','ことよりわたし','ことより私'],['ジ','とこたえ','と答え']]){
  console.log(`\nctx「${ctx}」${yomi}  期待:${want}`);
  const ps=lat(yomi,ctx,8);
  for(const p of ps.slice(0,6)) console.log(`   cost=${p.cost}\t${p.out}\t[${p.segs.map(s=>s[0]+'→'+s[1]).join(' | ')}]`);
}
