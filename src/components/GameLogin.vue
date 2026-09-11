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
    <div ref="stage" class="game-stage">
      <iframe v-if="running" :key="generation" ref="frame" :src="gameUrl" title="咸鱼之王游戏窗口"
        allow="fullscreen; clipboard-write" referrerpolicy="no-referrer" @load="sendAccount" @error="fail" />
      <div v-else class="game-empty"><strong>咸鱼之王</strong><p>在上方选择账号后登录</p></div>
    </div>
  </section>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { NAlert, NButton, NSelect } from 'naive-ui';
import { tokenApi } from '@/api/serverApi';

const running = ref(false);
const generation = ref(0);
const frame = ref(null);
const stage = ref(null);
const status = ref('尚未启动');
const accounts = ref([]);
const selectedId = ref(null);
const loading = ref(false);
const refreshing = ref(false);
const accountOptions = computed(() => accounts.value.map(account => ({ value: account.id, label: account.server ? `${account.name} · ${account.server}` : account.name })));
let binData = null;
let operation = 0;
let disposed = false;
let bootTimer;
const gameUrl = computed(() => {
  const url = new URL(`${import.meta.env.BASE_URL}game-launcher/game.html`, window.location.origin);
  url.search = new URLSearchParams({ slot: '1', storageScope: 'slot-1', parentOrigin: window.location.origin, restart: String(generation.value) });
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
  generation.value++;
  running.value = true;
  status.value = '正在加载游戏资源…';
  clearTimeout(bootTimer);
  bootTimer = setTimeout(() => { status.value = '加载时间较长，请查看窗口内提示，或重启后重试。'; }, 90000);
}
function stop() {
  operation++;
  loading.value = false;
  binData = null;
  clearTimeout(bootTimer);
  running.value = false;
  status.value = '游戏已关闭';
}
function sendAccount() {
  if (!running.value || !binData || !frame.value?.contentWindow) return;
  frame.value.contentWindow.postMessage({ type: 'xyzw-game-account', bin: binData }, window.location.origin);
}
function restart() { stop(); start(); }
function fail() {
  clearTimeout(bootTimer);
  status.value = '游戏启动失败，请查看窗口内提示，或重启后重试。';
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
  if (data.event === 'account-bridge-ready') { sendAccount(); }
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
onMounted(() => { window.addEventListener('message', receive); refreshAccounts(); });
onBeforeUnmount(() => { disposed = true; operation++; binData = null; clearTimeout(bootTimer); window.removeEventListener('message', receive); });
</script>

<style scoped>
.game-login { max-width: 1200px; margin: 0 auto; padding: 16px; }
.game-heading { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 16px; margin-bottom: 16px; }
h1 { margin: 0 0 8px; font-size: 24px; }
.game-heading p, .game-status { color: var(--text-secondary, #777); }
.game-heading p { margin: 0; }
.game-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.account-picker { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; margin-bottom: 16px; }
.account-picker .n-select { flex: 1; min-width: 200px; }
.game-stage { width: min(100%, 420px); aspect-ratio: 9 / 16; margin: auto; overflow: hidden; border-radius: 12px; background: #151820; box-shadow: 0 8px 30px #0002; }
.game-stage iframe { width: 100%; height: 100%; border: 0; display: block; }
.game-empty { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; color: #fff; }
.game-empty strong { font-size: 28px; }
.game-stage:fullscreen { width: 100%; height: 100%; border-radius: 0; display: flex; justify-content: center; }
.game-stage:fullscreen iframe { width: min(100%, 56.25vh); }
@media (max-width: 600px) { .game-login { padding: 8px; } .game-stage { border-radius: 8px; } }
</style>
