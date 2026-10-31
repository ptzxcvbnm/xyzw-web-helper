import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { pushLevelRoutes } from '../routes/pushLevel.js';

test('推关接口拒绝其他用户账号，并过滤状态和历史日志', async t => {
  const tokens = [{ id: 'mine' }, { id: 'other' }];
  const calls = [];
  const db = {
    getAllTokens: user => tokens.filter(token => (user === 'alice' ? token.id === 'mine' : token.id === 'other')),
    getToken: (id, user) => db.getAllTokens(user).find(token => token.id === id),
  };
  const service = {
    start: async (...args) => { calls.push(args); return { ok: true }; },
    stop: () => { calls.push('stop'); return { ok: true }; },
    useTorch: async () => { calls.push('torch'); return { ok: true }; },
    getStatus: id => ({ running: true, id }),
    getAllStatus: ids => Object.fromEntries(tokens.filter(token => ids.has(token.id)).map(token => [token.id, { running: true }])),
    getLogs: ids => tokens.filter(token => ids.has(token.id)).map(token => ({ tokenId: token.id, message: 'log' })),
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.userId = 'alice'; next(); });
  app.use('/push-level', pushLevelRoutes(service, db));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/push-level`;
  const post = (path, body) => fetch(base + path, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  for (const path of ['/start', '/stop', '/torch']) {
    assert.equal((await post(path, { tokenId: 'other', itemId: 1008, quantity: 1 })).status, 404);
  }
  assert.equal((await fetch(base + '/status/other')).status, 404);
  assert.equal((await post('/start', {})).status, 400);
  assert.equal(calls.length, 0);
  const status = await (await fetch(base + '/status')).json();
  assert.deepEqual(Object.keys(status), ['mine']);
  assert.deepEqual(await (await fetch(base + '/logs')).json(), [{ tokenId: 'mine', message: 'log' }]);
  assert.equal((await post('/start', { tokenId: 'mine', accelerated: true, autoContinue: false, maxFail: 30, reconnectMinutes: 5 })).status, 200);
  assert.deepEqual(calls[0], ['mine', 'alice', { accelerated: true, autoContinue: false, maxFail: 30, reconnectMinutes: 5 }]);
  assert.equal((await post('/stop', { tokenId: 'mine' })).status, 200);
  assert.equal((await post('/torch', { tokenId: 'mine', itemId: 1008, quantity: 1 })).status, 200);
});
