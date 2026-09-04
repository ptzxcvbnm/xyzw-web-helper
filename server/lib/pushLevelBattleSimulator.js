import { Worker } from 'node:worker_threads';

export class PushLevelBattleSimulator {
  constructor({ timeScale = 100, stepMs = 20, settlementBufferMs = 5000, simulationTimeoutMs = 120000 } = {}) {
    this.settings = { timeScale, stepMs, settlementBufferMs, simulationTimeoutMs };
    this.worker = null;
    this.readyPromise = null;
    this.nextRequestId = 1;
    this.pending = new Map();
    this.queue = Promise.resolve();
  }

  async ready() {
    if (!this.readyPromise) {
      this._startWorker();
      this.readyPromise = this._request('ready', { settings: this.settings }).catch(error => {
        this.readyPromise = null;
        this._stopWorker();
        throw error;
      });
    }
    return this.readyPromise;
  }

  async simulate(battleData, extend = {}) {
    await this.ready();
    const task = () => this._request('simulate', { battleData, extend });
    const result = this.queue.then(task, task);
    this.queue = result.catch(() => {});
    return result;
  }

  close() {
    this._stopWorker(new Error('Battle simulator closed'));
  }

  _startWorker() {
    if (this.worker) return;
    const worker = new Worker(new URL('./pushLevelBattleWorker.js', import.meta.url));
    worker.unref();
    worker.on('message', message => {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(new Error(message.error || 'Battle simulation worker failed'));
    });
    worker.on('error', error => this._stopWorker(error));
    worker.on('exit', code => {
      if (this.worker === worker) {
        this._stopWorker(new Error(`Battle simulation worker exited (${code})`), false);
      }
    });
    this.worker = worker;
  }

  _request(type, payload = {}) {
    if (!this.worker) return Promise.reject(new Error('Battle simulation worker is not running'));
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.worker.postMessage({ id, type, ...payload });
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  _stopWorker(error = new Error('Battle simulation worker stopped'), terminate = true) {
    const worker = this.worker;
    this.worker = null;
    this.readyPromise = null;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    if (worker && terminate) worker.terminate().catch(() => {});
  }
}
