import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PushLevelBattleSimulator } from '../../lib/pushLevelBattleSimulator.js';

function revive(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(revive);
  if (value.__type === 'Map') return new Map(value.value.map(([key, item]) => [revive(key), revive(item)]));
  if (value.__type === 'Set') return new Set(value.value.map(revive));
  if (value.__type === 'Date') return new Date(value.value);
  if (value.__type === 'BigInt') return BigInt(value.value);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, revive(item)]));
}

// BON 的 tag 8 同时表示对象和 Map；当前协议解码器会把两者都输出成普通对象。
function emulateBonDecode(value) {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Map) {
    return Object.fromEntries(Array.from(value, ([key, item]) => [String(key), emulateBonDecode(item)]));
  }
  if (value instanceof Set) return Array.from(value, emulateBonDecode);
  if (Array.isArray(value)) return value.map(emulateBonDecode);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, emulateBonDecode(item)]));
}

function emulateServerBattlePayload(value) {
  const battle = emulateBonDecode(value);
  for (const key of ['mode', 'maxRound', 'outputCode', 'result', 'fightTime', 'statistic', 'leftTeams', 'rightTeams']) {
    delete battle[key];
  }
  for (const team of [battle.leftTeam, battle.rightTeam]) {
    for (const key of ['legionName', 'lordAttackTime', 'attributeBonus', 'teamInfo', 'options', 'name', 'headImg',
      'weaponId', 'weaponActiveLevelId', 'lordSkinId', 'avatarFrame', 'customCard', 'legacyColor', 'petId',
      'petUId', 'petEvo', 'petActiveSkillId']) delete team[key];
  }
  return battle;
}

const samplePath = process.argv[2];
if (!samplePath) throw new Error('Usage: node service-simulator-smoke.mjs <sample.json>');
const sample = JSON.parse(await readFile(resolve(samplePath), 'utf8'));
const simulator = new PushLevelBattleSimulator();
const browserShape = revive(sample.battleData);
await simulator.ready();
let eventLoopTicks = 0;
const heartbeat = setInterval(() => { eventLoopTicks++; }, 50);
let result, bonResult;
try {
  result = await simulator.simulate(browserShape, sample.extend);
  bonResult = await simulator.simulate(emulateServerBattlePayload(browserShape), sample.extend);
} finally {
  clearInterval(heartbeat);
  simulator.close();
}
assert.deepEqual(result.result, sample.browserSimulation.result);
assert.deepEqual(bonResult.result, sample.browserSimulation.result);
assert.ok(eventLoopTicks >= 5, `main event loop was blocked; timer ticked only ${eventLoopTicks} times`);
console.log(JSON.stringify({
  levelId: result.levelId,
  randomSeed: result.randomSeed,
  updates: result.updates,
  realDurationMs: result.realDurationMs,
  bonObjectShape: 'pass',
  eventLoopTicks,
  result: result.result,
}, null, 2));
