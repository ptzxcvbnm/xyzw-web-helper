<template>
  <section class="game-login">
    <header class="game-heading">
      <div><h1>游戏登录</h1><p>选择助手中已导入的账号，启动后自动登录。</p></div>
      <div class="game-actions">
        <n-button type="primary" :disabled="running || !selectedId" :loading="loading" @click="start">登录并启动</n-button>
        <n-button :disabled="!running" @click="restart">重启</n-button>
        <n-button :disabled="!running" @click="stop">关闭</n-button>
        <n-button :disabled="!running" @click="fullscreen">全屏</n-button>
      </div>
    </header>
    <div class="account-picker">
      <label for="game-account">登录账号</label>
      <n-select :input-props="{ id: 'game-account' }" v-model:value="selectedId" :options="accountOptions" filterable
        :disabled="running || loading" :loading="refreshing" placeholder="选择已导入的账号" />
      <n-button :disabled="running || loading" :loading="refreshing" @click="refreshAccounts">刷新账号</n-button>
      <router-link to="/tokens">管理账号</router-link>
    </div>
    <p v-if="!refreshing && !accounts.length">暂无账号，请先在「Token管理」中导入 BIN 或扫码添加账号。</p>
    <n-alert type="info" :show-icon="false">
      登录前请停止同一角色的批量任务、推关和强制在线，避免互相顶号。离开本页会关闭游戏；游戏窗口当前为静音。
    </n-alert>
    <p class="game-status" role="status">{{ status }}</p>
    <div class="game-workbench">
      <section class="packet-observer" aria-labelledby="packet-observer-title">
        <header class="packet-observer-heading">
          <div>
            <h2 id="packet-observer-title">报文观察</h2>
            <p>自动按请求 seq 与响应 resp 配对；只读观察，不修改或重放。</p>
          </div>
          <div class="packet-observer-actions">
            <span>{{ packetObserverLabel }}</span>
            <n-switch v-model:value="packetObserverEnabled" @update:value="setPacketObserverEnabled" />
            <n-button size="small" :disabled="!packetEntries.length" @click="clearPacketEntries">清空</n-button>
          </div>
        </header>
        <p v-if="packetObserverEnabled && !running" class="packet-observer-hint">将在下次启动游戏时从第一条报文开始观察。</p>
        <div class="packet-tools">
          <n-input v-model:value="packetFilter" size="small" clearable placeholder="筛选命令或业务数据" />
          <n-input v-model:value="packetActionLabel" size="small" clearable placeholder="操作名称，例如：领取挂机奖励" />
          <n-button size="small" type="primary" :disabled="!packetObserverEnabled" @click="startPacketMarker">开始标记</n-button>
          <n-button size="small" :disabled="!activePacketMarker" @click="stopPacketMarker">结束标记</n-button>
          <n-button size="small" :disabled="!packetEntries.length" @click="exportPacketReport">脱敏导出</n-button>
        </div>
        <p v-if="activePacketMarker" class="packet-marker-status">正在标记：{{ activePacketMarker }}</p>
        <div v-if="packetTransactions.length" class="packet-table-wrap transaction-wrap">
          <table class="packet-table transaction-table">
            <thead>
              <tr><th>操作标记</th><th>时间</th><th>请求命令</th><th>seq</th><th>请求参数</th><th>响应命令</th><th>配对状态</th><th>响应数据</th></tr>
            </thead>
            <tbody>
              <tr v-for="request in packetTransactions" :key="request.key">
                <td>{{ request.marker || '-' }}</td>
                <td>{{ request.time }}</td>
                <td><code>{{ request.cmd }}</code></td>
                <td>{{ displayValue(request.seq) }}</td>
                <td><pre>{{ request.body }}</pre></td>
                <td><code>{{ request.response?.cmd || '-' }}</code></td>
                <td>
                  <span :class="['pair-status', request.response ? 'paired' : 'waiting']">{{ formatPairStatus(request) }}</span>
                </td>
                <td><pre>{{ request.response?.body || '' }}</pre></td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-else class="packet-observer-empty">{{ packetObserverEnabled ? '等待符合筛选条件的请求报文…' : '开启后显示最近 200 条非心跳报文。' }}</p>
        <details v-if="unpairedPacketEntries.length" class="unpaired-packets">
          <summary>未配对的接收/推送报文（{{ unpairedPacketEntries.length }}）</summary>
          <div class="packet-table-wrap unpaired-wrap">
            <table class="packet-table">
              <thead><tr><th>标记</th><th>时间</th><th>命令</th><th>seq</th><th>code</th><th>大小</th><th>业务数据</th></tr></thead>
              <tbody>
                <tr v-for="entry in unpairedPacketEntries" :key="entry.key">
                  <td>{{ entry.marker || '-' }}</td><td>{{ entry.time }}</td><td><code>{{ entry.cmd }}</code></td>
                  <td>{{ displayValue(entry.seq) }}</td><td>{{ displayValue(entry.code) }}</td><td>{{ formatBytes(entry.byteLength) }}</td>
                  <td><pre>{{ entry.body }}</pre></td>
                </tr>
              </tbody>
            </table>
          </div>
        </details>
      </section>
      <div ref="stage" class="game-stage">
        <div v-if="running" class="game-viewport" :style="gameViewportStyle">
          <iframe :key="generation" ref="frame" :src="gameUrl" :width="GAME_WIDTH" :height="GAME_HEIGHT"
            title="咸鱼之王游戏窗口" allow="fullscreen; clipboard-write" referrerpolicy="no-referrer"
            @load="sendAccount" @error="fail" />
        </div>
        <div v-else class="game-empty"><strong>咸鱼之王</strong><p>在上方选择账号后登录</p></div>
      </div>
    </div>
  </section>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { NAlert, NButton, NInput, NSelect, NSwitch } from 'naive-ui';
