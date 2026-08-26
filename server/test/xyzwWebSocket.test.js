import test from 'node:test';
import assert from 'node:assert/strict';

import { XyzwWebSocketClient } from '../lib/xyzwWebSocket.js';

function createClient() {
  return new XyzwWebSocketClient({
    url: 'ws://localhost.invalid',
    utils: { getEnc: () => 'x' },
  });
}

test('ProtoMsg 使用 _raw.seq 更新 ACK', () => {
  const client = createClient();

  client._updateAckFromPacket({ rawData: { ok: true }, _raw: { seq: 41 } });

  assert.equal(client.ack, 41);
});

test('普通消息使用 seq 更新 ACK', () => {
  const client = createClient();

  client._updateAckFromPacket({ seq: 9, body: {} });

  assert.equal(client.ack, 9);
});

test('无服务端序号的消息不会覆盖现有 ACK', () => {
  const client = createClient();
  client.ack = 17;

  client._updateAckFromPacket({ rawData: {} });

  assert.equal(client.ack, 17);
});

test('心跳或旧消息不会让 ACK 回退', () => {
  const client = createClient();
  client.ack = 17;

  client._updateAckFromPacket({ _raw: { seq: 0 } });
  client._updateAckFromPacket({ _raw: { seq: 12 } });

  assert.equal(client.ack, 17);
});
