import { LegionWarWebSocketClient } from '../legionWarWebSocket.js';
import { isRoadPoint, pickRandomNeighbor } from './hexUtils.js';
import { gameLogger } from '../logger.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 从响应/推送里取字段，兼容多层结构 */
function pick(obj, name) {
  if (!obj || typeof obj !== 'object') return undefined;
  if (obj[name] !== undefined) return obj[name];
  for (const k of ['rawData', '_rawData', 'decodedBody', 'body', 'data']) {
    if (obj[k] && obj[k][name] !== undefined) return obj[k][name];
  }
  return undefined;
}

/** 从主服角色信息提取当前默认布阵（位置 -> 武将 ID） */
export function getDefaultBattleTeam(roleInfo) {
  const role = pick(roleInfo, 'role') || roleInfo;
  const team = {};
  for (const [slot, value] of Object.entries(role?.battleTeam || {})) {
    const position = Number(slot);
    const heroId = Number(value && typeof value === 'object' ? value.heroId ?? value.id : value);
    if (Number.isInteger(position) && position >= 0 && position < 5 && Number.isInteger(heroId) && heroId > 0) {
      team[String(position)] = heroId;
    }
  }
  if (Object.keys(team).length) return team;
  for (const hero of Object.values(role?.heroes || {})) {
    const position = Number(hero?.battleTeamSlot);
    const heroId = Number(hero?.heroId ?? hero?.id);
    if (Number.isInteger(position) && position >= 0 && position < 5 && Number.isInteger(heroId) && heroId > 0) {
      team[String(position)] = heroId;
    }
  }
  return team;
}

/**
 * 盐场自动创地 Runner（单账号一条连接）
 * 流程：主服拿battlefield -> 建盐场连接 -> 进场 -> 默认阵容布阵 -> 循环创地
 */
export class SaltFieldRunner {
  constructor({ gameManager, tokenId, tokenName, userId, addLog, isInWindow }) {
    this.gm = gameManager;
    this.tokenId = tokenId;
    this.tokenName = tokenName || tokenId;
    this._userId = userId || '';
    this.addLog = addLog || (() => {});
    this.isInWindow = isInWindow || (() => true);

    this.ws = null;
    this.battlefieldId = null;
    this.myCodeId = null;
    this.snapshot = { roles: {}, buildingData: {}, marches: {} };
    this.running = false;
    this.stopFlag = false;
    this.status = 'idle';
    this.lastMsg = '';
    this.previousPosition = null;
    this.battleTeam = null;
  }

  log(message, type = 'info') {
    this.lastMsg = message;
    this.addLog({ time: new Date().toLocaleTimeString(), message: `[${this.tokenName}] ${message}`, type });
  }

  /** 合并增量战场快照（推送只含变化部分，需本地维护全量） */
  mergeBattlefield(bf) {
    if (!bf || typeof bf !== 'object') return;
    if (bf.buildingData && typeof bf.buildingData === 'object') {
      Object.assign(this.snapshot.buildingData, bf.buildingData);
    }
    if (bf.roles && typeof bf.roles === 'object') {
      for (const [k, v] of Object.entries(bf.roles)) {
        if (v === null) delete this.snapshot.roles[k];
        else this.snapshot.roles[k] = { ...(this.snapshot.roles[k] || {}), ...v };
      }
    }
    if (bf.marches && typeof bf.marches === 'object') {
      for (const [k, v] of Object.entries(bf.marches)) {
        if (v === null) delete this.snapshot.marches[k];
        else this.snapshot.marches[k] = v;
      }
    }
  }

  myRole() {
    return this.myCodeId != null ? this.snapshot.roles[String(this.myCodeId)] : null;
  }

