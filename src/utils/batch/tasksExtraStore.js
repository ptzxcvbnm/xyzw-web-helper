import { settingsApi } from "@/api/serverApi";

const ACTIVITY_CYCLE_START = new Date("2025-12-12T12:00:00+08:00").getTime();

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const ACTIVITY_CYCLE_MS = 3 * WEEK_MS;

function getActivityWeek(date = new Date()) {
  const elapsed = date.getTime() - ACTIVITY_CYCLE_START;
  if (elapsed < 0) return null;
  const cyclePos = elapsed % ACTIVITY_CYCLE_MS;
  if (cyclePos < WEEK_MS) return "blackMarket";
  if (cyclePos < 2 * WEEK_MS) return "recruit";
  return "box";
}

export function createTasksExtraStore(deps) {
const {
    selectedTokens,
    tokens,
    tokenStatus,
    isRunning,
    shouldStop,
    ensureConnection,
    releaseConnectionSlot,
    connectionQueue,
    batchSettings,
    tokenStore,
    addLog,
    message,
    currentRunningTokenId,
    delayConfig,
  } = deps;

const runBatch = async (label, handler) => {
    if (selectedTokens.value.length === 0) return;
    isRunning.value = true;
    shouldStop.value = false;
    selectedTokens.value.forEach((id) => { tokenStatus.value[id] = "waiting"; });
    const taskPromises = selectedTokens.value.map(async (tokenId) => {
      if (shouldStop.value) return;
      tokenStatus.value[tokenId] = "running";
      const token = tokens.value.find((t) => t.id === tokenId);
      if (!token) return;
      try {
        addLog({ time: new Date().toLocaleTimeString(), message: `=== 开始${label}: ${token.name} ===`, type: "info" });
        await ensureConnection(tokenId);
        await handler(tokenId, token);
        tokenStatus.value[tokenId] = "completed";
      } catch (error) {
        addLog({ time: new Date().toLocaleTimeString(), message: `${token.name} ${label}失败: ${error.message}`, type: "error" });
        tokenStatus.value[tokenId] = "failed";
      } finally {
        tokenStore.closeWebSocketConnection(tokenId);
        releaseConnectionSlot();
      }
    });
    await Promise.all(taskPromises);
    currentRunningTokenId.value = null;
    isRunning.value = false;
    shouldStop.value = false;
  };

const weeklyFreeGift = async () => {
    await runBatch("领取每周免费礼包", async (tokenId, token) => {
      const week = getActivityWeek();
      const activityId = week === "recruit" ? 6 : (week === "blackMarket" ? 5 : (week === "box" ? 7 : null));
      if (!activityId) { addLog({ time: new Date().toLocaleTimeString(), message: `${token.name} 当前活动周未知，跳过`, type: "warning" }); return; }
      await tokenStore.sendMessageWithPromise(tokenId, "activity_buystoregoods", { activityId, goodsIndex: 0, buyNum: 1 }, 8000);
      addLog({ time: new Date().toLocaleTimeString(), message: `${token.name} 每周免费礼包领取成功`, type: "success" });
    });
  };

const mondayFreeGift = async () => {
    await runBatch("领取周一免费礼包", async (tokenId, token) => {
      await tokenStore.sendMessageWithPromise(tokenId, "activity_claimrolluppack", { id: 17 }, 8000);
      addLog({ time: new Date().toLocaleTimeString(), message: `${token.name} 周一免费礼包领取成功`, type: "success" });
    });
  };

const gachaFreeDrawWeekly = async () => {
    await runBatch("每周免费抽卡", async (tokenId, token) => {
      await tokenStore.sendMessageWithPromise(tokenId, "gacha_drawreward", { num: 1, isGroup: false }, 8000);
      addLog({ time: new Date().toLocaleTimeString(), message: `${token.name} 每周免费抽卡成功`, type: "success" });
    });
  };

const batchPkRoomAppoint = async () => {
    await runBatch("PK房间预约", async (tokenId, token) => {
      await tokenStore.sendMessageWithPromise(tokenId, "pkroom_appoint", {}, 8000);
      addLog({ time: new Date().toLocaleTimeString(), message: `${token.name} PK房间预约成功`, type: "success" });
    });
  };

const blackMarketPurchaseList = async () => {
    await runBatch("黑市购买清单", async (tokenId, token) => {
      if (getActivityWeek() !== "blackMarket") {
        addLog({ time: new Date().toLocaleTimeString(), message: `${token.name} 当前非黑市周，跳过`, type: "warning" });
        return;
      }
      let list = [];
      try {
        const s = await settingsApi.get(`daily-settings:${tokenId}`);
        if (Array.isArray(s?.blackMarketPurchaseList)) list = s.blackMarketPurchaseList;
      } catch {}
      if (list.length === 0) {
        addLog({ time: new Date().toLocaleTimeString(), message: `${token.name} 未配置黑市购买清单，跳过`, type: "warning" });
        return;
      }
      let ok = 0, fail = 0;
      for (const goodsIndex of list) {
        try {
          await tokenStore.sendMessageWithPromise(tokenId, "activity_buystoregoods", { activityId: 9, goodsIndex: Number(goodsIndex), buyNum: 1 }, 5000);
          ok++;
        } catch { fail++; }
        await new Promise((r) => setTimeout(r, delayConfig.action));
      }
      addLog({ time: new Date().toLocaleTimeString(), message: `${token.name} 黑市购买完成: 成功${ok}, 失败${fail}`, type: "success" });
    });
  };

const isIgnorableErr = (msg) => {
    const m = String(msg || "");
    return ["已领取", "超出上限", "1100010", "1100060", "1100070", "12200050", "12200060", "12200040", "3500020", "200020"].some(k => m.includes(k));
  };

const charge_claimaddup_rewards = async () => {
    await runBatch("积分好礼领取", async (tokenId, token) => {
      let ok = 0, skip = 0;
      for (let id = 1; id <= 15; id++) {
        try { await tokenStore.sendMessageWithPromise(tokenId, "charge_claimaddup", { id }, 5000); ok++; }
        catch { skip++; }
        await new Promise((r) => setTimeout(r, delayConfig.action));
      }
      addLog({ time: new Date().toLocaleTimeString(), message: `${token.name} 积分好礼领取完成: 成功${ok}, 跳过${skip}`, type: ok > 0 ? "success" : "info" });
    });
  };

const claim_recruit_welfare = async () => {
    await runBatch("周免费礼领取", async (tokenId, token) => {
      const week = getActivityWeek();
      const isMonday = new Date().getDay() === 1;
      const tasks = [
        { name: "招募周免费礼", cmd: "activity_buystoregoods", params: { activityId: 6, goodsIndex: 0, buyNum: 1 }, when: week === "recruit" },
        { name: "黑市周免费礼", cmd: "activity_buystoregoods", params: { activityId: 5, goodsIndex: 0, buyNum: 1 }, when: week === "blackMarket" },
        { name: "宝箱周免费礼", cmd: "activity_buystoregoods", params: { activityId: 7, goodsIndex: 0, buyNum: 1 }, when: week === "box" },
        { name: "宝箱周锤子奖励", cmd: "activity_claimredquenchreward", params: {}, when: week === "box" },
        { name: "周一免费礼", cmd: "activity_claimrolluppack", params: { id: 17 }, when: isMonday },
        { name: "砸金蛋", cmd: "item_openpack", params: { itemId: 6001, number: 10, index: 0 }, when: week === "box" },
      ];
      let ok = 0, skip = 0;
      for (const tk of tasks) {
        if (!tk.when) { skip++; continue; }
        try { await tokenStore.sendMessageWithPromise(tokenId, tk.cmd, tk.params, 5000); ok++; addLog({ time: new Date().toLocaleTimeString(), message: `${token.name} ${tk.name}领取成功`, type: "success" }); }
        catch (e) { skip++; if (!isIgnorableErr(e.message)) addLog({ time: new Date().toLocaleTimeString(), message: `${token.name} ${tk.name}失败: ${e.message}`, type: "warning" }); }
        await new Promise((r) => setTimeout(r, delayConfig.action));
      }
      addLog({ time: new Date().toLocaleTimeString(), message: `${token.name} 周福利完成: 成功${ok}, 跳过${skip}`, type: "info" });
    });
  };

const claim_weird_tower_all = async () => {
    await runBatch("怪异塔奖励领取", async (tokenId, token) => {
      for (let taskId = 1; taskId <= 3; taskId++) {
        try { await tokenStore.sendMessageWithPromise(tokenId, "evotower_claimtask", { taskId }, 5000); } catch {}
        await new Promise((r) => setTimeout(r, delayConfig.action));
      }
      for (let taskId = 4; taskId <= 9; taskId++) {
        try { await tokenStore.sendMessageWithPromise(tokenId, "evotower_claimlegiontask", { taskId }, 5000); } catch {}
        await new Promise((r) => setTimeout(r, delayConfig.action));
      }
      for (let i = 0; i < 4; i++) {
        try { await tokenStore.sendMessageWithPromise(tokenId, "evotower_claimlegionprivilege", {}, 5000); } catch {}
        await new Promise((r) => setTimeout(r, delayConfig.action));
      }
      try { await tokenStore.sendMessageWithPromise(tokenId, "activity_battlepassrewardclaim", { battlePassId: 1003 }, 5000); } catch {}
      addLog({ time: new Date().toLocaleTimeString(), message: `${token.name} 怪异塔奖励领取完成`, type: "success" });
    });
  };
return { weeklyFreeGift, mondayFreeGift, gachaFreeDrawWeekly, batchPkRoomAppoint, blackMarketPurchaseList, charge_claimaddup_rewards, claim_recruit_welfare, claim_weird_tower_all };
}
