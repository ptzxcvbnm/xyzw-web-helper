import { parentPort } from 'node:worker_threads';

import { createOfflineRuntime, assetLock } from '../experiments/push-level/offline-runtime.mjs';

function serialize(value, seen = new WeakSet()) {
  if (typeof value === 'bigint') return { __type: 'BigInt', value: String(value) };
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) throw new Error('Battle data contains a circular reference');
  seen.add(value);
  try {
    if (value instanceof Map) {
      return { __type: 'Map', value: Array.from(value, ([key, item]) => [serialize(key, seen), serialize(item, seen)]) };
    }
    if (value instanceof Set) return { __type: 'Set', value: Array.from(value, item => serialize(item, seen)) };
    if (value instanceof Date) return { __type: 'Date', value: value.toISOString() };
    if (Array.isArray(value)) return value.map(item => serialize(item, seen));
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, serialize(item, seen)]));
  } finally {
    seen.delete(value);
  }
}

let runtime;
let settings;

async function initialize(nextSettings) {
  if (runtime) return;
  settings = nextSettings;
  runtime = await createOfflineRuntime();
  const info = await runtime.initialize();
  if (info.configCommit !== assetLock.configCommit) {
    throw new Error(`Battle config mismatch: expected ${assetLock.configCommit}, got ${info.configCommit}`);
  }
  return { ...info, assetLock };
}

function simulate(battleData, extend) {
  const payload = {
    battleData: serialize(battleData),
    extend: {
      autoAttack: !!extend.autoAttack,
      autoAttackInterval: Number.isFinite(extend.autoAttackInterval) ? extend.autoAttackInterval : 0.16,
    },
  };
  runtime.context.__pushLevelPayload = JSON.stringify(payload);
  const run = runtime.run(`
    (() => {
      const payload = JSON.parse(__pushLevelPayload);
      delete __pushLevelPayload;
      function revive(value) {
        if (value === null || typeof value !== 'object') return value;
        if (Array.isArray(value)) return value.map(revive);
        if (value.__type === 'Map') return new Map(value.value.map(([key,item]) => [revive(key),revive(item)]));
        if (value.__type === 'Set') return new Set(value.value.map(revive));
        if (value.__type === 'Date') return new Date(value.value);
        if (value.__type === 'BigInt') return BigInt(value.value);
        return Object.fromEntries(Object.entries(value).map(([key,item]) => [key,revive(item)]));
      }
      function mapKey(key) {
        return /^-?(?:0|[1-9]\\d*)$/.test(key) ? Number(key) : key;
      }
      function toMap(value) {
        if (value instanceof Map) return value;
        if (!value || typeof value !== 'object' || Array.isArray(value)) return new Map();
        return new Map(Object.entries(value).map(([key,item]) => [mapKey(key), item]));
      }
      function normalizeTeam(team) {
        if (!team || typeof team !== 'object') return;
        for (const key of ['attributeBonus', 'teamInfo', 'options']) team[key] = toMap(team[key]);
        team.team = toMap(team.team);
        for (const actor of team.team.values()) {
          if (!actor || typeof actor !== 'object') continue;
          actor.attribute = toMap(actor.attribute);
          actor.enchantMap = toMap(actor.enchantMap);
        }
      }
      const data = __require('data-index');
      const rawInput = revive(payload.battleData);
      const input = new data.BattleData();
      const defaultLeftTeam = input.leftTeam;
      const defaultRightTeam = input.rightTeam;
      Object.assign(input, rawInput);
      input.leftTeam = Object.assign(defaultLeftTeam, rawInput.leftTeam || {});
      input.rightTeam = Object.assign(defaultRightTeam, rawInput.rightTeam || {});
      input.options = toMap(input.options);
      normalizeTeam(input.leftTeam);
      normalizeTeam(input.rightTeam);
      if (input.mode !== data.BattleType.level) throw new Error('Expected main-level battle data');
      input.leftTeams = [];
      input.rightTeams = [];
      input.fightTime = 0;
      input.outputCode = {};
      input.statistic = [];
      input.result = new data.BattleResult();
      const factory = new (__require('launcher-server').ServerBattleLauncher)();
      factory.initialize();
      const timeScale = ${JSON.stringify(settings.timeScale)};
      const stepMs = ${JSON.stringify(settings.stepMs)};
      const battle = factory.createBattleById({
        battleData: input,
        timeScale,
        extend: { ...payload.extend, noRender: true, role: new data.GDRole() },
      });
      if (!battle) throw new Error('Could not create main-level battle');
      let battleResult = null;
      battle.BattleResult.add(value => {
        battleResult = {
          isWin: value.isWin,
          round: value.round,
          totalFrame: value.totalFrame,
          inputCode: value.inputCode,
          outputCode: value.outputCode,
        };
      });
      let updates = 0;
      let time = 0;
      const started = Date.now();
      try {
        battle.startBattle();
        while (!battleResult && updates < 20000) {
          battle.update(time);
          time += stepMs;
          updates++;
        }
        if (!battleResult) throw new Error('Battle simulation exceeded the step limit');
        return {
          levelId: input.options.get('levelId'),
          randomSeed: input.randomSeed,
          timeScale,
          stepMs,
          updates,
          wallMs: Date.now() - started,
          realDurationMs: updates * stepMs * timeScale,
          result: battleResult,
        };
      } finally {
        battle.endBattle();
      }
    })()
  `, settings.simulationTimeoutMs);
  return JSON.parse(JSON.stringify({ ...run, settlementBufferMs: settings.settlementBufferMs }));
}

parentPort.on('message', async message => {
  try {
    let result;
    if (message.type === 'ready') result = await initialize(message.settings);
    else if (message.type === 'simulate') {
      if (!runtime) throw new Error('Battle simulation worker is not initialized');
      result = simulate(message.battleData, message.extend || {});
    } else throw new Error(`Unknown worker message: ${message.type}`);
    parentPort.postMessage({ id: message.id, ok: true, result });
  } catch (error) {
    parentPort.postMessage({ id: message.id, ok: false, error: error.message });
  }
});