  async start() {
    if (this.running) return;
    this.running = true;
    this.stopFlag = false;
    this.status = 'running';
    try {
      this.log('获取盐场入口...');
      // 主服连接可能不稳（1005被踢），重试拿盐场入口，每次失败重连主服
      let info = null;
      for (let attempt = 0; attempt < 4 && !this.stopFlag; attempt++) {
        try {
          const status = this.gm.getConnectionStatus(this.tokenId);
          if (status !== 'connected') {
            await this.gm.connectWithRetry(this.tokenId, this._userId || '', 2);
            await sleep(2000);
          }
          const bfResp = await this.gm.sendMessageWithPromise(this.tokenId, 'legion_getbattlefield', {}, 8000);
          const i = pick(bfResp, 'info');
          if (i && i.sid && i.battlefieldId) { info = i; break; }
        } catch (e) {
          this.log(`获取盐场入口失败(第${attempt + 1}次): ${e.message}`, 'warning');
        }
        await sleep(2500);
      }
      if (!info) {
        this.log('多次尝试仍无法获取盐场入口（可能未开放或连接不稳），跳过', 'warning');
        this.status = 'skipped';
        this.running = false;
        return;
      }
      this.battlefieldId = info.battlefieldId;
      const freshRoleInfo = await this.gm.sendGetRoleInfo(this.tokenId);
      const roleInfo = freshRoleInfo || this.gm.gameData?.get(this.tokenId)?.roleInfo;
      this.battleTeam = getDefaultBattleTeam(roleInfo);
      if (!Object.keys(this.battleTeam).length) throw new Error('未读取到默认阵容，停止布阵');
      const token = this.gm.getActualToken(this.tokenId);
      if (!token) { this.log('拿不到登录token，跳过', 'error'); this.status = 'failed'; this.running = false; return; }

      const url = 'wss://xxz-xyzw-new.hortorgames.com/agent'
        + `?p=${encodeURIComponent(token)}`
        + `&e=x&sid2=${info.sid}&lang=chinese&sid2=${info.sid}`;

      this.ws = new LegionWarWebSocketClient({
        url,
        utils: this.gm.getGUtils(),
        hint: this.battlefieldId,
        heartbeatMs: 5000,
      });
      this.ws.setMessageListener((packet) => this._onMessage(packet));

      const connected = await new Promise((resolve) => {
        let done = false;
        this.ws.onConnect = () => { if (!done) { done = true; resolve(true); } };
        this.ws.onError = () => { if (!done) { done = true; resolve(false); } };
        this.ws.onDisconnect = () => { if (!done) { done = true; resolve(false); } };
        this.ws.init();
        setTimeout(() => { if (!done) { done = true; resolve(this.ws.connected); } }, 10000);
      });
      if (!connected) { this.log('盐场连接失败', 'error'); this.status = 'failed'; this.running = false; return; }

      await sleep(5000);
      this.log('进入战场...');
      const enterResp = await this.ws.sendWithPromise('war_enterbattlefield', { battlefieldId: this.battlefieldId, useGzip: true }, 10000);
      this.myCodeId = String(pick(enterResp, 'roleCodeId') ?? '');
      const bf = pick(enterResp, 'battlefield');
      if (bf) this.mergeBattlefield(bf);
      if (!this.myCodeId) { this.log('未识别到自己codeId', 'error'); this.status = 'failed'; this.stop(); return; }
      this.log(`进场成功 codeId=${this.myCodeId}`, 'success');

      // enterbattlefield 可能只返回增量；地图页也是另外请求完整快照。
      const mapResp = await this.ws.sendWithPromise('war_getbattlefieldinfo', { battlefieldId: this.battlefieldId }, 10000);
      const fullBf = pick(mapResp, 'battlefield');
      if (fullBf) this.mergeBattlefield(fullBf);
      else this.log('未收到完整战场快照，使用已知地图', 'warning');

      await this._setTeam();
      await this._digLoop();
    } catch (e) {
      this.log(`盐场流程异常: ${e.message}`, 'error');
      this.status = 'failed';
    } finally {
      this.stop();
    }
  }

