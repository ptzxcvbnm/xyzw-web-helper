import {readFile, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';
import {createOfflineRuntime, assetDirectory, assetLock} from './offline-runtime.mjs';

export async function compareSample(sample) {
  assert.equal(sample.format, 'xyzw-main-level-sample-v1', 'Unsupported sample format');
  for (const name of ['battleVersion','configCommit','engineVersion']) {
    assert.equal(sample.metadata?.[name], assetLock[name], `Sample ${name} must match the locked assets`);
  }
  assert.equal(typeof sample.extend?.autoAttack, 'boolean', 'Missing autoAttack setting');
  assert.ok(Number.isFinite(sample.extend?.autoAttackInterval), 'Missing autoAttackInterval');
  assert.ok(sample.browserSimulation?.result?.outputCode, 'Browser reference result is missing');
  const runtime = await createOfflineRuntime();
  await runtime.initialize();
  runtime.context.__sampleJson = JSON.stringify(sample);
  runtime.run(`
    var sample = JSON.parse(__sampleJson); delete __sampleJson;
    function revive(value) {
      if(value===null || typeof value!=='object') return value;
      if(Array.isArray(value)) return value.map(revive);
      if(value.__type==='Map') return new Map(value.value.map(([key,item])=>[revive(key),revive(item)]));
      if(value.__type==='Set') return new Set(value.value.map(revive));
      if(value.__type==='Date') return new Date(value.value);
      if(value.__type==='BigInt') return BigInt(value.value);
      return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,revive(item)]));
    }
    function runSample(timeScale) {
      var data = __require('data-index');
      var input = revive(sample.battleData);
      if(input.mode!==data.BattleType.level || !(input.options instanceof Map)) throw new Error('Expected a main-level battle with Map options');
      var factory = new (__require('launcher-server').ServerBattleLauncher)();
      factory.initialize();
      var battle = factory.createBattleById({battleData:input,timeScale,extend:{...sample.extend,noRender:true,role:new data.GDRole()}});
      var result = null;
      battle.BattleResult.add(value=>{result={isWin:value.isWin,round:value.round,totalFrame:value.totalFrame,inputCode:value.inputCode,outputCode:value.outputCode};});
      var time=0, updates=0, started=Date.now();
      try {
        battle.startBattle();
        while(!result && updates<20000) {battle.update(time);time+=20;updates++;}
        if(!result)throw new Error('Sample exceeded the simulation step limit');
        return {timeScale,updates,wallMs:Date.now()-started,result};
      } finally {battle.endBattle();}
    }
  `);
  const runs=[];
  for (const scale of [1,100]) {
    for(let repeat=0;repeat<2;repeat++) {
      const run=JSON.parse(JSON.stringify(runtime.run(`runSample(${scale})`)));
      run.matchesBrowser=isDeepStrictEqual(run.result,sample.browserSimulation.result);
      runs.push(run);
    }
  }
  return {levelId:sample.levelId, metadata:sample.metadata, browser:sample.browserSimulation,
    allMatchBrowser:runs.every(run=>run.matchesBrowser),
    allNodeRunsAgree:runs.every(run=>isDeepStrictEqual(run.result,runs[0].result)),runs};
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if(!process.argv[2]) throw new Error('Usage: node server/experiments/push-level/compare-sample.mjs <sample.json>');
    const result=await compareSample(JSON.parse(await readFile(process.argv[2],'utf8')));
    const target=new URL('real-sample-comparison.json',assetDirectory);
    await writeFile(target,JSON.stringify(result,null,2)+'\n');
    console.log(JSON.stringify(result,null,2));
    if(!result.allMatchBrowser) process.exitCode=1;
  } catch(error) {
    console.error(String(error.stack).split('\n').filter(line=>line.length<1000).slice(0,12).join('\n'));
    process.exitCode=1;
  }
}