import { tokenApi } from '@/api/serverApi';
import { g_utils } from '@/utils/bonProtocol';
import { pairObservedPacket, redactSensitive } from '@/utils/packetTransactions';

const GAME_WIDTH = 720;
const GAME_HEIGHT = 1280;
const running = ref(false);
const generation = ref(0);
const frame = ref(null);
const stage = ref(null);
const gameScale = ref(1);
const status = ref('尚未启动');
const accounts = ref([]);
const selectedId = ref(null);
const loading = ref(false);
const refreshing = ref(false);
const packetObserverEnabled = ref(false);
const packetObserverReady = ref(false);
const packetEntries = ref([]);
const packetFilter = ref('');
const packetActionLabel = ref('');
const activePacketMarker = ref('');
const accountOptions = computed(() => accounts.value.map(account => ({ value: account.id, label: account.server ? `${account.name} · ${account.server}` : account.name })));
const packetObserverLabel = computed(() => {
  if (!packetObserverEnabled.value) return '已关闭';
  if (!running.value) return '待启动';
  return packetObserverReady.value ? '观察中' : '正在连接观察器…';
});
const packetTransactions = computed(() => packetEntries.value.filter(entry => (
  entry.direction === 'send' && packetMatchesFilter(entry)
)));
const unpairedPacketEntries = computed(() => packetEntries.value.filter(entry => (
  entry.direction === 'receive' && !entry.requestKey && packetMatchesFilter(entry)
)));
const gameViewportStyle = computed(() => ({ transform: `translate(-50%, -50%) scale(${gameScale.value})` }));
let binData = null;
let operation = 0;
let disposed = false;
let observerEnabledAtLaunch = false;
let packetMarkerIndex = 0;
let bootTimer;
let stageResizeObserver;
const gameUrl = computed(() => {
  const url = new URL(`${import.meta.env.BASE_URL}game-launcher/game.html`, window.location.origin);
  url.search = new URLSearchParams({
    slot: '1',
    storageScope: 'slot-1',
    parentOrigin: window.location.origin,
    restart: String(generation.value),
    packetObserver: observerEnabledAtLaunch ? '1' : '0',
  });
  return url.href;
});
async function refreshAccounts() {
  refreshing.value = true;
  try {
    const result = await tokenApi.getAll();
    if (disposed) return;
    accounts.value = result;
    if (!result.some(account => account.id === selectedId.value)) selectedId.value = result[0]?.id || null;
  } catch { status.value = '读取账号失败，请检查登录状态后刷新重试。'; }
  finally { refreshing.value = false; }
}
async function start() {
  if (running.value || loading.value || !selectedId.value) return;
  const current = ++operation;
  loading.value = true;
  status.value = '正在读取所选账号…';
  try {
    const data = await tokenApi.getBin(selectedId.value);
    if (disposed || current !== operation) return;
    if (!(data instanceof ArrayBuffer) || !data.byteLength || data.byteLength > 2 * 1024 * 1024) throw new Error('invalid-bin');
    binData = data;
  } catch (error) {
    if (disposed || current !== operation) return;
    status.value = error.response?.status === 404
      ? '该账号没有原始登录数据，请到 Token管理重新导入 BIN 或扫码添加。'
      : '读取登录数据失败，请刷新账号后重试。';
    return;
  } finally { if (current === operation) loading.value = false; }
  observerEnabledAtLaunch = packetObserverEnabled.value;
  packetObserverReady.value = false;
  generation.value++;
  running.value = true;
  status.value = '正在加载游戏资源…';
  await nextTick();
  updateGameScale();
  clearTimeout(bootTimer);
  bootTimer = setTimeout(() => { status.value = '加载时间较长，请查看窗口内提示，或重启后重试。'; }, 90000);
}
function stop() {
  operation++;
  loading.value = false;
  binData = null;
  clearTimeout(bootTimer);
  running.value = false;
  packetObserverReady.value = false;
  status.value = '游戏已关闭';
}
function sendAccount() {
  if (!running.value || !frame.value?.contentWindow) return;
  syncPacketObserver();
  if (!binData) return;
  frame.value.contentWindow.postMessage({ type: 'xyzw-game-account', bin: binData }, window.location.origin);
}
function syncPacketObserver() {
  if (!running.value || !frame.value?.contentWindow) return;
  frame.value.contentWindow.postMessage({
    type: 'audited-instance-command',
    command: 'packet-observer',
    value: packetObserverEnabled.value,
  }, window.location.origin);
}
function setPacketObserverEnabled(value) {
  packetObserverEnabled.value = value === true;
  if (running.value) syncPacketObserver();
}
function clearPacketEntries() { packetEntries.value = []; }
function packetMatchesFilter(entry) {
  const keyword = packetFilter.value.trim().toLowerCase();
  if (!keyword) return true;
  return [
    entry.marker,
    entry.cmd,
    entry.body,
    entry.response?.cmd,
    entry.response?.body,
  ].some(value => String(value || '').toLowerCase().includes(keyword));
}
function startPacketMarker() {
  const label = packetActionLabel.value.trim() || `操作 ${++packetMarkerIndex}`;
  packetActionLabel.value = label;
  activePacketMarker.value = label;
}
function stopPacketMarker() { activePacketMarker.value = ''; }
function displayValue(value) { return value === undefined || value === null || value === '' ? '-' : value; }
function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
}
function safeStringify(value) {
  if (value === undefined) return '';
  try {
    const text = JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? String(item) : item, 2);
    if (!text) return String(value);
    return text.length > 2000 ? `${text.slice(0, 2000)}\n…（显示已截断）` : text;
  } catch { return '[业务数据无法显示]'; }
}
function formatPairStatus(request) {
  if (!request.response) return '等待响应';
  const code = request.response.code;
  const suffix = code !== undefined && code !== null && Number(code) !== 0 ? ` · code ${code}` : '';
  return `${request.rtt} ms${suffix}`;
}
function exportPacketReport() {
  const transactions = packetTransactions.value.map(request => ({
    marker: request.marker || null,
    request: {
      capturedAt: request.capturedAt,
      cmd: request.cmd,
      seq: request.seq,
      ack: request.ack,
      byteLength: request.byteLength,
      body: request.bodyData,
    },
    response: request.response ? {
      capturedAt: request.response.capturedAt,
      cmd: request.response.cmd,
      seq: request.response.seq,
      ack: request.response.ack,
      resp: request.response.resp,
      code: request.response.code,
      byteLength: request.response.byteLength,
      body: request.response.bodyData,
      rttMs: request.rtt,
    } : null,
  }));
  const pushes = unpairedPacketEntries.value.map(entry => ({
    marker: entry.marker || null,
    capturedAt: entry.capturedAt,
    cmd: entry.cmd,
    seq: entry.seq,
    ack: entry.ack,
    code: entry.code,
    byteLength: entry.byteLength,
    body: entry.bodyData,
  }));
  const report = {
    format: 'xyzw-packet-observer-v1',
    exportedAt: new Date().toISOString(),
    filter: packetFilter.value || null,
    transactions,
    unpairedPackets: pushes,
  };
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `xyzw-packets-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
function parseObservedPacket(data) {
  if (data.kind === 'omitted' || data.kind === 'unreadable' || data.kind === 'unsupported') {
    throw new Error(data.error || '报文内容不可用');
  }
  if (data.kind === 'text') return JSON.parse(data.payload);
  if (!(data.payload instanceof ArrayBuffer)) throw new Error('二进制报文缺失');
  return g_utils.parse(data.payload, 'auto');
}
function addObservedPacket(data) {
  let packet;
  try {
    packet = parseObservedPacket(data);
    const raw = packet?._raw || packet || {};
    const cmd = String(raw.cmd || packet?.cmd || '').toLowerCase();
    if (cmd === '_sys/ack' || cmd === 'heart_beat') return;
    const businessData = packet?.rawData !== undefined ? packet.rawData : raw.body;
    const safeBusinessData = redactSensitive(businessData);
    const entry = {
      key: `${data.connectionId}-${data.frameId}-${data.direction}`,
      connectionId: data.connectionId,
      capturedAt: data.capturedAt || Date.now(),
      time: new Date(data.capturedAt || Date.now()).toLocaleTimeString(),
      direction: data.direction,
      marker: activePacketMarker.value,
      cmd: cmd || '未命名',
      seq: raw.seq,
      ack: raw.ack,
      resp: raw.resp,
      code: raw.code,
      byteLength: data.byteLength,
      bodyData: safeBusinessData,
      body: safeStringify(safeBusinessData),
      response: null,
      requestKey: null,
      rtt: null,
    };
    packetEntries.value.unshift(entry);
    pairObservedPacket(packetEntries.value, packetEntries.value[0]);
  } catch (error) {
    packetEntries.value.unshift({
      key: `${data.connectionId}-${data.frameId}-${data.direction}`,
      connectionId: data.connectionId,
      capturedAt: data.capturedAt || Date.now(),
      time: new Date(data.capturedAt || Date.now()).toLocaleTimeString(),
      direction: data.direction,
      marker: activePacketMarker.value,
      cmd: '未解码',
      seq: null,
      ack: null,
      resp: null,
      code: null,
      byteLength: data.byteLength,
      bodyData: { error: error.message || '报文解析失败' },
      body: error.message || '报文解析失败',
      response: null,
      requestKey: null,
      rtt: null,
    });
  }
  if (packetEntries.value.length > 200) packetEntries.value.length = 200;
}
function restart() { stop(); start(); }
function fail() {
  clearTimeout(bootTimer);
  status.value = '游戏启动失败，请查看窗口内提示，或重启后重试。';
}
function updateGameScale() {
  if (!stage.value) return;
  const width = stage.value.clientWidth;
  const height = stage.value.clientHeight;
  if (!width || !height) return;
  gameScale.value = Math.min(width / GAME_WIDTH, height / GAME_HEIGHT);
}
async function fullscreen() {
  try {
    if (stage.value?.requestFullscreen) await stage.value.requestFullscreen();
    else status.value = '当前浏览器不支持全屏，请直接使用游戏窗口。';
  } catch { status.value = '未能进入全屏，请直接使用游戏窗口。'; }
}
function receive(event) {
  if (!running.value || event.source !== frame.value?.contentWindow || event.origin !== window.location.origin) return;
  const data = event.data;
  if (data?.type !== 'audited-game-instance' || data.slot !== 1) return;
  if (data.event === 'packet-observer-ready') {
    packetObserverReady.value = true;
    syncPacketObserver();
  } else if (data.event === 'packet-observer-state') {
    packetObserverReady.value = true;
  } else if (data.event === 'packet-observer-frame' && packetObserverEnabled.value) {
    addObservedPacket(data);
  } else if (data.event === 'account-bridge-ready') { sendAccount(); }
  else if (data.event === 'account-login-started') {
    status.value = '正在登录所选账号…';
  } else if (data.event === 'account-login-success') {
    binData = null;
    clearTimeout(bootTimer);
    status.value = '账号登录成功';
  } else if (data.event === 'account-data-invalid' || data.event === 'account-login-failed') {
    binData = null;
    clearTimeout(bootTimer);
    status.value = '账号登录失败，请关闭游戏后在 Token管理重新导入账号。';
  } else if (data.event === 'scene-running' && status.value === '正在加载游戏资源…') {
    status.value = '游戏资源已加载，正在准备登录…';
  } else if (data.event === 'boot-failed') fail();
}
onMounted(() => {
  window.addEventListener('message', receive);
  window.addEventListener('resize', updateGameScale);
  if (typeof ResizeObserver !== 'undefined' && stage.value) {
    stageResizeObserver = new ResizeObserver(updateGameScale);
    stageResizeObserver.observe(stage.value);
  }
  updateGameScale();
  refreshAccounts();
});
onBeforeUnmount(() => {
  disposed = true;
  operation++;
  binData = null;
  clearTimeout(bootTimer);
  stageResizeObserver?.disconnect();
  window.removeEventListener('resize', updateGameScale);
  window.removeEventListener('message', receive);
});
</script>

<style scoped>
.game-login { max-width: 1440px; margin: 0 auto; padding: 16px; }
.game-heading { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 16px; margin-bottom: 16px; }
h1 { margin: 0 0 8px; font-size: 24px; }
.game-heading p, .game-status { color: var(--text-secondary, #777); }
.game-heading p { margin: 0; }
.game-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.account-picker { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; margin-bottom: 16px; }
.account-picker .n-select { flex: 1; min-width: 200px; }
.game-workbench { display: grid; grid-template-columns: minmax(320px, 420px) minmax(0, 1fr); grid-template-areas: "game observer"; align-items: start; gap: 16px; margin-top: 16px; }
.packet-observer { grid-area: observer; min-width: 0; padding: 12px; border: 1px solid var(--border-color, #ddd); border-radius: 10px; }
.packet-observer-heading { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; }
.packet-observer-heading h2 { margin: 0 0 4px; font-size: 18px; }
.packet-observer-heading p, .packet-observer-hint, .packet-observer-empty { margin: 0; color: var(--text-secondary, #777); }
.packet-observer-actions { display: flex; align-items: center; gap: 10px; }
.packet-observer-hint, .packet-observer-empty { margin-top: 10px; }
.packet-tools { display: grid; grid-template-columns: minmax(150px, .8fr) minmax(220px, 1fr) auto auto auto; gap: 8px; margin-top: 12px; }
.packet-marker-status { margin: 8px 0 0; color: #18a058; font-weight: 600; }
.packet-table-wrap { margin-top: 12px; overflow: auto; touch-action: pan-x pan-y; overscroll-behavior-x: contain; -webkit-overflow-scrolling: touch; border: 1px solid var(--border-color, #ddd); border-radius: 8px; }
.transaction-wrap { max-height: 520px; }
.unpaired-wrap { max-height: 180px; }
.packet-table { width: 100%; min-width: 980px; border-collapse: collapse; font-size: 12px; }
.transaction-table { min-width: 1220px; }
.packet-table th, .packet-table td { padding: 7px 8px; border-bottom: 1px solid var(--border-color, #eee); text-align: left; vertical-align: top; white-space: nowrap; }
.packet-table th { position: sticky; top: 0; z-index: 1; background: var(--card-color, #fff); }
.packet-table pre { width: 300px; max-height: 140px; margin: 0; overflow: auto; white-space: pre-wrap; word-break: break-all; }
.packet-direction { display: inline-block; min-width: 36px; padding: 1px 5px; border-radius: 4px; text-align: center; }
.packet-direction.send { color: #8a4b08; background: #fff2d6; }
.packet-direction.receive { color: #17633a; background: #dcf7e8; }
.pair-status { display: inline-block; padding: 2px 6px; border-radius: 4px; }
.pair-status.paired { color: #17633a; background: #dcf7e8; }
.pair-status.waiting { color: #8a4b08; background: #fff2d6; }
.unpaired-packets { margin-top: 12px; }
.unpaired-packets summary { cursor: pointer; color: var(--text-secondary, #777); }
.game-stage { grid-area: game; position: relative; width: min(100%, 420px); aspect-ratio: 9 / 16; margin: 0 auto; overflow: hidden; border-radius: 12px; background: #151820; box-shadow: 0 8px 30px #0002; }
.game-viewport { position: absolute; left: 50%; top: 50%; width: 720px; height: 1280px; transform-origin: center; }
.game-viewport iframe { width: 720px; height: 1280px; border: 0; display: block; }
.game-empty { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; color: #fff; }
.game-empty strong { font-size: 28px; }
.game-stage:fullscreen { width: 100%; height: 100%; border-radius: 0; }
@media (max-width: 1000px) {
  .game-workbench { grid-template-columns: 1fr; grid-template-areas: "game" "observer"; }
  .packet-tools { grid-template-columns: 1fr 1fr auto auto; }
  .packet-tools > :last-child { grid-column: 1 / -1; }
}
@media (max-width: 600px) {
  .game-login { padding: 8px; }
  .game-stage { border-radius: 8px; }
  .packet-tools { grid-template-columns: 1fr 1fr; }
  .packet-tools > :nth-child(-n+2) { grid-column: 1 / -1; }
  .packet-tools > :last-child { grid-column: 1 / -1; }
}
</style>
