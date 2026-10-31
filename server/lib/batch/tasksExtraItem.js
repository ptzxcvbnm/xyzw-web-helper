import { HERO_DICT } from "../HeroList.js";

import { PEACH_TASKS } from "../PeachTaskIds.js";

export function createTasksExtraItem(deps) {
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
    helperSettings,
    delayConfig,
  } = deps;

const batchOpenFragmentPacks = async () => {
    if (selectedTokens.value.length === 0) return;
    isRunning.value = true;
    shouldStop.value = false;
    selectedTokens.value.forEach((id) => { tokenStatus.value[id] = "waiting"; });

    const packs = [
      { itemId: 3007, name: "随机红将碎片" }, { itemId: 3005, name: "随机紫将碎片" },
      { itemId: 3006, name: "随机橙将碎片" }, { itemId: 3008, name: "精铁福袋" },
      { itemId: 3009, name: "进阶石福袋" }, { itemId: 3011, name: "白玉福袋" },
      { itemId: 3012, name: "扳手福袋" }, { itemId: 35011, name: "赛车改装礼盒" },
      { itemId: 3001, name: "金币礼包" }, { itemId: 3002, name: "金砖礼包" },
      { itemId: 3010, name: "晶石福袋" }, { itemId: 37005, name: "怪异礼包" },
    ];

    const taskPromises = selectedTokens.value.map(async (tokenId) => {
      if (shouldStop.value) return;
      tokenStatus.value[tokenId] = "running";
      const token = tokens.value.find((t) => t.id === tokenId);
      if (!token) return;
      try {
        addLog({ time: new Date().toLocaleTimeString(), message: `=== 开始开碎片礼包: ${token.name} ===`, type: "info" });
        await ensureConnection(tokenId);
        const resp = await tokenStore.sendMessageWithPromise(tokenId, "role_getroleinfo", {}, 8000);
        const items = resp?.role?.items || {};
        let opened = 0;
        for (const pack of packs) {
          if (shouldStop.value) break;
          let qty = Number(items[pack.itemId]?.quantity || 0);
          while (qty > 0 && !shouldStop.value) {
            const num = Math.min(qty, 999);
            try {
              await tokenStore.sendMessageWithPromise(tokenId, "item_openpack", { itemId: pack.itemId, number: num, index: 0 }, 10000);
              opened += num;
              qty -= num;
              await new Promise((r) => setTimeout(r, delayConfig.action));
            } catch { break; }
          }
        }
        addLog({ time: new Date().toLocaleTimeString(), message: `${token.name} 碎片礼包开启完成: 共${opened}个`, type: "success" });
        tokenStatus.value[tokenId] = "completed";
      } catch (error) {
        addLog({ time: new Date().toLocaleTimeString(), message: `${token.name} 开碎片礼包失败: ${error.message}`, type: "error" });
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

const batchClaimBoxWeeklyRewards = async () => {
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
        addLog({ time: new Date().toLocaleTimeString(), message: `=== 开始领取宝箱达标奖励: ${token.name} ===`, type: "info" });
        await ensureConnection(tokenId);
        let ok = 0;
        for (let i = 0; i < 1; i++) {
          try {
            await tokenStore.sendMessageWithPromise(tokenId, "activity_selectrewards", { rewardIndex: 5 }, 5000);
            ok++;
          } catch {}
          await new Promise((r) => setTimeout(r, delayConfig.action));
        }
        addLog({ time: new Date().toLocaleTimeString(), message: `${token.name} 宝箱达标奖励领取完成`, type: ok > 0 ? "success" : "info" });
        tokenStatus.value[tokenId] = "completed";
      } catch (error) {
        addLog({ time: new Date().toLocaleTimeString(), message: `${token.name} 领取宝箱达标奖励失败: ${error.message}`, type: "error" });
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
return { batchOpenFragmentPacks, batchClaimBoxWeeklyRewards };
}
