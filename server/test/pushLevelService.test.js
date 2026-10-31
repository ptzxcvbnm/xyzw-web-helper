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
    { levelId: 100, bossName: '测试BOSS', realDurationMs: 0, settlementBufferMs: 0, result: { isWin: false } },
    { levelId: 100, bossName: '测试BOSS', realDurationMs: 0, settlementBufferMs: 0, result: { isWin: true } },
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
  // 进入下一关后不沿用上一关的 BOSS，界面按当前关卡映射名称。
  assert.equal(service.getStatus(tokenId).bossName, null);
  assert.equal(runner.predictedLosses, 1);
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

test('启动期间去重，取消的旧启动不会覆盖新任务', async () => {
  let releaseReady;
  const simulator = { ready: () => new Promise(resolve => { releaseReady = resolve; }) };
  const gm = { getConnectionStatus: () => 'connected' };
  const service = new PushLevelService(gm, createPushStub(), simulator);
  service._loop = async () => {};
  const pending = service.start(tokenId, 'user', { accelerated: true });
  assert.equal(service.getStatus(tokenId).phase, 'starting');
  assert.equal((await service.start(tokenId, 'user')).ok, false);
  service.stop(tokenId);
  assert.equal((await service.start(tokenId, 'user', { maxFail: 2000 })).ok, true);
  const replacement = service.runners.get(tokenId);
  releaseReady();
  assert.equal((await pending).msg, '启动已取消');
  assert.equal(service.runners.get(tokenId), replacement);
  assert.equal(service.getStatus(tokenId).running, true);
  assert.equal(service.getStatus(tokenId).maxFail, 2000);
  service.stopAll();
});

test('普通推关停止后重启，旧 calc 响应不能为新任务提交结算', async () => {
  let releaseCalc;
  const commands = [];
  const gm = {
    getConnectionStatus: () => 'connected',
    sendMessageWithPromise(_id, command) {
      commands.push(command);
      return new Promise(resolve => { releaseCalc = resolve; });
    },
  };
  const service = new PushLevelService(gm, createPushStub());
  const old = { running: true, currLevel: 100 };
  service.runners.set(tokenId, old);
  const loop = service._legacyLoop(tokenId, old);
  service.stop(tokenId);
  const replacement = { running: true, currLevel: 200 };
  service.runners.set(tokenId, replacement);
  releaseCalc({ battleTime: 0, currLevel: 101 });
  await loop;
  assert.deepEqual(commands, ['fight_calcleveltime']);
  assert.equal(replacement.currLevel, 200);
  assert.equal(replacement.running, true);
});

test('关闭自动继续后，普通推关在第一次成功结算后停止', async () => {
  const commands = [];
  const gm = {
    getConnectionStatus: () => 'connected',
    async sendMessageWithPromise(_id, command) {
      commands.push(command);
      return command === 'fight_calcleveltime'
        ? { body: { battleTime: 0, currLevel: 100 } }
        : { body: { success: 1, currLevel: 101, nextTime: 180 } };
    },
  };
  const service = new PushLevelService(gm, createPushStub());
  const runner = { running: true, passed: 0, failStreak: 0, maxFail: 20, autoContinue: false };
  service.runners.set(tokenId, runner);
  await service._legacyLoop(tokenId, runner);
  assert.deepEqual(commands, ['fight_calcleveltime', 'fight_level']);
  assert.equal(runner.passed, 1);
  assert.equal(runner.running, false);
  assert.equal(runner.stopReason, '单次推关完成');
});

test('普通模式到达连败上限后停止，并单独统计结算失败', async () => {
  const gm = {
    getConnectionStatus: () => 'connected',
    async sendMessageWithPromise(_id, command) {
      return command === 'fight_calcleveltime'
        ? { battleTime: 0, currLevel: 100 }
        : { success: false, currLevel: 100, nextTime: 0 };
    },
  };
  const service = new PushLevelService(gm, createPushStub());
  const runner = { running: true, passed: 0, failStreak: 0, maxFail: 2 };
  service.runners.set(tokenId, runner);
  await service._legacyLoop(tokenId, runner);
  assert.equal(runner.running, false);
  assert.equal(runner.losses, 2);
  assert.equal(runner.failStreak, 2);
});

