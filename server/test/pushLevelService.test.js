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
