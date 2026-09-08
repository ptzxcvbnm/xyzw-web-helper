import test from 'node:test';
import assert from 'node:assert/strict';

import { PushLevelService } from '../lib/pushLevelService.js';

const tokenId = 'test-token';

function createPushStub() {
  return {
    log() {},
    broadcast() {},
  };
}

test('每一关提交前都会重新计算战斗时间', async () => {
  const commands = [];
  let service;
  let levelCount = 0;
  const gm = {
    getConnectionStatus: () => 'connected',
    async sendMessageWithPromise(_tokenId, command) {
      commands.push(command);
      if (command === 'fight_calcleveltime') {
        return { battleTime: 0, currLevel: levelCount + 1 };
      }
      levelCount++;
      if (levelCount === 2) service.stop(tokenId);
      return { success: true, nextTime: 0, currLevel: levelCount + 1 };
    },
  };

  service = new PushLevelService(gm, createPushStub());
  service.runners.set(tokenId, {
    running: true,
    tokenId,
    userId: '',
    maxFail: 20,
    reconnectMinutes: 0,
    failStreak: 0,
    passed: 0,
    currLevel: null,
  });

  await service._loop(tokenId);

  assert.deepEqual(commands.slice(0, 4), [
    'fight_calcleveltime',
    'fight_level',
    'fight_calcleveltime',
    'fight_level',
  ]);
});

test('重连倒计时期间连接自行恢复时立即继续', async () => {
  let status = 'disconnected';
  const gm = {
    getConnectionStatus: () => status,
  };
  const service = new PushLevelService(gm, createPushStub());
  const runner = {
    running: true,
    tokenId,
    userId: '',
    reconnectMinutes: 1,
    reconnecting: false,
    reconnectState: null,
    reconnectAt: null,
    lastMsg: '',
  };
  service.runners.set(tokenId, runner);

  setTimeout(() => { status = 'connected'; }, 20);
  const recovered = await service._ensureConnected(tokenId);

  assert.equal(recovered, true);
  assert.equal(runner.reconnecting, false);
  assert.equal(runner.reconnectState, null);
  assert.equal(runner.reconnectAt, null);
});

test('模拟加速会跳过预测失败，只为预测胜局提交 level', async () => {
  const commands = [];
  const simulations = [
    { levelId: 100, realDurationMs: 0, settlementBufferMs: 0, result: { isWin: false } },
    { levelId: 100, realDurationMs: 0, settlementBufferMs: 0, result: { isWin: true } },
  ];
  const gm = {
    getConnectionStatus: () => 'connected',
    async sendMessageWithPromise(_tokenId, command) {
      commands.push(command);
      if (command === 'fight_getlevelbattledata') return { battleData: {}, currLevel: 100 };
      return { success: true, nextTime: 180, currLevel: 101 };
    },
  };
  const simulator = {
    async simulate() { return simulations.shift(); },
  };
  const service = new PushLevelService(gm, createPushStub(), simulator);
  const runner = {
    running: true,
    accelerated: true,
    tokenId,
    userId: '',
    maxFail: 20,
    reconnectMinutes: 0,
    failStreak: 0,
    simulationAttempts: 0,
    passed: 0,
    currLevel: null,
  };
  service.runners.set(tokenId, runner);
  const waits = [];
  service._interruptibleWait = async (_tokenId, ms) => {
    waits.push(ms);
    if (ms === 300 && simulations.length === 0) {
      service.stop(tokenId);
      return 'stopped';
    }
    return 'completed';
  };

  await service._acceleratedLoop(tokenId, runner);

  assert.deepEqual(commands, [
    'fight_getlevelbattledata',
    'fight_getlevelbattledata',
    'fight_level',
  ]);
  assert.equal(runner.simulationAttempts, 2);
  assert.equal(runner.passed, 1);
  assert.equal(runner.failStreak, 0);
  assert.equal(runner.currLevel, 101);
  assert.deepEqual(waits, [300, 0, 300]);
});

test('停止后不会提交尚在计算的预测胜局', async () => {
  const commands = [];
  let releaseSimulation;
  let simulationStarted;
  const started = new Promise(resolve => { simulationStarted = resolve; });
  const gm = {
    getConnectionStatus: () => 'connected',
    async sendMessageWithPromise(_tokenId, command) {
      commands.push(command);
      return { battleData: {}, currLevel: 100 };
    },
  };
  const simulator = {
    simulate() {
      simulationStarted();
      return new Promise(resolve => { releaseSimulation = resolve; });
    },
  };
  const service = new PushLevelService(gm, createPushStub(), simulator);
  const runner = {
    running: true,
    accelerated: true,
    tokenId,
    userId: '',
    maxFail: 20,
    reconnectMinutes: 0,
    failStreak: 0,
    simulationAttempts: 0,
    passed: 0,
    currLevel: null,
  };
  service.runners.set(tokenId, runner);

  const loop = service._acceleratedLoop(tokenId, runner);
  await started;
  service.stop(tokenId);
  releaseSimulation({ levelId: 100, realDurationMs: 0, settlementBufferMs: 0, result: { isWin: true } });
  await loop;

  assert.deepEqual(commands, ['fight_getlevelbattledata']);
  assert.equal(runner.simulationAttempts, 0);
});
