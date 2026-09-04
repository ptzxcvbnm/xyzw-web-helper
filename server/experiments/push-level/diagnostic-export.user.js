// ==UserScript==
// @name         推关实验诊断导出
// @version      0.7.0
// @description  暂停页面主线后筛选服务器战斗，并按正常战斗时长保护胜局结算
// @match        https://xki.asia/*
// @grant        none
// ==/UserScript==
(() => {
  'use strict';
  const id = 'xyzw-push-level-experiment-export';
  document.getElementById(id)?.remove();
  const panel = document.createElement('div');
  panel.id = id;
  panel.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:2147483647;padding:8px;background:#fff;color:#222;border:1px solid #3182ce;border-radius:8px;font:13px sans-serif;max-width:300px;';
  const status = document.createElement('div');
  status.textContent = '推关实验 v0.7：暂停主线后筛选与结算';
  let busy = false;
  let cancelFilter = false;
  let pendingDownload = null;
  let pendingPayload = null;
  let pendingServerWin = null;
  let pausedLevelBattle = null;
  const sampleLabel = document.createElement('label');
  sampleLabel.textContent = '主线样本 JSON';
  sampleLabel.style.cssText = 'display:none;margin-top:4px';
  const sampleBox = document.createElement('textarea');
  sampleBox.setAttribute('aria-label', '主线样本 JSON');
  sampleBox.readOnly = true;
  sampleBox.style.cssText = 'display:none;width:270px;height:54px;font:10px monospace';
  function button(label, action, allowWhileBusy = false) {
    const button = document.createElement('button');
    button.textContent = label;
    button.style.cssText = 'margin:5px 5px 5px 0;padding:5px;cursor:pointer';
    button.addEventListener('click', async () => {
      if (busy && !allowWhileBusy) return;
      if (allowWhileBusy) {
        try { await action(); } catch (error) { status.textContent = error.message; }
        return;
      }
      busy = true;
      try { await action(); } catch (error) { status.textContent = error.message; }
      finally { busy = false; }
    });
    panel.appendChild(button);
  }
  function api() {
    const api = window.__NON_PVP_SIMULATOR__;
    if (!api || typeof api.exportDiagnostics !== 'function') throw new Error('战斗模拟脚本尚未就绪，请先登录并等待“模拟”按钮出现');
    return api;
  }
  function serialize(value) {
    if (typeof value === 'bigint') return {__type:'BigInt', value:String(value)};
    if (value === null || typeof value !== 'object') return value;
    if (value instanceof Map) return {__type:'Map', value:Array.from(value, ([key,item]) => [serialize(key),serialize(item)])};
    if (value instanceof Set) return {__type:'Set', value:Array.from(value, serialize)};
    if (value instanceof Date) return {__type:'Date', value:value.toISOString()};
    if (Array.isArray(value)) return value.map(serialize);
    return Object.fromEntries(Object.entries(value).map(([key,item]) => [key,serialize(item)]));
  }
  function revive(value) {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(revive);
    if (value.__type === 'Map') return new Map(value.value.map(([key,item]) => [revive(key),revive(item)]));
    if (value.__type === 'Set') return new Set(value.value.map(revive));
    if (value.__type === 'Date') return new Date(value.value);
    if (value.__type === 'BigInt') return BigInt(value.value);
    return Object.fromEntries(Object.entries(value).map(([key,item]) => [key,revive(item)]));
  }
  function summary(result) {
    return {isWin:result.isWin, round:result.round, totalFrame:result.totalFrame, inputCode:result.inputCode, outputCode:result.outputCode};
  }
  function preparePayload(payload) {
    pendingPayload = payload;
    pendingDownload = {fileName:`xyzw-main-level-${payload.levelId}-${Date.now()}.json`,text:JSON.stringify(payload,null,2)};
    sampleBox.value = pendingDownload.text;
    sampleLabel.style.display = 'block';
    sampleBox.style.display = 'block';
  }
  async function simulateAndPrepare(raw, source, currLevel, protocolRequest = null) {
    const request = window.__require;
    if (typeof request !== 'function') throw new Error('游戏尚未就绪');
    const data = request('data-index');
    if (!raw || raw.mode !== data.BattleType.level) throw new Error('服务器没有返回可用的主线战斗数据');
    const input = revive(serialize(raw));
    input.id = Date.now();
    input.leftTeams = [];
    input.rightTeams = [];
    input.fightTime = 0;
    input.outputCode = {};
    input.statistic = [];
    input.result = new data.BattleResult();
    const config = request('Configs');
    const lord = request('ModuleManager').GET_MODULE(config.ModuleType.LORD);
    const extend = {noRender:true, autoAttack:!!lord.autoAttack, autoAttackInterval:Number(lord.autoAttackInterval)};
    if (!Number.isFinite(extend.autoAttackInterval)) throw new Error('无法读取自动攻击间隔');
    const constants = request('battle-const').BattleConst;
    const payload = {
      format:'xyzw-main-level-sample-v1', exportedAt:new Date().toISOString(),
      metadata:{battleVersion:constants.BATTLE_VERSION, configCommit:constants.CONFIG_COMMIT_ID, engineVersion:constants.ENGINE_VERSION},
      source, levelId:currLevel ?? input.options.get('levelId'), extend, battleData:serialize(input),
    };
    if (protocolRequest) payload.protocolRequest = protocolRequest;
    status.textContent = `正在计算第 ${payload.levelId} 关的一个样本…`;
    const factory = new (request('launcher-server').ServerBattleLauncher)();
    factory.initialize();
    const battle = factory.createBattleById({battleData:input, timeScale:100, extend:{...extend,role:new data.GDRole()}});
    if (!battle) throw new Error('创建模拟战斗失败');
    let result = null;
    const onResult = value => { result = summary(value); };
    battle.BattleResult.add(onResult);
    const started = performance.now();
    try {
      battle.startBattle();
      let time = Date.now(), updates = 0;
      while (!result && updates < 20000 && performance.now() - started < 40000) {
        battle.update(time);
        time += 20;
        updates++;
        if (!result) await new Promise(resolve => setTimeout(resolve,0));
      }
      if (!result) throw new Error('单次模拟超时，请重试；主线没有被重置');
      payload.browserSimulation = {timeScale:100, updates, wallMs:Math.round(performance.now()-started), result};
    } finally {
      battle.BattleResult.remove(onResult);
      battle.endBattle();
    }
    preparePayload(payload);
    status.textContent = `样本就绪：${result.isWin?'预测胜利':'预测失败'}，${result.round} 回合，${pendingDownload.text.length} 字符。`;
    return payload;
  }
  function ensureIdle() {
    if (window.__NON_PVP_SIMULATOR__?.state?.mainPush?.isRunning) throw new Error('请先停止“推关模拟”，再采集主线');
  }
  function pausePageLevelBattle() {
    if (pausedLevelBattle) return pausedLevelBattle;
    const request = window.__require;
    if (typeof request !== 'function') throw new Error('游戏尚未就绪');
    const manager = request('manager-factory');
    const battle = manager.GET_LEVEL_BATTLE();
    if (!battle) throw new Error('未找到页面当前主线，请返回战斗页后重试');
    manager.PAUSE_BATTLE(battle);
    pausedLevelBattle = battle;
    return battle;
  }
  function resumePageLevelBattle() {
    if (!pausedLevelBattle) return false;
    const battle = pausedLevelBattle;
    pausedLevelBattle = null;
    window.__require('manager-factory').RESUME_BATTLE(battle);
    return true;
  }
  button('采集当前主线（单次）', async () => {
    ensureIdle();
    pendingServerWin = null;
    const request = window.__require;
    if (typeof request !== 'function') throw new Error('游戏尚未就绪');
    const raw = request('manager-factory').GET_LEVEL_BATTLE()?.options?.battleData;
    if (!raw) throw new Error('未找到当前主线，请返回战斗页后重试');
    await simulateAndPrepare(raw, 'current-level-battle');
  });
  button('服务器取局并模拟（单次）', async () => {
    ensureIdle();
    pendingServerWin = null;
    pausePageLevelBattle();
    const request = window.__require;
    if (typeof request !== 'function') throw new Error('游戏尚未就绪');
    const fightService = request('data-index').FightService;
    if (!fightService || typeof fightService.getLevelBattleData !== 'function') throw new Error('当前版本没有 FightService.getLevelBattleData');
    status.textContent = '正在向服务器请求一局主线战斗数据…';
    const requestStarted = performance.now();
    const response = await fightService.getLevelBattleData({});
    const requestWallMs = Math.round(performance.now() - requestStarted);
    if (!response || response.code) throw new Error(`服务器取局失败：code=${response?.code ?? '无响应'}`);
    const body = response.getData();
    if (!body?.battleData) throw new Error('服务器响应中没有 battleData');
    const payload = await simulateAndPrepare(body.battleData, 'fight_getlevelbattledata', body.currLevel, {wallMs:requestWallMs});
    if (payload.browserSimulation.result.isWin) {
      const estimatedBattleMs = payload.browserSimulation.updates * 20 * payload.browserSimulation.timeScale;
      pendingServerWin = {levelId:payload.levelId, randomSeed:body.battleData.randomSeed, readyAt:Date.now()+estimatedBattleMs+5000, estimatedBattleMs};
      status.textContent = `预测胜利：页面主线保持暂停，约 ${Math.ceil((estimatedBattleMs+5000)/1000)} 秒后可提交。`;
    } else {
      resumePageLevelBattle();
    }
  });
  button('连续筛选（最多20局）', async () => {
    ensureIdle();
    const request = window.__require;
    if (typeof request !== 'function') throw new Error('游戏尚未就绪');
    const fightService = request('data-index').FightService;
    if (!fightService || typeof fightService.getLevelBattleData !== 'function') throw new Error('当前版本没有 FightService.getLevelBattleData');
    cancelFilter = false;
    const attempts = [];
    let latestPayload = null;
    pendingServerWin = null;
    pausePageLevelBattle();
    for (let index = 1; index <= 20 && !cancelFilter; index++) {
      status.textContent = `连续筛选：正在请求第 ${index}/20 局…`;
      const requestStarted = performance.now();
      const response = await fightService.getLevelBattleData({});
      const requestWallMs = Math.round(performance.now() - requestStarted);
      if (!response || response.code) throw new Error(`第 ${index} 局取局失败：code=${response?.code ?? '无响应'}`);
      const body = response.getData();
      if (!body?.battleData) throw new Error(`第 ${index} 局响应中没有 battleData`);
      if (cancelFilter) break;
      latestPayload = await simulateAndPrepare(body.battleData, 'fight_getlevelbattledata', body.currLevel, {wallMs:requestWallMs});
      const result = latestPayload.browserSimulation.result;
      attempts.push({index, randomSeed:body.battleData.randomSeed, requestWallMs, simulationWallMs:latestPayload.browserSimulation.wallMs, result:summary(result)});
      latestPayload.filterRun = {maxAttempts:20, stoppedBy:result.isWin?'predicted-win':null, attempts};
      preparePayload(latestPayload);
      if (result.isWin) {
        const estimatedBattleMs = latestPayload.browserSimulation.updates * 20 * latestPayload.browserSimulation.timeScale;
        pendingServerWin = {levelId:latestPayload.levelId, randomSeed:body.battleData.randomSeed, readyAt:Date.now()+estimatedBattleMs+5000, estimatedBattleMs};
        status.textContent = `连续筛选：第 ${index} 局预测胜利；页面主线保持暂停，约 ${Math.ceil((estimatedBattleMs+5000)/1000)} 秒后可提交。`;
        return;
      }
      if (index < 20) await new Promise(resolve => setTimeout(resolve,300));
    }
    if (latestPayload) {
      latestPayload.filterRun.stoppedBy = cancelFilter ? 'cancelled' : 'attempt-limit';
      preparePayload(latestPayload);
    }
    status.textContent = cancelFilter
      ? `连续筛选已停止，共完成 ${attempts.length} 局；未提交过关。`
      : `连续筛选结束：20 局均预测失败；未提交过关。`;
    resumePageLevelBattle();
  });
  button('停止连续筛选', () => {
    cancelFilter = true;
    status.textContent = '已请求停止；当前请求完成后不会再取下一局。';
  }, true);
  button('提交已保留胜局（单次）', async () => {
    ensureIdle();
    if (!pendingServerWin) throw new Error('没有可提交的预测胜局，请先执行服务器取局或连续筛选');
    const remainingMs = pendingServerWin.readyAt - Date.now();
    if (remainingMs > 0) throw new Error(`结算保护中，请再等待 ${Math.ceil(remainingMs/1000)} 秒`);
    const request = window.__require;
    if (typeof request !== 'function') throw new Error('游戏尚未就绪');
    const fightService = request('data-index').FightService;
    if (!fightService || typeof fightService.level !== 'function') throw new Error('当前版本没有 FightService.level');
    const winningLevel = pendingServerWin.levelId;
    status.textContent = `正在提交第 ${winningLevel} 关的已保留胜局…`;
    const requestStarted = performance.now();
    const response = await fightService.level({});
    const requestWallMs = Math.round(performance.now() - requestStarted);
    if (!response || response.code) throw new Error(`胜局提交失败：code=${response?.code ?? '无响应'}`);
    const body = response.getData();
    if (pendingPayload) {
      pendingPayload.settlement = {
        requestWallMs,
        success:body?.success,
        currLevel:body?.currLevel,
        nextTime:body?.nextTime,
      };
      preparePayload(pendingPayload);
    }
    pendingServerWin = null;
    if (body?.success === true || body?.success === 1) {
      if (pausedLevelBattle) {
        const battle = pausedLevelBattle;
        pausedLevelBattle = null;
        try { window.__require('manager-factory').QUIT_BATTLE(battle); } catch (_) {}
      }
      status.textContent = `结算成功：第 ${winningLevel} 关已通过，当前第 ${body.currLevel} 关。`;
    } else {
      status.textContent = `服务器未判定通过：当前第 ${body?.currLevel ?? '?'} 关。`;
    }
  });
  button('恢复页面主线', () => {
    pendingServerWin = null;
    status.textContent = resumePageLevelBattle() ? '页面主线已恢复。' : '页面主线当前没有被实验暂停。';
  }, true);
  // A separate user click preserves download activation after asynchronous simulation.
  button('下载主线样本', () => {
    if (!pendingDownload) throw new Error('请先点击“采集当前主线（单次）”');
    const url = URL.createObjectURL(new Blob([pendingDownload.text],{type:'application/json'}));
    const link = document.createElement('a');
    link.href = url;
    link.download = pendingDownload.fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url),10000);
    status.textContent = `已导出：${pendingDownload.fileName}`;
  });
  button('打开模拟面板', () => api().openPanel());
  button('导出诊断样本', () => {
    const fileName = api().exportDiagnostics();
    status.textContent = `已导出：${fileName}`;
  });
  button('收起', () => panel.remove());
  panel.appendChild(sampleLabel);
  panel.appendChild(sampleBox);
  panel.appendChild(status);
  document.body.appendChild(panel);
})();
