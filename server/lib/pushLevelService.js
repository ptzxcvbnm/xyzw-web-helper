import { gameLogger } from './logger.js';

/**
 * 纯协议后端推关服务
 *
 * 原理（已实测验证）：
 *   1. fight_calcleveltime {} -> { battleTime, currLevel }  battleTime是要等的秒数
 *   2. 等待 battleTime 秒
 *   3. fight_level {} -> { success, nextTime, currLevel }
 *   4. 用 nextTime 作为下一关等待时间，循环
 *
 * 停止条件：连续失败达到阈值 / 掉线延迟重连失败 / 手动停止
 */

function pick(resp, name) {
  if (!resp || typeof resp !== 'object') return undefined;
  if (resp[name] !== undefined) return resp[name];
  for (const k of ['body', '_rawData', 'rawData', 'decodedBody', 'data']) {
    if (resp[k] && resp[k][name] !== undefined) return resp[k][name];
  }
  if (typeof resp.getData === 'function') {
    try { const d = resp.getData(); if (d && d[name] !== undefined) return d[name]; } catch {}
  }
  return undefined;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export class PushLevelService {
  constructor(gameManager, pushService) {
    this.gm = gameManager;
    this.push = pushService;
    // tokenId -> 运行状态
    this.runners = new Map();
  }

  // 是否正在推关
  isRunning(tokenId) {
    const r = this.runners.get(tokenId);
    return !!(r && r.running);
  }

  // 获取状态
  getStatus(tokenId) {
    const r = this.runners.get(tokenId);
    if (!r) return { running: false };
    return {
      running: r.running,
      currLevel: r.currLevel,
      passed: r.passed,
      failStreak: r.failStreak,
      maxFail: r.maxFail,
      reconnectMinutes: r.reconnectMinutes,
      reconnecting: !!r.reconnecting,
      reconnectState: r.reconnectState || null,
      reconnectAt: r.reconnectAt ? new Date(r.reconnectAt).toISOString() : null,
      startedAt: r.startedAt,
      lastMsg: r.lastMsg,
      stopReason: r.stopReason || null,
    };
  }

  getAllStatus() {
    const out = {};
    for (const [tokenId] of this.runners) out[tokenId] = this.getStatus(tokenId);
    return out;
  }

  // 开始推关
  async start(tokenId, userId, options = {}) {
    if (this.isRunning(tokenId)) {
      return { ok: false, msg: '该账号已在推关中' };
    }

    const maxFail = Math.min(999, Math.max(1, parseInt(options.maxFail) || 20));
    const reconnectMinutes = Math.min(1440, Math.max(0, parseInt(options.reconnectMinutes) || 0));

    // 确保已连接
    let status = this.gm.getConnectionStatus(tokenId);
    if (status !== 'connected') {
      this._log(tokenId, 'info', '账号未连接，正在连接...');
      try {
        await this.gm.connectWithRetry(tokenId, userId || '', 3);
        await sleep(2000);
      } catch (e) {
        return { ok: false, msg: '连接失败: ' + e.message };
      }
      status = this.gm.getConnectionStatus(tokenId);
      if (status !== 'connected') {
        return { ok: false, msg: '连接失败，状态: ' + status };
      }
    }

    const runner = {
      running: true,
      tokenId,
      userId: userId || '',
      maxFail,
      reconnectMinutes,
      reconnecting: false,
      reconnectState: null,
      reconnectAt: null,
      failStreak: 0,
      passed: 0,
      currLevel: null,
      startedAt: new Date().toISOString(),
      lastMsg: '已启动',
      stopReason: null,
    };
    this.runners.set(tokenId, runner);

    const disconnectPolicy = reconnectMinutes === 0
      ? '掉线自动停止'
      : `掉线后等待${reconnectMinutes}分钟再重连`;
    this._log(tokenId, 'info', `开始推关（连续失败${maxFail}次自动停止，${disconnectPolicy}）`);
    this._broadcast(tokenId);

    // 异步跑循环，不阻塞接口返回
    this._loop(tokenId).catch(e => {
      gameLogger.error(`推关循环异常 [${tokenId}]: ${e.message}`);
      this._stopInternal(tokenId, '循环异常: ' + e.message);
    });

    return { ok: true, msg: '已开始推关' };
  }

  // 停止推关（手动）
  stop(tokenId) {
    const r = this.runners.get(tokenId);
    if (!r || !r.running) return { ok: false, msg: '该账号未在推关' };
    this._stopInternal(tokenId, '手动停止');
    return { ok: true, msg: '已停止' };
  }

  stopAll() {
    for (const [tokenId, r] of this.runners) {
      if (r.running) this._stopInternal(tokenId, '全部停止');
    }
  }

  _stopInternal(tokenId, reason) {
    const r = this.runners.get(tokenId);
    if (!r) return;
    r.running = false;
    r.reconnecting = false;
    r.reconnectState = null;
    r.reconnectAt = null;
    r.stopReason = reason;
    r.lastMsg = '已停止: ' + reason;
    this._log(tokenId, 'info', '推关停止: ' + reason);
    this._broadcast(tokenId);
  }

  // 核心循环（优化版：开头calc一次定时间，之后只发level + 用nextTime等待）
  async _loop(tokenId) {
    const r = this.runners.get(tokenId);
    if (!r) return;

    // 开头：算第一关要等多久
    let waitSec = 2;
    try {
      const calcResp = await this.gm.sendMessageWithPromise(tokenId, 'fight_calcleveltime', {}, 8000);
      const bt = pick(calcResp, 'battleTime');
      const cl = pick(calcResp, 'currLevel');
      if (cl != null) r.currLevel = cl;
      if (bt != null) waitSec = bt < 0 ? 30 : bt;
    } catch (e) {
      this._log(tokenId, 'warn', '首次calcleveltime失败: ' + e.message);
      if (!await this._recoverConnectionOrStop(tokenId)) return;
      // 重连成功，重新进循环
      return this._loop(tokenId);
    }

    while (r.running) {
      if (waitSec > 300) waitSec = 300; // 安全上限

      r.lastMsg = `第${r.currLevel || '?'}关 战斗中(${waitSec}s)`;
      this._broadcast(tokenId);

      // 等待（可中断）
      const waitResult = await this._interruptibleWait(tokenId, waitSec * 1000);
      if (waitResult === 'stopped' || !r.running) return;
      if (waitResult === 'reconnected') return this._loop(tokenId);

      // 提交过关
      let success, nextTime, currLevel;
      try {
        const levelResp = await this.gm.sendMessageWithPromise(tokenId, 'fight_level', {}, 8000);
        success = pick(levelResp, 'success');
        nextTime = pick(levelResp, 'nextTime');
        currLevel = pick(levelResp, 'currLevel');
      } catch (e) {
        this._log(tokenId, 'warn', 'level失败: ' + e.message);
        if (!await this._recoverConnectionOrStop(tokenId)) return;
        // 重连成功，重新calc一次再继续
        return this._loop(tokenId);
      }

      if (currLevel != null) r.currLevel = currLevel;

      if (success === true || success === 1) {
        r.passed++;
        r.failStreak = 0;
        r.lastMsg = `✅ 过关 -> 第${currLevel}关 (累计${r.passed})`;
        this._log(tokenId, 'info', r.lastMsg);
      } else {
        r.failStreak++;
        r.lastMsg = `❌ 失败 第${r.currLevel}关 (连续${r.failStreak}/${r.maxFail})`;
        this._log(tokenId, 'info', r.lastMsg);
        if (r.failStreak >= r.maxFail) {
          this._stopInternal(tokenId, `连续失败${r.maxFail}次`);
          return;
        }
      }
      this._broadcast(tokenId);

      // 下一关等待时间：用 level 返回的 nextTime
      waitSec = (typeof nextTime === 'number' && nextTime >= 0) ? nextTime : 2;
    }
  }

  // 可中断的等待（每500ms检查停止状态和连接状态）
  async _interruptibleWait(tokenId, ms) {
    const r = this.runners.get(tokenId);
    let waited = 0;
    while (waited < ms) {
      if (!r || !r.running) return 'stopped';
      if (this.gm.getConnectionStatus(tokenId) !== 'connected') {
        const recovered = await this._recoverConnectionOrStop(tokenId);
        return recovered ? 'reconnected' : 'stopped';
      }
      const step = Math.min(500, ms - waited);
      await sleep(step);
      waited += step;
    }
    return 'completed';
  }

  async _recoverConnectionOrStop(tokenId) {
    const r = this.runners.get(tokenId);
    if (!r || !r.running) return false;
    if (await this._ensureConnected(tokenId)) return true;
    if (!r.running) return false;

    const reason = r.reconnectMinutes === 0
      ? '账号掉线，已按设置自动停止'
      : `掉线后等待${r.reconnectMinutes}分钟，重连失败`;
    this._stopInternal(tokenId, reason);
    return false;
  }

  // 确保连接：0分钟立即停止；大于0时先倒计时等待，结束后只尝试重连一次。
  async _ensureConnected(tokenId) {
    if (this.gm.getConnectionStatus(tokenId) === 'connected') return true;
    const r = this.runners.get(tokenId);
    if (!r || !r.running) return false;

    if (r.reconnectMinutes === 0) {
      this._log(tokenId, 'warn', '检测到掉线，重连时间为0分钟，自动停止');
      return false;
    }

    r.reconnectAt = Date.now() + r.reconnectMinutes * 60 * 1000;
    r.reconnecting = true;
    r.reconnectState = 'waiting';
    this._log(tokenId, 'warn', `检测到掉线，等待${r.reconnectMinutes}分钟后尝试重连`);

    while (r.running && Date.now() < r.reconnectAt) {
      const remainingSeconds = Math.max(0, Math.ceil((r.reconnectAt - Date.now()) / 1000));
      const minutes = Math.floor(remainingSeconds / 60);
      const seconds = String(remainingSeconds % 60).padStart(2, '0');
      r.lastMsg = `掉线，等待重连（剩余${minutes}:${seconds}）`;
      this._broadcast(tokenId);
      await sleep(Math.min(1000, Math.max(0, r.reconnectAt - Date.now())));
    }

    if (!r.running) return false;
    r.reconnectState = 'connecting';
    r.lastMsg = '等待结束，正在尝试重连...';
    this._log(tokenId, 'info', `已等待${r.reconnectMinutes}分钟，开始尝试重连`);
    this._broadcast(tokenId);

    const connected = await this._attemptReconnect(tokenId, r);
    if (connected && r.running && this.gm.getConnectionStatus(tokenId) === 'connected') {
      r.reconnecting = false;
      r.reconnectState = null;
      r.reconnectAt = null;
      r.lastMsg = '重连成功，恢复推关';
      this._log(tokenId, 'info', '掉线重连成功，恢复推关');
      this._broadcast(tokenId);
      return true;
    }

    r.reconnecting = false;
    r.reconnectState = null;
    r.reconnectAt = null;
    this._broadcast(tokenId);
    return false;
  }

  async _attemptReconnect(tokenId, r) {
    try {
      this.gm.disconnect(tokenId);
      await sleep(500);
      if (!r.running) return false;

      await this.gm.connect(tokenId, r.userId || '');
      const attemptDeadline = Date.now() + 10000;
      while (r.running && Date.now() < attemptDeadline) {
        if (this.gm.getConnectionStatus(tokenId) === 'connected') return true;
        await sleep(Math.min(500, attemptDeadline - Date.now()));
      }

      if (r.running && this.gm.getConnectionStatus(tokenId) !== 'connected') {
        this.gm.disconnect(tokenId);
      }
      return false;
    } catch (e) {
      this._log(tokenId, 'warn', '重连尝试异常: ' + e.message);
      return false;
    }
  }

  _log(tokenId, level, msg) {
    gameLogger.info(`[推关][${tokenId}] ${msg}`);
    try { this.push.log(tokenId, level, '[推关] ' + msg); } catch {}
  }

  _broadcast(tokenId) {
    try {
      this.push.broadcast('pushLevel', { tokenId, status: this.getStatus(tokenId) });
    } catch {}
  }
}
