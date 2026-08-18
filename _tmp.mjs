import { g_utils } from './src/utils/bonProtocol.js';
import fs from 'fs';
const file=process.argv[2];
function dec(r){const b=Buffer.from(r.base64,'base64');return g_utils.parse(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength),'auto',!!r.isSalt);}
const j=JSON.parse(fs.readFileSync(file,'utf8'));
for(const r of j.records||[]){
  if(r.kind!=='binary'||r.byteLength<=1)continue;
  let p;try{p=dec(r);}catch(e){continue;}
  const cmd=p.cmd||'';const d=p.rawData??p._rawData??p.body;if(!d)continue;
  // 我发的行军/上船命令原始body
  if(r.dir==='send'&&(cmd==='payload_startmarch'||cmd==='payload_setbattleteam'||cmd==='payload_enterbf')){
    console.log('\n[SEND '+cmd+'] '+JSON.stringify(d).slice(0,400));
  }
  // 船生成
  if(cmd==='payload_gencarnotify'){
    console.log('\n[gencar] '+JSON.stringify(d).slice(0,400));
  }
  // 行军resp里的行军对象(看是carId还是target/path)
  if(cmd==='payload_startmarchresp'){
    const s=JSON.stringify(d);
    if(s.includes('marches')&&s.length<600)console.log('\n[startmarchresp] '+s.slice(0,500));
  }
}
