import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

const source = readFileSync(new URL('../public/game-launcher/src/external-account-login.js', import.meta.url), 'utf8');
function setup(response = { code: 0 }, { serviceReady = true } = {}) {
  const messages = [], requests = [];
  let receive;
  const service = { async authUser(request) { requests.push(request); return response; } };
  let currentService = serviceReady ? service : null;
  const parent = { postMessage(message, origin) { messages.push({ ...message, origin }); } };
  const window = {
    parent, location: { origin: 'https://helper.test' },
    setTimeout,
    addEventListener(name, listener) { assert.equal(name, 'message'); receive = listener; },
    __require(name) { assert.equal(name, 'data-index'); return { LoginService: currentService }; },
  };
  const context = vm.createContext({ window, ArrayBuffer, Uint8Array, TextDecoder, Promise, setTimeout });
  vm.runInContext(source, context);
  window.AuditedAccountLogin.installHooks();
  const send = (payload, origin = window.location.origin, sender = parent) => receive({
    origin, source: sender, data: { type: 'xyzw-game-account', bin: new TextEncoder().encode(JSON.stringify(payload)).buffer },
  });
  return {
    window, requests, messages, send, service,
    makeServiceReady() { currentService = service; },
  };
}
const account = { info: { uid: 'test-only' }, platform: 'hortor', platformExt: 'mix', serverId: 123 };

test('waits for the parent-selected account and patches only login fields', async () => {
  const app = setup();
  const result = app.service.authUser({ platform: 'old', extra: true });
  app.send(account, 'https://wrong.test');
  app.send(account, undefined, {});
  await Promise.resolve();
  assert.equal(app.requests.length, 0);
  app.send(account);
  await result;
  assert.equal(app.requests.length, 1);
  assert.equal(app.requests[0].info, JSON.stringify(account.info));
  assert.equal(app.requests[0].serverId, '123');
  assert.equal(app.requests[0].extra, true);
  assert.ok(app.messages.some(message => message.event === 'account-login-success'));
  assert.ok(app.messages.every(message => !('bin' in message) && !('info' in message)));
});

test('duplicate handshakes cannot switch the active account', async () => {
  const app = setup();
  app.send(account);
  app.send({ ...account, serverId: 999 });
  app.window.AuditedAccountLogin.installHooks();
  await app.service.authUser({});
  assert.equal(app.requests.length, 1);
  assert.equal(app.requests[0].serverId, '123');
});

test('invalid credentials fail without calling the game authentication service', async () => {
  const app = setup();
  const result = app.service.authUser({});
  app.send({ info: 'missing-platform' });
  await assert.rejects(result, /登录数据无效/);
  assert.equal(app.requests.length, 0);
  assert.ok(app.messages.some(message => message.event === 'account-data-invalid'));
});

test('game rejection is reported as failure', async () => {
  const app = setup({ code: 401 });
  app.send(account);
  await app.service.authUser({});
  assert.ok(app.messages.some(message => message.event === 'account-login-failed'));
  assert.ok(!app.messages.some(message => message.event === 'account-login-success'));
});

test('hooks the authentication service when the game exposes it after startup', async () => {
  const app = setup({ code: 0 }, { serviceReady: false });
  app.send(account);
  app.makeServiceReady();
  await new Promise(resolve => setTimeout(resolve, 150));
  await app.service.authUser({ scene: 0 });
  assert.equal(app.requests.length, 1);
  assert.equal(app.requests[0].info, JSON.stringify(account.info));
  assert.ok(app.messages.some(message => message.event === 'account-login-success'));
});
