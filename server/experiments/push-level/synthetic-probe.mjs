import { createOfflineRuntime, assetDirectory, assetLock } from './offline-runtime.mjs';
import { writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const runtime = await createOfflineRuntime();
try {
  console.log(await runtime.initialize());
  runtime.run(`
    var data = __require('data-index');
    function syntheticBattle(attack, hp, seed, level, timeScale) {
      var factory = new (__require('launcher-server').ServerBattleLauncher)();
      factory.initialize();
      var input = new data.BattleData();
      input.id = 900001;
      input.mode = data.BattleType.level;
      input.randomSeed = seed;
      input.version = ${JSON.stringify(assetLock.battleVersion)};
      input.maxRound = 100;
      input.options.set('levelId', level);
      input.options.set('autoSpeed', 100);
      input.leftTeam.roleId = 1;
      var hero = new data.Fighter();
      Object.assign(hero, { id: 101, type: 0, index: 0, level: 1, attack, hp, curHp: hp, defense: 0, speed: 100, curEnergy: -1 });
      input.leftTeam.team.set(0, hero);
      var battle = factory.createBattleById({battleData: input, timeScale, extend: {noRender: true, autoAttack: false, autoAttackInterval:0.5, role: new data.GDRole()}});
      var result = null;
      battle.BattleResult.add(value => { result = value; });
      battle.startBattle();
      var wallStart=Date.now(), time=0, updates=0;
      for (; !result && updates<20000; updates++) {
        battle.update(time);
        time += 20;
      }
      var summary = {synthetic:true, level, seed, attack, hp, timeScale, updates, wallMs:Date.now()-wallStart, tick: battle.tickCount, result:result && {isWin:result.isWin, round:result.round, totalFrame:result.totalFrame, outputCode:result.outputCode}};
      battle.endBattle();
      return summary;
    }
  `);
  const runs = [];
  for (const stats of [1, 1e3, 1e5, 1e8, 1e15]) {
    for (const seed of [123, 456, 789]) {
      const group = [];
      for (const scale of [1, 100, 1000]) {
        for (let repeat = 0; repeat < 2; repeat++) {
          const run = JSON.parse(JSON.stringify(runtime.run(`syntheticBattle(${stats},${stats},${seed},100,${scale})`)));
          assert.ok(run.result, 'Simulation must complete');
          assert.deepEqual(run.result, group[0]?.result ?? run.result, 'Result must agree across repeats and speeds');
          group.push(run);
          runs.push(run);
        }
      }
      console.log(JSON.stringify({stats, seed, result:group[0].result, wallMs:group.map(x=>x.wallMs)}));
    }
  }
  await writeFile(new URL('synthetic-results.json', assetDirectory), JSON.stringify({kind:'synthetic-only', runs:runs.length, allResultsAgree:true, results:runs}, null, 2));
  console.log(`PASS: ${runs.length} synthetic runs; repeated results and 1x/100x/1000x results match, including outputCode.`);
} catch (error) {
  console.error(String(error.stack).split('\n').filter(line=>line.length<1000).slice(0,17).join('\n'));
  process.exitCode = 1;
}