test('等待状态有可恢复倒计时，掉线且重连为0时不再结算', async () => {
  let status = 'connected';
  const service = new PushLevelService({ getConnectionStatus: () => status }, createPushStub());
  const runner = { running: true, phase: 'battle', reconnectMinutes: 0 };
  service.runners.set(tokenId, runner);
  const wait = service._interruptibleWait(tokenId, 60000, runner);
  const snapshot = service.getStatus(tokenId);
  assert.ok(snapshot.waitUntil > Date.now());
  assert.equal(snapshot.waitDurationMs, 60000);
  status = 'disconnected';
  assert.equal(await wait, 'stopped');
  assert.equal(runner.running, false);
  assert.equal(service.getStatus(tokenId).waitUntil, null);
});

test('使用火把不关闭连接，参数受限，成功消费后刷新失败仍报告已使用', async () => {
  const commands = [];
  const gm = {
    getConnectionStatus: () => 'connected',
    disconnect() { assert.fail('火把不应关闭推关连接'); },
    async sendMessageWithPromise(_id, command, params) {
      commands.push({ command, params });
      if (command === 'role_getroleinfo') return { body: { role: { autoClickType: 1008, autoClickTime: 3600 } } };
      return {};
    },
  };
  const service = new PushLevelService(gm, createPushStub());
  service.runners.set(tokenId, { running: true });
  assert.equal((await service.useTorch(tokenId, 999, 1)).ok, false);
  assert.equal((await service.useTorch(tokenId, 1008, 0)).ok, false);
  assert.equal(commands.length, 0);
  assert.equal((await service.useTorch(tokenId, 1008, 2)).ok, true);
  assert.deepEqual(commands, [
    { command: 'item_consume', params: { itemId: 1008, quantity: 2 } },
    { command: 'role_getroleinfo', params: {} },
  ]);
  assert.equal(service.getStatus(tokenId).torch.type, 1008);
  assert.ok(service.getStatus(tokenId).torch.expiresAt > Date.now() + 3500000);
  gm.sendMessageWithPromise = async (_id, command) => {
    if (command === 'role_getroleinfo') throw new Error('读取超时');
    return {};
  };
  assert.equal((await service.useTorch(tokenId, 1008, 1)).ok, true);
});

test('运行状态与日志可按账号范围恢复，推送与历史使用相同日志ID', () => {
  let pushed;
  const service = new PushLevelService({}, { broadcast() {}, log(_id, _level, _message, extra) { pushed = extra; } });
  service.runners.set('mine', { running: true });
  service.runners.set('other', { running: true });
  service._log('other', 'info', '其他用户');
  service._log('mine', 'info', '我的日志');
  const ids = new Set(['mine']);
  assert.deepEqual(Object.keys(service.getAllStatus(ids)), ['mine']);
  assert.equal(service.getLogs(ids).length, 1);
  assert.equal(service.getLogs(ids)[0].message, '我的日志');
  assert.equal(service.getLogs(ids)[0].id, pushed.id);
  assert.equal(pushed.source, 'pushLevel');
});

test('连接中的启动被停止后不再重试，并阻止旧连接覆盖新任务', async () => {
  let connectionStarted;
  let releaseConnection;
  let status = 'disconnected';
  let attempts = 0;
  const started = new Promise(resolve => { connectionStarted = resolve; });
  const gm = {
    getConnectionStatus: () => status,
    disconnect() { status = 'disconnected'; },
    async connect() {
      attempts++;
      connectionStarted();
      await new Promise(resolve => { releaseConnection = resolve; });
      status = 'connected';
    },
  };
  const service = new PushLevelService(gm, createPushStub());
  service._loop = async () => {};
  const pending = service.start(tokenId, 'user');
  await started;
  service.stop(tokenId);
  assert.equal((await service.start(tokenId, 'user')).ok, false);
  releaseConnection();
  assert.equal((await pending).msg, '启动已取消');
  assert.equal(attempts, 1);
  assert.equal((await service.start(tokenId, 'user')).ok, true);
  service.stopAll();
});
