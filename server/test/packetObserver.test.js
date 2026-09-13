import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const observerSource = await readFile(
  new URL('../../public/game-launcher/src/packet-observer.js', import.meta.url),
  'utf8',
);

class FakeEventTarget {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emit(type, event = {}) {
    for (const listener of this.listeners.get(type) || []) listener.call(this, event);
  }
}

class FakeWebSocket extends FakeEventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(url, protocols) {
    super();
    this.url = url;
    this.protocols = protocols;
    this.sent = [];
  }

  send(data) {
    this.sent.push(data);
  }
}

function createBrowser(search = '?slot=1&parentOrigin=https%3A%2F%2Fhelper.test&packetObserver=0') {
  const posted = [];
  const parent = { postMessage: (payload, origin) => posted.push({ payload, origin }) };
  const windowTarget = new FakeEventTarget();
  const window = {
    WebSocket: FakeWebSocket,
    URL,
    ArrayBuffer,
    Blob,
    WeakMap,
    Object,
    Number,
    String,
    Date,
    Promise,
    decodeURIComponent,
    location: { href: `https://helper.test/game-launcher/game.html${search}`, search },
    parent,
    addEventListener: windowTarget.addEventListener.bind(windowTarget),
  };
  window.window = window;
  vm.runInNewContext(observerSource, window, { filename: 'packet-observer.js' });
  return { window, parent, posted, windowTarget };
}

test('观察器默认关闭，开启后只读转发游戏 WebSocket 报文', () => {
  const { window, parent, posted, windowTarget } = createBrowser();
  const ready = posted.find((entry) => entry.payload.event === 'packet-observer-ready');
  assert.equal(ready.payload.enabled, false);

  const gameSocket = new window.WebSocket('wss://xxz-xyzw.hortorgames.com/agent?p=secret-token');
  const ignoredSocket = new window.WebSocket('wss://example.com/socket?token=secret');
  const beforeEnable = new Uint8Array([1, 2, 3]).buffer;
  gameSocket.send(beforeEnable);
  assert.equal(gameSocket.sent[0], beforeEnable);
  assert.equal(posted.some((entry) => entry.payload.event === 'packet-observer-frame'), false);

  windowTarget.emit('message', {
    source: parent,
    origin: 'https://helper.test',
    data: { type: 'audited-instance-command', command: 'packet-observer', value: true },
  });

  const outgoing = new Uint8Array([4, 5, 6]).buffer;
  gameSocket.send(outgoing);
  ignoredSocket.send(new Uint8Array([7]).buffer);
  gameSocket.emit('message', { data: new Uint8Array([8, 9]).buffer });

  const frames = posted.filter((entry) => entry.payload.event === 'packet-observer-frame');
  assert.equal(frames.length, 2);
  assert.deepEqual(frames.map((entry) => entry.payload.direction), ['send', 'receive']);
  assert.equal(frames[0].payload.target, 'wss://xxz-xyzw.hortorgames.com/agent');
  assert.equal(frames[0].payload.target.includes('secret-token'), false);
  assert.deepEqual(Array.from(new Uint8Array(frames[0].payload.payload)), [4, 5, 6]);
  assert.equal(gameSocket.sent[1], outgoing);
});

test('通过启动参数启用后可捕获第一条报文', () => {
  const { window, posted } = createBrowser(
    '?slot=1&parentOrigin=https%3A%2F%2Fhelper.test&packetObserver=1',
  );
  const socket = new window.WebSocket('wss://xxz-xyzw.hortorgames.com/agent?p=hidden');
  socket.send('hello');

  const frame = posted.find((entry) => entry.payload.event === 'packet-observer-frame');
  assert.equal(frame.payload.kind, 'text');
  assert.equal(frame.payload.payload, 'hello');
});
