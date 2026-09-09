import { gameLogger } from './logger.js';

/**
 * 后端推关服务
 *
 * 普通模式（已实测验证）：
 *   1. fight_calcleveltime {} -> { battleTime, currLevel }  battleTime是要等的秒数
 *   2. 等待 battleTime 秒
 *   3. fight_level {} -> { success, nextTime, currLevel }
 *   4. 等待 nextTime 后，为下一关重新计算战斗时间并循环
 *
 * 模拟加速模式：
 *   1. fight_getlevelbattledata 获取服务器签发的当前关卡战斗
 *   2. 在 Node 中用版本锁定的官方战斗核心提前计算结果
 *   3. 预测失败立即重新取局；预测胜利保留同一局并等待正常时长后结算
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
  constructor(gameManager, pushService, battleSimulator = null) {
    this.gm = gameManager;
    this.push = pushService;
    this.battleSimulator = battleSimulator;
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
      bossName: r.bossName || null,
      passed: r.passed,
      failStreak: r.failStreak,
      maxFail: r.maxFail,
      reconnectMinutes: r.reconnectMinutes,
      reconnecting: !!r.reconnecting,
      reconnectState: r.reconnectState || null,
      reconnectAt: r.reconnectAt ? new Date(r.reconnectAt).toISOString() : null,
      accelerated: !!r.accelerated,
      simulationAttempts: r.simulationAttempts || 0,
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
    const accelerated = options.accelerated === true;

    if (accelerated) {
      if (!this.battleSimulator) return { ok: false, msg: '模拟加速器未配置' };
      try {
        await this.battleSimulator.ready();
      } catch (error) {
        return { ok: false, msg: '模拟加速器不可用: ' + error.message };
      }
    }

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
      accelerated,
      simulationAttempts: 0,
      failStreak: 0,
      passed: 0,
      currLevel: null,
      bossName: null,
      startedAt: new Date().toISOString(),
      lastMsg: '已启动',
      stopReason: null,
    };
    this.runners.set(tokenId, runner);

    const disconnectPolicy = reconnectMinutes === 0
      ? '掉线自动停止'
      : `掉线后等待${reconnectMinutes}分钟再重连`;
    const modeLabel = accelerated ? '本地模拟加速' : '服务器计时';
    this._log(tokenId, 'info', `开始推关（${modeLabel}，连续失败${maxFail}次自动停止，${disconnectPolicy}）`);
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

  // 根据启动选项选择旧的服务器计时流程或本地模拟加速流程。
  async _loop(tokenId) {
    const r = this.runners.get(tokenId);
    if (!r) return;
    if (r.accelerated) return this._acceleratedLoop(tokenId, r);
    return this._legacyLoop(tokenId, r);
  }

  // 旧流程：每一关都必须先 calc，再提交 level；nextTime 只是关卡间隔。
  async _legacyLoop(tokenId, r = this.runners.get(tokenId)) {
    if (!r) return;

    while (r.running) {
      let waitSec;
      try {
        const calcResp = await this.gm.sendMessageWithPromise(tokenId, 'fight_calcleveltime', {}, 8000);
        const battleTime = pick(calcResp, 'battleTime');
        const currLevel = pick(calcResp, 'currLevel');
        if (currLevel != null) r.currLevel = currLevel;

        if (battleTime == null) {
          this._stopInternal(tokenId, 'battleTime为空');
          return;
        }
        waitSec = battleTime < 0 ? 30 : battleTime;
      } catch (e) {
        this._log(tokenId, 'warn', 'calcleveltime失败: ' + e.message);
        if (!await this._recoverConnectionOrStop(tokenId)) return;
        continue;
      }

      if (waitSec > 300) waitSec = 300; // 安全上限

      r.lastMsg = `第${r.currLevel || '?'}关 战斗中(${waitSec}s)`;
      this._broadcast(tokenId);

      // 等待（可中断）
      const waitResult = await this._interruptibleWait(tokenId, waitSec * 1000);
      if (waitResult === 'stopped' || !r.running) return;
      if (waitResult === 'reconnected') continue;

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
        continue;
      }

      if (!r.running) return;
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

      // nextTime 是进入下一关前的间隔，结束后必须重新 calc。
      const nextWaitSec = (typeof nextTime === 'number' && nextTime >= 0) ? nextTime : 2;
      const nextWaitResult = await this._interruptibleWait(tokenId, Math.min(nextWaitSec, 300) * 1000);
      if (nextWaitResult === 'stopped' || !r.running) return;
    }
  }

  // 加速流程：服务器取一局，本地提前判负；只有预测胜利才等待正常时长并提交同一局。
  async _acceleratedLoop(tokenId, r = this.runners.get(tokenId)) {
    if (!r || !this.battleSimulator) return;

    while (this._isCurrentRunner(tokenId, r)) {
      let battleData;
      let issuedAt;
      try {
        issuedAt = Date.now();
        const response = await this.gm.sendMessageWithPromise(tokenId, 'fight_getlevelbattledata', {}, 8000);
        if (!this._isCurrentRunner(tokenId, r)) return;
        battleData = pick(response, 'battleData');
        const currLevel = pick(response, 'currLevel');
        if (currLevel != null) r.currLevel = currLevel;
        if (!battleData) {
          this._stopInternal(tokenId, '服务器未返回主线战斗数据');
          return;
        }
      } catch (error) {
        this._log(tokenId, 'warn', '获取主线战斗数据失败: ' + error.message);
        if (!await this._recoverConnectionOrStop(tokenId)) return;
        await this._interruptibleWait(tokenId, 500);
        continue;
      }

      let simulation;
      try {
        simulation = await this.battleSimulator.simulate(battleData, {
          autoAttack: false,
          autoAttackInterval: 0.16,
        });
      } catch (error) {
        this._stopInternal(tokenId, '本地战斗模拟失败: ' + error.message);
        return;
      }
      if (!this._isCurrentRunner(tokenId, r)) return;

      r.simulationAttempts++;
      r.currLevel = simulation.levelId ?? r.currLevel;
      r.bossName = simulation.bossName || null;
      if (!simulation.result?.isWin) {
        r.failStreak++;
        r.lastMsg = `❌ 预测失败 第${r.currLevel || '?'}关，立即换局 (${r.failStreak}/${r.maxFail})`;
        this._log(tokenId, 'info', r.lastMsg);
        this._broadcast(tokenId);
        if (r.failStreak >= r.maxFail) {
          this._stopInternal(tokenId, `连续预测失败${r.maxFail}次`);
          return;
        }
        const retryWait = await this._interruptibleWait(tokenId, 300);
        if (retryWait === 'stopped') return;
        continue;
      }

      const elapsedMs = Date.now() - issuedAt;
      const waitMs = Math.max(0, simulation.realDurationMs + simulation.settlementBufferMs - elapsedMs);
      r.lastMsg = `✅ 预测胜利 第${r.currLevel || '?'}关，保留本局等待${Math.ceil(waitMs / 1000)}秒结算`;
      this._log(tokenId, 'info', r.lastMsg);
      this._broadcast(tokenId);
      const waitResult = await this._interruptibleWait(tokenId, waitMs);
      if (waitResult === 'stopped' || !this._isCurrentRunner(tokenId, r)) return;
      if (waitResult === 'reconnected') continue;

      let success, currLevel;
      try {
        const levelResp = await this.gm.sendMessageWithPromise(tokenId, 'fight_level', {}, 8000);
        if (!this._isCurrentRunner(tokenId, r)) return;
        success = pick(levelResp, 'success');
        currLevel = pick(levelResp, 'currLevel');
      } catch (error) {
        this._log(tokenId, 'warn', '胜局结算失败: ' + error.message);
        if (!await this._recoverConnectionOrStop(tokenId)) return;
        continue;
      }

      if (currLevel != null) r.currLevel = currLevel;
      if (success === true || success === 1) {
        r.passed++;
        r.failStreak = 0;
        r.lastMsg = `✅ 加速过关 -> 第${currLevel}关 (累计${r.passed}，模拟${r.simulationAttempts}局)`;
        this._log(tokenId, 'info', r.lastMsg);
      } else {
        r.failStreak++;
        r.lastMsg = `❌ 预测胜局未通过 第${r.currLevel || '?'}关 (连续${r.failStreak}/${r.maxFail})`;
        this._log(tokenId, 'warn', r.lastMsg);
        if (r.failStreak >= r.maxFail) {
          this._stopInternal(tokenId, `连续失败${r.maxFail}次`);
          return;
        }
      }
      this._broadcast(tokenId);

      // 加速模式会自行获取并模拟下一关；fight_level 的 nextTime 已包含下一局战斗时间，
      // 再等待它会和下一次模拟结算等待重复。只留一个很短的状态同步间隔。
      const nextWaitResult = await this._interruptibleWait(tokenId, 300);
      if (nextWaitResult === 'stopped' || !this._isCurrentRunner(tokenId, r)) return;
    }
  }

  _isCurrentRunner(tokenId, runner) {
    return !!runner?.running && this.runners.get(tokenId) === runner;
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
      if (this.gm.getConnectionStatus(tokenId) === 'connected') {
        r.reconnecting = false;
        r.reconnectState = null;
        r.reconnectAt = null;
        r.lastMsg = '连接已恢复，继续推关';
        this._log(tokenId, 'info', '等待期间连接已恢复，继续推关');
        this._broadcast(tokenId);
        return true;
      }

      const remainingSeconds = Math.max(0, Math.ceil((r.reconnectAt - Date.now()) / 1000));
      const minutes = Math.floor(remainingSeconds / 60);
      const seconds = String(remainingSeconds % 60).padStart(2, '0');
      r.lastMsg = `掉线，等待重连（剩余${minutes}:${seconds}）`;
      this._broadcast(tokenId);
      await sleep(Math.min(1000, Math.max(0, r.reconnectAt - Date.now())));
    }

    if (!r.running) return false;
    if (this.gm.getConnectionStatus(tokenId) === 'connected') {
      r.reconnecting = false;
      r.reconnectState = null;
      r.reconnectAt = null;
      r.lastMsg = '连接已恢复，继续推关';
      this._log(tokenId, 'info', '等待结束前连接已恢复，继续推关');
      this._broadcast(tokenId);
      return true;
    }

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
