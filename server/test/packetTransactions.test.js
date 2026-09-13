import test from 'node:test';
import assert from 'node:assert/strict';

import { pairObservedPacket, redactSensitive } from '../../src/utils/packetTransactions.js';

function packet(overrides) {
  return {
    key: 'packet',
    connectionId: 1,
    direction: 'send',
    seq: null,
    resp: null,
    capturedAt: 1000,
    response: null,
    requestKey: null,
    rtt: null,
    ...overrides,
  };
}

test('按同一连接的 seq 和 resp 配对并计算耗时', () => {
  const request = packet({ key: 'request', seq: 12 });
  const response = packet({
    key: 'response',
    direction: 'receive',
    seq: 30,
    resp: 12,
    capturedAt: 1075,
  });
  const entries = [response, request];

  pairObservedPacket(entries, response);

  assert.equal(request.response, response);
  assert.equal(response.requestKey, 'request');
  assert.equal(request.rtt, 75);
});

test('响应先到达观察列表时仍能在请求加入后配对', () => {
  const response = packet({ key: 'response', direction: 'receive', resp: 7, capturedAt: 2050 });
  const request = packet({ key: 'request', seq: 7, capturedAt: 2000 });
  const entries = [request, response];

  pairObservedPacket(entries, request);

  assert.equal(request.response, response);
  assert.equal(response.requestKey, 'request');
  assert.equal(request.rtt, 50);
});

test('不同连接即使序号相同也不会错误配对', () => {
  const request = packet({ key: 'request', connectionId: 1, seq: 9 });
  const response = packet({ key: 'response', connectionId: 2, direction: 'receive', resp: 9 });

  pairObservedPacket([response, request], response);

  assert.equal(request.response, null);
  assert.equal(response.requestKey, null);
});

test('导出数据递归脱敏但保留普通业务字段', () => {
  const result = redactSensitive({
    roleInfo: { level: 88 },
    accessToken: 'secret-token',
    nested: { password: 'secret-password', rewardId: 3 },
  });

  assert.deepEqual(result, {
    roleInfo: { level: 88 },
    accessToken: '[已脱敏]',
    nested: { password: '[已脱敏]', rewardId: 3 },
  });
});
