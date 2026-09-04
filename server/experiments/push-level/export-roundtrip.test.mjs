import {readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {createOfflineRuntime,assetDirectory} from './offline-runtime.mjs';
import {compareSample} from './compare-sample.mjs';

// Exercise the browser export code with the real battle engine and a minimal DOM,
// then load its JSON in a separate runtime. This remains a synthetic input test.
try {
  const runtime=await createOfflineRuntime();
  await runtime.initialize();
  runtime.context.setTimeout=(callback)=>setTimeout(callback,0);
  runtime.run(`
    var d=__require('data-index');
    var fixture=new d.BattleData();
    fixture.id=77;fixture.mode=d.BattleType.level;fixture.randomSeed=123;fixture.maxRound=100;
    fixture.version=__require('battle-const').BattleConst.BATTLE_VERSION;
    fixture.options.set('levelId',100);fixture.options.set('autoSpeed',100);
    var hero=new d.Fighter();
    Object.assign(hero,{id:101,type:0,index:0,level:1,attack:1e5,hp:1e5,curHp:1e5,defense:0,speed:100,curEnergy:-1});
    fixture.leftTeam.team.set(0,hero);
    var originalRequire=__require;
    __require=name=>name==='manager-factory'?{GET_LEVEL_BATTLE:()=>({options:{battleData:fixture}})}:
      name==='ModuleManager'?{GET_MODULE:()=>({autoAttack:false,autoAttackInterval:0.5})}:originalRequire(name);
    var buttons=[],downloadText='',lastBlob;
    var document={getElementById:()=>null,body:{appendChild(){}},createElement(tag){
      var node={tag,style:{},children:[],appendChild(child){this.children.push(child)},remove(){},setAttribute(){},
        addEventListener(event,handler){this.handler=handler},click(){if(tag==='a')downloadText=lastBlob.parts.join('')}};
      if(tag==='button')buttons.push(node);
      return node;
    }};
    var Blob=class {constructor(parts){this.parts=parts}};
    var URL={createObjectURL(blob){lastBlob=blob;return 'blob:synthetic-test'},revokeObjectURL(){}};
  `);
  runtime.run(await readFile(new URL('diagnostic-export.user.js',import.meta.url),'utf8'));
  await runtime.run(`buttons.find(button=>button.textContent==='采集当前主线（单次）').handler()`);
  await runtime.run(`buttons.find(button=>button.textContent==='下载主线样本').handler()`);
  const text=runtime.run('downloadText');
  assert.ok(text,'Exporter must produce a downloadable sample');
  assert.equal(runtime.run('fixture.id'),77,'Export must not replace the live battle ID');
  assert.equal(runtime.run('fixture.leftTeam.team.get(0).hp'),1e5,'Export must not modify live input');
  const sample=JSON.parse(text);
  assert.equal(sample.battleData.options.__type,'Map','Map metadata must survive JSON export');
  const result=await compareSample(sample);
  assert.ok(result.allMatchBrowser,'The export path and separate runtime must agree');
  assert.ok(result.allNodeRunsAgree,'Repeated 1x and 100x simulations must agree');
  await assert.rejects(compareSample({...sample,metadata:{...sample.metadata,engineVersion:'wrong'}}),/engineVersion/);
  await writeFile(new URL('synthetic-export-comparison.json',assetDirectory),JSON.stringify({syntheticOnly:true,...result},null,2));
  console.log('PASS: synthetic export/download/JSON revive/independent simulation; 4 comparison runs agree; version mismatch rejected.');
} catch(error) {
  console.error(String(error.stack).split('\n').filter(line=>line.length<1000).slice(0,14).join('\n'));
  process.exitCode=1;
}
