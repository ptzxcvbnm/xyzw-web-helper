import { gameLogger } from './logger.js';

function pick(resp, name) {
  if (!resp || typeof resp !== 'object') return undefined;
  if (resp[name] !== undefined) return resp[name];
  for (const key of ['body', '_rawData', 'rawData', 'decodedBody', 'data']) {
    if (resp[key]?.[name] !== undefined) return resp[key][name];
  }
  if (typeof resp.getData === 'function') {
    try { return resp.getData()?.[name]; } catch {}
  }
  return undefined;
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * 主线任务始终在服务器运行，页面只提交控制请求并订阅状态。
 * 普通模式重新 calc 后按服务器时间结算；模拟模式跳过预测失败局，
 * 预测胜局保留同一局并等待正常时长后结算。
 */
export class PushLevelService {
  constructor(gameManager, pushService, battleSimulator = null) {
    this.gm = gameManager;
    this.push = pushService;
    this.battleSimulator = battleSimulator;
    this.runners = new Map();
    this.logs = [];
    this.logSequence = 0;
    this.logPrefix = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    this.torchBusy = new Set();
    this.startingConnections = new Set();
  }

  isRunning(tokenId) {
    return !!this.runners.get(tokenId)?.running;
  }

  getStatus(tokenId) {
    const r = this.runners.get(tokenId);
    if (!r) return { running: false };
    const cached = this.gm.gameData?.get(tokenId);
    if (cached?.roleInfo && r.torchRoleInfo !== cached.roleInfo) {
      this._applyTorchInfo(r, cached.roleInfo, Date.parse(cached.lastUpdated) || Date.now());
    }
    return {
      running: r.running,
      phase: r.phase || null,
      currLevel: r.currLevel,
      bossName: r.bossName || null,
      passed: r.passed || 0,
      losses: r.losses || 0,
      predictedLosses: r.predictedLosses || 0,
      failStreak: r.failStreak,
      maxFail: r.maxFail,
      autoContinue: r.autoContinue !== false,
      reconnectMinutes: r.reconnectMinutes,
      reconnecting: !!r.reconnecting,
      reconnectState: r.reconnectState || null,
      reconnectAt: r.reconnectAt ? new Date(r.reconnectAt).toISOString() : null,
      waitUntil: r.waitUntil || null,
      waitDurationMs: r.reconnecting ? r.reconnectMinutes * 60000 : r.waitDurationMs || 0,
      accelerated: !!r.accelerated,
      simulationAttempts: r.simulationAttempts || 0,
      torch: r.torch || null,
      startedAt: r.startedAt,
      lastMsg: r.lastMsg,
      stopReason: r.stopReason || null,
    };
  }

  getAllStatus(tokenIds) {
    const out = {};
    for (const [id] of this.runners) {
      if (!tokenIds || tokenIds.has(id)) out[id] = this.getStatus(id);
    }
    return out;
  }

  getLogs(tokenIds) {
    return this.logs.filter(log => !tokenIds || tokenIds.has(log.tokenId));
  }

  async start(tokenId, userId, options = {}) {
    if (this.startingConnections.has(tokenId)) return { ok: false, msg: '上一次账号连接尚未结束，请稍后重试' };
    if (this.isRunning(tokenId)) return { ok: false, msg: '该账号已在推关中' };
    const r = {
      running: true, phase: 'starting', tokenId, userId: userId || '',
      maxFail: Math.min(999999, Math.max(1, parseInt(options.maxFail) || 20)),
      reconnectMinutes: Math.min(1440, Math.max(0, parseInt(options.reconnectMinutes) || 0)),
      autoContinue: options.autoContinue !== false,
      accelerated: options.accelerated === true,
      reconnecting: false, reconnectState: null, reconnectAt: null,
      simulationAttempts: 0, predictedLosses: 0, failStreak: 0, losses: 0, passed: 0,
      currLevel: null, bossName: null, errorStreak: 0,
      startedAt: new Date().toISOString(), lastMsg: '正在启动', stopReason: null,
    };
    // 在第一个 await 之前占用账号，防止连续点击或多个页面启动重复循环。
    this.runners.set(tokenId, r);
    this._broadcast(tokenId);
    try {
      if (r.accelerated) {
        if (!this.battleSimulator) throw new Error('模拟加速器未配置');
        try { await this.battleSimulator.ready(); }
        catch (error) { throw new Error('模拟加速器不可用: ' + error.message); }
        if (!this._isCurrentRunner(tokenId, r)) return { ok: false, msg: '启动已取消' };
      }
      if (this.gm.getConnectionStatus(tokenId) !== 'connected') {
        r.lastMsg = '账号未连接，正在连接...';
        this._log(tokenId, 'info', r.lastMsg);
        this._broadcast(tokenId);
        await this._connectForStart(tokenId, r);
        if (!this._isCurrentRunner(tokenId, r)) return { ok: false, msg: '启动已取消' };
        if (this.gm.getConnectionStatus(tokenId) !== 'connected') throw new Error('账号连接失败');
      }
    } catch (error) {
      if (this._isCurrentRunner(tokenId, r)) this._stopInternal(tokenId, error.message, r);
      return { ok: false, msg: error.message };
    }
    if (!this._isCurrentRunner(tokenId, r)) return { ok: false, msg: '启动已取消' };
    const policy = r.reconnectMinutes === 0 ? '掉线自动停止' : `掉线后等待${r.reconnectMinutes}分钟再重连`;
    r.lastMsg = '已启动';
    this._log(tokenId, 'info', `开始推关（${r.accelerated ? '模拟加速' : '服务器计时'}，连续失败${r.maxFail}次自动停止，${policy}）`);
    this._broadcast(tokenId);
    this._loop(tokenId, r).catch(error => {
      if (this._isCurrentRunner(tokenId, r)) this._stopInternal(tokenId, '循环异常: ' + error.message, r);
    });
    return { ok: true, msg: '已开始后台推关' };
  }

  stop(tokenId) {
    const r = this.runners.get(tokenId);
    if (!r?.running) return { ok: false, msg: '该账号未在推关' };
    this._stopInternal(tokenId, '手动停止', r);
    return { ok: true, msg: '已停止' };
  }

  stopAll() {
    for (const [id, r] of this.runners) if (r.running) this._stopInternal(id, '全部停止', r);
  }

  _stopInternal(tokenId, reason, r = this.runners.get(tokenId)) {
    if (!r || this.runners.get(tokenId) !== r) return;
    Object.assign(r, { running: false, phase: 'stopped', reconnecting: false, reconnectState: null,
      reconnectAt: null, waitUntil: null, waitDurationMs: 0, stopReason: reason, lastMsg: '已停止: ' + reason });
    this._log(tokenId, 'info', '推关停止: ' + reason);
    this._broadcast(tokenId);
  }

  _applyLevel(r, level, bossName) {
    if (level != null && level !== r.currLevel) {
      r.currLevel = level;
      r.bossName = null;
    }
    if (bossName) r.bossName = bossName;
  }

  async _loop(tokenId, r = this.runners.get(tokenId)) {
    if (!r) return;
    return r.accelerated ? this._acceleratedLoop(tokenId, r) : this._legacyLoop(tokenId, r);
  }

  async _legacyLoop(tokenId, r = this.runners.get(tokenId)) {
    while (this._isCurrentRunner(tokenId, r)) {
      let waitSec;
      try {
        r.phase = 'calculating';
        this._broadcast(tokenId);
        const response = await this.gm.sendMessageWithPromise(tokenId, 'fight_calcleveltime', {}, 8000);
        if (!this._isCurrentRunner(tokenId, r)) return;
        this._applyLevel(r, pick(response, 'currLevel'), pick(response, 'bossName'));
        const battleTime = pick(response, 'battleTime');
        if (typeof battleTime !== 'number' || !Number.isFinite(battleTime)) {
          this._stopInternal(tokenId, 'battleTime为空或无效', r);
          return;
        }
        waitSec = Math.min(300, battleTime < 0 ? 30 : battleTime);
      } catch (error) {
        if (!await this._handleError(tokenId, r, '计算战斗时间失败', error)) return;
        continue;
      }
      r.phase = 'battle';
      r.lastMsg = `第${r.currLevel || '?'}关 战斗中(${waitSec}s)`;
      const waited = await this._interruptibleWait(tokenId, waitSec * 1000, r);
      if (waited === 'stopped') return;
      if (waited === 'reconnected') continue;
      r.phase = 'settling';
      this._broadcast(tokenId);
      let response;
      try {
        response = await this.gm.sendMessageWithPromise(tokenId, 'fight_level', {}, 8000);
      } catch (error) {
        if (!await this._handleError(tokenId, r, '关卡结算失败', error)) return;
        continue;
      }
      if (!this._isCurrentRunner(tokenId, r)) return;
      if (!this._settle(tokenId, r, response)) return;
      r.phase = 'interval';
      const nextTime = pick(response, 'nextTime');
      const nextSec = typeof nextTime === 'number' && Number.isFinite(nextTime) && nextTime >= 0 ? nextTime : 2;
      if (await this._interruptibleWait(tokenId, Math.min(nextSec, 300) * 1000, r) === 'stopped') return;
    }
  }

  async _acceleratedLoop(tokenId, r = this.runners.get(tokenId)) {
    if (!this.battleSimulator) return;
    while (this._isCurrentRunner(tokenId, r)) {
      let battleData, issuedAt;
      try {
        r.phase = 'simulating';
        r.lastMsg = '正在获取并模拟当前关卡战斗';
        this._broadcast(tokenId);
        issuedAt = Date.now();
        const response = await this.gm.sendMessageWithPromise(tokenId, 'fight_getlevelbattledata', {}, 8000);
        if (!this._isCurrentRunner(tokenId, r)) return;
        this._applyLevel(r, pick(response, 'currLevel'), pick(response, 'bossName'));
        battleData = pick(response, 'battleData');
        if (!battleData) {
          this._stopInternal(tokenId, '服务器未返回主线战斗数据', r);
          return;
        }
      } catch (error) {
        if (!await this._handleError(tokenId, r, '获取主线战斗数据失败', error)) return;
        continue;
      }
      let simulation;
      try {
        simulation = await this.battleSimulator.simulate(battleData, { autoAttack: false, autoAttackInterval: 0.16 });
      } catch (error) {
        if (this._isCurrentRunner(tokenId, r)) this._stopInternal(tokenId, '本地战斗模拟失败: ' + error.message, r);
        return;
      }
      if (!this._isCurrentRunner(tokenId, r)) return;
      // 排队计算期间连接可能已断开；换连接后不能提交旧连接签发的胜局。
      if (this.gm.getConnectionStatus(tokenId) !== 'connected') {
        if (!await this._recoverConnectionOrStop(tokenId, r)) return;
        continue;
      }
      r.simulationAttempts = (r.simulationAttempts || 0) + 1;
      this._applyLevel(r, simulation.levelId, simulation.bossName);
      if (!simulation.result?.isWin) {
        r.predictedLosses = (r.predictedLosses || 0) + 1;
        r.failStreak++;
        r.lastMsg = `预测失败 第${r.currLevel || '?'}关，立即换局 (${r.failStreak}/${r.maxFail})`;
        this._log(tokenId, 'warn', r.lastMsg);
        this._broadcast(tokenId);
        if (r.failStreak >= r.maxFail) {
          this._stopInternal(tokenId, `连续预测失败${r.maxFail}次`, r);
          return;
        }
        r.phase = 'interval';
        if (await this._interruptibleWait(tokenId, 300, r) === 'stopped') return;
        continue;
      }
      const elapsedMs = Date.now() - issuedAt;
      const waitMs = Math.max(0, simulation.realDurationMs + simulation.settlementBufferMs - elapsedMs);
      r.phase = 'battle';
      r.lastMsg = `预测胜利 第${r.currLevel || '?'}关，保留本局等待${Math.ceil(waitMs / 1000)}秒结算`;
      this._log(tokenId, 'info', r.lastMsg);
      const waited = await this._interruptibleWait(tokenId, waitMs, r);
      if (waited === 'stopped' || !this._isCurrentRunner(tokenId, r)) return;
      if (waited === 'reconnected') continue;
      r.phase = 'settling';
      this._broadcast(tokenId);
      let response;
      try {
        response = await this.gm.sendMessageWithPromise(tokenId, 'fight_level', {}, 8000);
      } catch (error) {
        if (!await this._handleError(tokenId, r, '胜局结算失败', error)) return;
        continue;
      }
      if (!this._isCurrentRunner(tokenId, r)) return;
      if (!this._settle(tokenId, r, response)) return;
      // nextTime 已包含下一局战斗时间，不与下一次模拟等待重复。
      r.phase = 'interval';
      if (await this._interruptibleWait(tokenId, 300, r) === 'stopped') return;
    }
  }

  _settle(tokenId, r, response) {
    this._applyLevel(r, pick(response, 'currLevel'), pick(response, 'bossName'));
    r.errorStreak = 0;
    const success = pick(response, 'success');
    if (success === true || success === 1) {
      r.passed++;
      r.failStreak = 0;
      r.lastMsg = `过关 -> 第${r.currLevel}关 (累计${r.passed})`;
      this._log(tokenId, 'success', r.lastMsg);
      if (r.autoContinue === false) {
        this._stopInternal(tokenId, '单次推关完成', r);
        return false;
      }
    } else {
      r.losses = (r.losses || 0) + 1;
      r.failStreak++;
      r.lastMsg = `结算失败 第${r.currLevel}关 (连续${r.failStreak}/${r.maxFail})`;
      this._log(tokenId, 'warn', r.lastMsg);
      if (r.failStreak >= r.maxFail) {
        this._stopInternal(tokenId, `连续失败${r.maxFail}次`, r);
        return false;
      }
    }
    this._broadcast(tokenId);
    return true;
  }

  _isCurrentRunner(tokenId, r) {
    return !!r?.running && this.runners.get(tokenId) === r;
  }

  async _handleError(tokenId, r, label, error) {
    if (!this._isCurrentRunner(tokenId, r)) return false;
    r.lastMsg = label + ': ' + error.message;
    this._log(tokenId, 'error', r.lastMsg);
    r.errorStreak = (r.errorStreak || 0) + 1;
    if (r.errorStreak >= 5) {
      this._stopInternal(tokenId, '连续请求异常5次: ' + error.message, r);
      return false;
    }
    if (!await this._recoverConnectionOrStop(tokenId, r)) return false;
    return await this._interruptibleWait(tokenId, 1000, r) !== 'stopped';
  }

  async _interruptibleWait(tokenId, ms, r = this.runners.get(tokenId)) {
    if (!this._isCurrentRunner(tokenId, r)) return 'stopped';
    r.waitDurationMs = ms;
    r.waitUntil = Date.now() + ms;
    this._broadcast(tokenId);
    try {
      while (this._isCurrentRunner(tokenId, r)) {
        if (this.gm.getConnectionStatus(tokenId) !== 'connected') {
          return await this._recoverConnectionOrStop(tokenId, r) ? 'reconnected' : 'stopped';
        }
        const remaining = r.waitUntil - Date.now();
        if (remaining <= 0) return 'completed';
        await sleep(Math.min(500, remaining));
      }
      return 'stopped';
    } finally {
      r.waitUntil = null;
      r.waitDurationMs = 0;
    }
  }

  async _recoverConnectionOrStop(tokenId, r = this.runners.get(tokenId)) {
    if (!this._isCurrentRunner(tokenId, r)) return false;
    if (await this._ensureConnected(tokenId, r)) return this._isCurrentRunner(tokenId, r);
    if (!this._isCurrentRunner(tokenId, r)) return false;
    this._stopInternal(tokenId, r.reconnectMinutes === 0
      ? '账号掉线，已按设置自动停止' : `掉线后等待${r.reconnectMinutes}分钟，重连失败`, r);
    return false;
  }

  async _ensureConnected(tokenId, r = this.runners.get(tokenId)) {
    if (!this._isCurrentRunner(tokenId, r)) return false;
    if (this.gm.getConnectionStatus(tokenId) === 'connected') return true;
    if (r.reconnectMinutes === 0) return false;
    r.reconnectAt = Date.now() + r.reconnectMinutes * 60000;
    r.reconnecting = true;
    r.reconnectState = 'waiting';
    this._log(tokenId, 'warn', `检测到掉线，等待${r.reconnectMinutes}分钟后尝试重连`);
    while (this._isCurrentRunner(tokenId, r) && Date.now() < r.reconnectAt) {
      if (this.gm.getConnectionStatus(tokenId) === 'connected') return this._connectionRecovered(tokenId, r);
      const remaining = Math.max(0, Math.ceil((r.reconnectAt - Date.now()) / 1000));
      r.lastMsg = `掉线，等待重连（剩余${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}）`;
      this._broadcast(tokenId);
      await sleep(Math.min(1000, Math.max(0, r.reconnectAt - Date.now())));
    }
    if (!this._isCurrentRunner(tokenId, r)) return false;
    if (this.gm.getConnectionStatus(tokenId) === 'connected') return this._connectionRecovered(tokenId, r);
    r.reconnectState = 'connecting';
    r.lastMsg = '等待结束，正在尝试重连...';
    this._log(tokenId, 'info', r.lastMsg);
    this._broadcast(tokenId);
    const connected = await this._attemptReconnect(tokenId, r);
    if (!this._isCurrentRunner(tokenId, r)) return false;
    if (connected && this.gm.getConnectionStatus(tokenId) === 'connected') return this._connectionRecovered(tokenId, r);
    Object.assign(r, { reconnecting: false, reconnectState: null, reconnectAt: null });
    this._broadcast(tokenId);
    return false;
  }

  _connectionRecovered(tokenId, r) {
    Object.assign(r, { reconnecting: false, reconnectState: null, reconnectAt: null, lastMsg: '连接已恢复，继续推关' });
    this._log(tokenId, 'info', r.lastMsg);
    this._broadcast(tokenId);
    return true;
  }

  async _connectForStart(tokenId, r) {
    this.startingConnections.add(tokenId);
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        if (!this._isCurrentRunner(tokenId, r)) return false;
        if (await this._attemptReconnect(tokenId, r, 30000)) return true;
        if (!this._isCurrentRunner(tokenId, r)) return false;
        if (attempt < 2) {
          const deadline = Date.now() + 2000 * (attempt + 1);
          while (this._isCurrentRunner(tokenId, r) && Date.now() < deadline) {
            await sleep(Math.min(500, deadline - Date.now()));
          }
        }
      }
      return false;
    } finally {
      this.startingConnections.delete(tokenId);
    }
  }

  async _attemptReconnect(tokenId, r, timeoutMs = 10000) {
    try {
      if (!this._isCurrentRunner(tokenId, r)) return false;
      this.gm.disconnect(tokenId);
      await sleep(500);
      if (!this._isCurrentRunner(tokenId, r)) return false;
      await this.gm.connect(tokenId, r.userId || '');
      const deadline = Date.now() + timeoutMs;
      while (this._isCurrentRunner(tokenId, r) && Date.now() < deadline) {
        if (this.gm.getConnectionStatus(tokenId) === 'connected') return true;
        await sleep(Math.min(500, deadline - Date.now()));
      }
      if (this._isCurrentRunner(tokenId, r) && this.gm.getConnectionStatus(tokenId) !== 'connected') this.gm.disconnect(tokenId);
    } catch (error) {
      if (this._isCurrentRunner(tokenId, r)) this._log(tokenId, 'warn', '重连尝试异常: ' + error.message);
    }
    return false;
  }

  _applyTorchInfo(r, info, observedAt = Date.now()) {
    r.torchRoleInfo = info;
    const role = pick(info, 'role') || info?.body || info;
    if (role?.autoClickType == null) return;
    const type = Number(role.autoClickType) || 0;
    const remaining = Math.max(0, Number(role.autoClickTime) || 0);
    const settle = Number(role.autoClickSettleTime) || 0;
    const settleMs = settle < 1e12 ? settle * 1000 : settle;
    r.torch = { type, expiresAt: settleMs > observedAt ? settleMs : observedAt + remaining * 1000 };
  }

  async useTorch(tokenId, itemId, quantity) {
    if (![1008, 1009, 1010].includes(itemId) || !Number.isInteger(quantity) || quantity < 1 || quantity > 999) {
      return { ok: false, msg: '火把类型或数量无效' };
    }
    const r = this.runners.get(tokenId);
    if (!this._isCurrentRunner(tokenId, r)) return { ok: false, msg: '请先启动该账号推关' };
    if (this.gm.getConnectionStatus(tokenId) !== 'connected') return { ok: false, msg: '账号未连接，未使用火把' };
    if (this.torchBusy.has(tokenId)) return { ok: false, msg: '正在使用火把，请勿重复提交' };
    this.torchBusy.add(tokenId);
    try {
      await this.gm.sendMessageWithPromise(tokenId, 'item_consume', { itemId, quantity }, 10000);
      this._log(tokenId, 'success', `使用火把 ${itemId} × ${quantity} 成功`);
      try {
        const info = await this.gm.sendMessageWithPromise(tokenId, 'role_getroleinfo', {}, 10000);
        if (this.runners.get(tokenId) === r) this._applyTorchInfo(r, info);
      } catch (error) {
        this._log(tokenId, 'warn', '火把已使用，状态刷新失败: ' + error.message);
      }
      this._broadcast(tokenId);
      return { ok: true, msg: '火把已使用' };
    } catch (error) {
      this._log(tokenId, 'error', '使用火把失败: ' + error.message);
      return { ok: false, msg: error.message };
    } finally {
      this.torchBusy.delete(tokenId);
    }
  }

  _log(tokenId, level, message) {
    const entry = { id: this.logPrefix + '-' + (++this.logSequence), tokenId, level, message, ts: Date.now() };
    this.logs.push(entry);
    if (this.logs.length > 2000) this.logs.splice(0, this.logs.length - 2000);
    gameLogger.info(`[推关][${tokenId}] ${message}`);
    try { this.push.log(tokenId, level, '[推关] ' + message, { source: 'pushLevel', id: entry.id }); } catch {}
  }

  _broadcast(tokenId) {
    try { this.push.broadcast('pushLevel', { tokenId, status: this.getStatus(tokenId) }); } catch {}
  }
}
