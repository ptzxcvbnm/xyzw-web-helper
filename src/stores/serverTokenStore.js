import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { tokenApi, statusApi, taskApi, ServerPushClient } from '@/api/serverApi';

export const useServerTokenStore = defineStore('serverTokens', () => {
  const tokens = ref([]);
  const selectedTokenId = ref('');
  const connectionStatuses = ref({});
  const gameDataMap = ref({});
  const logs = ref([]);
  const taskProgress = ref({});
  const tokenGroups = ref([]);

  const gameTokens = tokens;

  const selectedToken = computed(() => tokens.value.find(t => t.id === selectedTokenId.value));
  const hasTokens = computed(() => tokens.value.length > 0);
  const currentGameData = computed(() => gameDataMap.value[selectedTokenId.value] || null);
  const selectedTokenRoleInfo = computed(() => currentGameData.value?.roleInfo || null);

  const gameData = computed(() => {
    const gd = currentGameData.value;
    if (!gd) return { roleInfo: null, legionInfo: null, commonActivityInfo: null, bossTowerInfo: null, evoTowerInfo: null, presetTeam: null, battleVersion: null, studyStatus: { isAnswering: false, questionCount: 0, answeredCount: 0, status: "", timestamp: null }, lastUpdated: null };
    return gd;
  });

  const wsConnections = ref({});

  let pushClient = null;

  function handlePush(msg) {
    if (msg.type === 'connection') {
      connectionStatuses.value[msg.data.tokenId] = msg.data.status;
    } else if (msg.type === 'gameData') {
      if (!gameDataMap.value[msg.data.tokenId]) gameDataMap.value[msg.data.tokenId] = {};
      gameDataMap.value[msg.data.tokenId][msg.data.field] = msg.data.value;
    } else if (msg.type === 'log') {
      logs.value.push({ ...msg.data, ts: msg.ts });
      if (logs.value.length > 600) logs.value.splice(0, logs.value.length - 500);
    } else if (msg.type === 'taskProgress') {
      taskProgress.value[msg.data.tokenId] = msg.data;
    } else if (msg.type === 'taskComplete') {
      taskProgress.value[msg.data.tokenId] = { ...msg.data, done: true };
    }
  }

  async function init() {
    pushClient = new ServerPushClient(handlePush);
    pushClient.connect();
    try {
      await refreshTokens();
      await refreshStatus();
      await refreshGroups();
    } catch (e) {
      console.warn('[ServerTokenStore] init partial fail:', e.message);
    }
  }

  const initTokenStore = init;

  async function refreshTokens() {
    tokens.value = await tokenApi.getAll();
  }

  async function refreshStatus() {
    const statuses = await statusApi.getAll();
    for (const s of statuses) {
      connectionStatuses.value[s.id] = s.status;
      if (s.gameData) gameDataMap.value[s.id] = s.gameData;
    }
  }

  async function refreshGroups() {
    tokenGroups.value = await tokenApi.getAllGroups();
  }

  async function addToken(data) {
    const t = await tokenApi.add(data);
    tokens.value.push(t);
    return t;
  }

  async function removeToken(id) {
    await tokenApi.remove(id);
    tokens.value = tokens.value.filter(t => t.id !== id);
    if (selectedTokenId.value === id) selectedTokenId.value = '';
  }

  async function updateToken(id, updates) {
    const t = await tokenApi.update(id, updates);
    const idx = tokens.value.findIndex(x => x.id === id);
    if (idx !== -1) tokens.value[idx] = t;
    return t;
  }

  function selectToken(id, forceReconnect = false) {
    selectedTokenId.value = id;
    const token = tokens.value.find(t => t.id === id);
    if (!token) return null;
    const status = getWebSocketStatus(id);
    if (forceReconnect || status === 'disconnected' || status === 'error') {
      connectToken(id).catch(() => {});
    }
    return token;
  }

  async function connectToken(id) {
    connectionStatuses.value[id] = 'connecting';
    await tokenApi.connect(id);
  }

  async function disconnectToken(id) {
    await tokenApi.disconnect(id);
    connectionStatuses.value[id] = 'disconnected';
  }

  async function createWebSocketConnection(tokenId) {
    return connectToken(tokenId);
  }

  function closeWebSocketConnection(tokenId) {
    disconnectToken(tokenId).catch(() => {});
  }

  async function sendMessage(tokenId, cmd, params, timeout) {
    return tokenApi.send(tokenId, cmd, params, timeout);
  }

  async function sendMessageWithPromise(tokenId, cmd, params = {}, timeout = 5000) {
    const res = await tokenApi.send(tokenId, cmd, params, timeout);
    return res?.result !== undefined ? res.result : res;
  }

  function getWebSocketStatus(tokenId) {
    return connectionStatuses.value[tokenId] || 'disconnected';
  }

  function getWebSocketClient() {
    return null;
  }

  function setMessageListener() {}
  function setShowMsg() {}
  function sendHeartbeat() {}

  async function sendGetRoleInfo(tokenId) {
    return sendMessageWithPromise(tokenId, 'role_getroleinfo', {}, 15000);
  }

  async function sendGetDataBundleVersion(tokenId, params = {}) {
    return sendMessageWithPromise(tokenId, 'system_getdatabundlever', params);
  }

  async function sendGetTeamInfo(tokenId) {
    return sendMessageWithPromise(tokenId, 'presetteam_getinfo', {}, 5000);
  }

  async function sendSignIn(tokenId) {
    return sendMessageWithPromise(tokenId, 'system_signinreward', {}, 5000);
  }

  async function sendClaimDailyReward(tokenId, rewardId = 0) {
    return sendMessageWithPromise(tokenId, 'task_claimdailyreward', { rewardId }, 5000);
  }

  async function sendMessageToWorld(tokenId, message) {
    return sendMessageWithPromise(tokenId, 'system_sendchatmessage', { channel: 1, emojiId: 0, extra: null, msg: message, msgType: 1 }, 5000);
  }

  async function sendMessageToLegion(tokenId, message) {
    return sendMessageWithPromise(tokenId, 'system_sendchatmessage', { channel: 2, emojiId: 0, extra: null, msg: message, msgType: 1 }, 5000);
  }

  function sendGameMessage(tokenId, cmd, params = {}, options = {}) {
    if (options.usePromise) {
      return sendMessageWithPromise(tokenId, cmd, params, options.timeout);
    }
    return sendMessage(tokenId, cmd, params);
  }

  async function connectAll() {
    return taskApi.connectAll();
  }

  async function disconnectAll() {
    return taskApi.disconnectAll();
  }

  async function runDaily(tokenId) {
    return taskApi.runDaily(tokenId);
  }

  async function exportTokens() {
    return tokenApi.exportAll();
  }

  async function importTokens(data) {
    if (data.tokens && Array.isArray(data.tokens)) {
      const result = await tokenApi.importTokens(data.tokens);
      await refreshTokens();
      return { success: true, message: `成功导入 ${result.imported} 个Token` };
    }
    return { success: false, message: '导入数据格式错误' };
  }

  function importBase64Token(name, base64String, additionalInfo = {}) {
    const tokenData = { name, token: base64String, ...additionalInfo };
    return addToken(tokenData).then(t => ({
      success: true, token: t, tokenName: name, message: `Token "${name}" 导入成功`
    })).catch(e => ({
      success: false, error: e.message, message: `Token "${name}" 导入失败: ${e.message}`
    }));
  }

  async function clearAllTokens() {
    for (const t of tokens.value) {
      await tokenApi.remove(t.id);
    }
    tokens.value = [];
    selectedTokenId.value = '';
  }

  function cleanExpiredTokens() { return 0; }
  function upgradeTokenToPermanent() { return true; }
  function validateToken(t) { return t && typeof t === 'string' && t.trim().length >= 10; }
  function parseBase64Token(s) {
    try {
      const decoded = atob(s.replace(/^data:.*base64,/, '').trim());
      let data;
      try { data = JSON.parse(decoded); } catch { data = { token: decoded }; }
      const actualToken = data.token || data.gameToken || decoded;
      return { success: true, data: { ...data, actualToken } };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  function getCurrentTowerLevel() {
    const ri = gameData.value?.roleInfo;
    if (!ri?.role?.tower) return null;
    const t = ri.role.tower;
    return t.level || t.currentLevel || t.floor || t.stage;
  }

  function getTowerInfo() {
    return gameData.value?.roleInfo?.role?.tower || null;
  }

  function setBattleVersion(v) {
    const gd = gameDataMap.value[selectedTokenId.value];
    if (gd) gd.battleVersion = v;
  }

  function getBattleVersion() {
    return gameData.value?.battleVersion || null;
  }

  async function createTokenGroup(name, color = '#1677ff') {
    const group = await tokenApi.addGroup({ name, color });
    tokenGroups.value.push(group);
    return group;
  }

  async function deleteTokenGroup(groupId) {
    await tokenApi.removeGroup(groupId);
    tokenGroups.value = tokenGroups.value.filter(g => g.id !== groupId);
  }

  async function updateTokenGroup(groupId, updates) {
    await tokenApi.updateGroup(groupId, updates);
    await refreshGroups();
  }

  function addTokenToGroup(groupId, tokenId) {
    const g = tokenGroups.value.find(x => x.id === groupId);
    if (g && !g.tokenIds.includes(tokenId)) {
      g.tokenIds.push(tokenId);
      tokenApi.updateGroup(groupId, { tokenIds: g.tokenIds }).catch(() => {});
    }
  }

  function removeTokenFromGroup(groupId, tokenId) {
    const g = tokenGroups.value.find(x => x.id === groupId);
    if (g) {
      g.tokenIds = g.tokenIds.filter(id => id !== tokenId);
      tokenApi.updateGroup(groupId, { tokenIds: g.tokenIds }).catch(() => {});
    }
  }

  function getTokenGroups(tokenId) {
    return tokenGroups.value.filter(g => g.tokenIds.includes(tokenId));
  }

  function getGroupTokenIds(groupId) {
    const g = tokenGroups.value.find(x => x.id === groupId);
    return g ? g.tokenIds : [];
  }

  function getValidGroupTokenIds(groupId) {
    const ids = getGroupTokenIds(groupId);
    const valid = new Set(tokens.value.map(t => t.id));
    return ids.filter(id => valid.has(id));
  }

  function cleanupInvalidTokens() {
    const valid = new Set(tokens.value.map(t => t.id));
    tokenGroups.value.forEach(g => {
      g.tokenIds = g.tokenIds.filter(id => valid.has(id));
    });
  }

  function getConnectionStatus(id) {
    return connectionStatuses.value[id] || 'disconnected';
  }

  function getGameData(tokenId) {
    return gameDataMap.value[tokenId] || null;
  }

  function destroy() {
    if (pushClient) pushClient.disconnect();
  }

  return {
    tokens, gameTokens, selectedTokenId, connectionStatuses, gameDataMap, logs, taskProgress, tokenGroups,
    wsConnections, gameData,
    selectedToken, hasTokens, currentGameData, selectedTokenRoleInfo,
    init, initTokenStore, refreshTokens, refreshStatus, refreshGroups,
    addToken, removeToken, updateToken, selectToken,
    connectToken, disconnectToken, createWebSocketConnection, closeWebSocketConnection,
    sendMessage, sendMessageWithPromise, sendGameMessage,
    getWebSocketStatus, getWebSocketClient, setMessageListener, setShowMsg, sendHeartbeat,
    sendGetRoleInfo, sendGetDataBundleVersion, sendGetTeamInfo, sendSignIn, sendClaimDailyReward,
    sendMessageToWorld, sendMessageToLegion,
    connectAll, disconnectAll, runDaily,
    exportTokens, importTokens, importBase64Token, clearAllTokens,
    cleanExpiredTokens, upgradeTokenToPermanent, validateToken, parseBase64Token,
    getCurrentTowerLevel, getTowerInfo, setBattleVersion, getBattleVersion,
    createTokenGroup, deleteTokenGroup, updateTokenGroup,
    addTokenToGroup, removeTokenFromGroup, getTokenGroups, getGroupTokenIds, getValidGroupTokenIds, cleanupInvalidTokens,
    getConnectionStatus, getGameData, destroy,
  };
});
