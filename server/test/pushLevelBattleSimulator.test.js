import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { PushLevelBattleSimulator } from '../lib/pushLevelBattleSimulator.js';

class FakeWorker extends EventEmitter {
  constructor({ hangSimulation = false } = {}) {
    super();
    this.hangSimulation = hangSimulation;
    this.terminated = false;
  }

  unref() {}

  postMessage(message) {
    if (message.type === 'ready') {
      queueMicrotask(() => this.emit('message', { id: message.id, ok: true, result: { ready: true } }));
      return;
    }
    if (message.type === 'simulate' && !this.hangSimulation) {
      queueMicrotask(() => this.emit('message', { id: message.id, ok: true, result: { result: { isWin: true } } }));
    }
  }

  async terminate() {
    this.terminated = true;
    return 0;
  }
}

test('模拟硬超时会销毁工作线程，下一次请求会自动重建', async () => {
  const workers = [];
  const simulator = new PushLevelBattleSimulator({
    simulationTimeoutMs: 10,
    requestTimeoutGraceMs: 10,
    readyTimeoutMs: 100,
    workerFactory() {
      const worker = new FakeWorker({ hangSimulation: workers.length === 0 });
      workers.push(worker);
      return worker;
    },
  });

  await assert.rejects(
    simulator.simulate({}),
    /Battle simulation simulate timed out after 20ms/,
  );
  assert.equal(workers[0].terminated, true);
  assert.equal(simulator.worker, null);

  const result = await simulator.simulate({});
  assert.equal(result.result.isWin, true);
  assert.equal(workers.length, 2);
  simulator.close();
});
