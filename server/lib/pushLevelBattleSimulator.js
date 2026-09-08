import { Worker } from 'node:worker_threads';

export class PushLevelBattleSimulator {
  constructor({
    timeScale = 100,
    stepMs = 20,
    settlementBufferMs = 5000,
    simulationTimeoutMs = 120000,
    requestTimeoutGraceMs = 5000,
    readyTimeoutMs = 60000,
    workerFactory = null,
  } = {}) {
    this.settings = { timeScale, stepMs, settlementBufferMs, simulationTimeoutMs };
    this.requestTimeoutGraceMs = requestTimeoutGraceMs;
    this.readyTimeoutMs = readyTimeoutMs;
    this.workerFactory = workerFactory;
    this.worker = null;
    this.readyPromise = null;
    this.nextRequestId = 1;
    this.pending = new Map();
    this.queue = Promise.resolve();
  }

  async ready() {
    if (!this.readyPromise) {
      this._startWorker();
      this.readyPromise = this._request('ready', { settings: this.settings }, this.readyTimeoutMs).catch(error => {
        this.readyPromise = null;
        this._stopWorker(error);
        throw error;
      });
    }
    return this.readyPromise;
  }

  async simulate(battleData, extend = {}) {
    const task = async () => {
      await this.ready();
      try {
        return await this._request(
          'simulate',
          { battleData, extend },
          this.settings.simulationTimeoutMs + this.requestTimeoutGraceMs,
        );
      } catch (error) {
        this._stopWorker(error);
        throw error;
      }
    };
    const result = this.queue.then(task, task);
    this.queue = result.catch(() => {});
    return result;
  }

  close() {
    this._stopWorker(new Error('Battle simulator closed'));
  }

  _startWorker() {
    if (this.worker) return;
    const worker = this.workerFactory
      ? this.workerFactory()
      : new Worker(new URL('./pushLevelBattleWorker.js', import.meta.url), {
          resourceLimits: {
            maxOldGenerationSizeMb: 384,
            maxYoungGenerationSizeMb: 32,
            codeRangeSizeMb: 64,
            stackSizeMb: 4,
          },
        });
    worker.unref();
    worker.on('message', message => {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
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

  _request(type, payload = {}, timeoutMs = 0) {
    if (!this.worker) return Promise.reject(new Error('Battle simulation worker is not running'));
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const pending = { resolve, reject, timer: null };
      if (timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          if (this.pending.get(id) !== pending) return;
          this._stopWorker(new Error(`Battle simulation ${type} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        pending.timer.unref?.();
      }
      this.pending.set(id, pending);
      try {
        this.worker.postMessage({ id, type, ...payload });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(pending.timer);
        reject(error);
      }
    });
  }

  _stopWorker(error = new Error('Battle simulation worker stopped'), terminate = true) {
    const worker = this.worker;
    this.worker = null;
    this.readyPromise = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    if (worker && terminate) worker.terminate().catch(() => {});
  }
}