  async _setTeam() {
    const battleTeam = this.battleTeam || {};
    if (!Object.keys(battleTeam).length) throw new Error('未读取到默认阵容，停止布阵');
    this.log(`布阵：默认阵容（${Object.keys(battleTeam).length}名武将）...`);
    await this.ws.sendWithPromise('war_teamsetbattleteam', { battlefieldId: this.battlefieldId, battleTeam }, 8000);
    await sleep(800);
    const setResp = await this.ws.sendWithPromise('war_setbattleteam', { battlefieldId: this.battlefieldId, battleTeam }, 8000);
    const setBf = pick(setResp, 'battlefield');
    if (setBf) this.mergeBattlefield(setBf);
    // 等出生点 position
    for (let i = 0; i < 20; i++) {
      const me = this.myRole();
      if (me && me.position && Number(me.position.x) >= 0 && Number(me.position.y) >= 0 && me.state === 'idle') break;
      await sleep(500);
    }
    const me = this.myRole();
    if (me && me.position && Number(me.position.x) >= 0 && Number(me.position.y) >= 0) this.log(`布阵完成，出生点 (${me.position.x},${me.position.y})`, 'success');
    else this.log('布阵后未拿到出生点，继续尝试', 'warning');
  }

  _onMessage(packet) {
    const cmd = (packet?.cmd || '').toLowerCase();
    const bf = pick(packet, 'battlefield');
    if (bf) this.mergeBattlefield(bf);
    if (cmd === 'war_endmarchnotify') {
      this._lastNotifyMarchId = pick(packet, 'marchId');
    }
  }

  async _digLoop() {
    this.log('开始循环创地');
    while (!this.stopFlag && this.isInWindow()) {
      const me = this.myRole();
      if (!me || !me.position || Number(me.position.x) < 0 || Number(me.position.y) < 0) { await sleep(1000); continue; }
      const { x, y } = me.position;
      const target = pickRandomNeighbor(x, y, this.snapshot.buildingData, this.previousPosition);
      if (!target) { this.log('无可用相邻格，等待', 'warning'); await sleep(2000); continue; }

      try {
        const marchResp = await this.ws.sendWithPromise('war_startmarch', { battlefieldId: this.battlefieldId, target }, 8000);
        const marches = pick(marchResp, 'battlefield')?.marches || pick(marchResp, 'marches');
        if (marches) this.mergeBattlefield({ marches });
        this.log(`行军 -> (${target.x},${target.y})`);
      } catch (e) {
        this.log(`行军失败: ${e.message}`, 'warning');
        await sleep(1500);
        continue;
      }

      let arrived = false;
      for (let i = 0; i < 40 && !this.stopFlag; i++) {
        const m = this.myRole();
        if (m && m.state === 'idle' && m.position && Number(m.position.x) === target.x && Number(m.position.y) === target.y) { arrived = true; break; }
        await sleep(500);
      }
      if (!arrived) { this.log('行军超时，重试', 'warning'); continue; }
      this.previousPosition = { x: Number(x), y: Number(y) };

      if (isRoadPoint(target.x, target.y)) { await sleep(1500); continue; }

      try {
        await this.ws.sendWithPromise('war_startattackbuilding', { battlefieldId: this.battlefieldId, buildingId: `${target.x}_${target.y}` }, 8000);
        this.log(`刨地 (${target.x},${target.y})`, 'success');
      } catch (e) {
        this.log(`刨地失败: ${e.message}`, 'warning');
      }
      await sleep(1500);
    }
    this.log('创地循环结束（时间窗结束或停止）', 'info');
  }

  getStatus() {
    return {
      tokenId: this.tokenId,
      name: this.tokenName,
      running: this.running,
      status: this.status,
      battlefieldId: this.battlefieldId,
      myCodeId: this.myCodeId,
      lastMsg: this.lastMsg,
    };
  }

  stop() {
    this.stopFlag = true;
    if (this.ws) { try { this.ws.disconnect(); } catch {} }
    this.running = false;
    if (this.status === 'running') this.status = 'stopped';
  }
}

export default SaltFieldRunner;
