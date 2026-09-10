<template>
  <section class="game-login">
    <header class="game-heading">
      <div><h1>游戏登录</h1><p>启动后点击窗口内的「功能」，导入 BIN 文件并选择账号登录。</p></div>
      <div class="game-actions">
        <n-button type="primary" :disabled="running" @click="start">启动游戏</n-button>
        <n-button :disabled="!running" @click="restart">重启</n-button>
        <n-button :disabled="!running" @click="stop">关闭</n-button>
        <n-button :disabled="!running" @click="fullscreen">全屏</n-button>
      </div>
    </header>
    <n-alert type="info" :show-icon="false">
      登录前请停止同一角色的批量任务、推关和强制在线，避免互相顶号。离开本页会关闭游戏；游戏窗口当前为静音。
    </n-alert>
    <p class="game-status" role="status">{{ status }}</p>
    <div ref="stage" class="game-stage">
      <iframe v-if="running" :key="generation" ref="frame" :src="gameUrl" title="咸鱼之王游戏窗口"
        allow="fullscreen; clipboard-write" referrerpolicy="no-referrer" @error="fail" />
      <div v-else class="game-empty"><strong>咸鱼之王</strong><p>单窗口游戏</p><n-button type="primary" @click="start">启动游戏</n-button></div>
    </div>
  </section>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { NAlert, NButton } from 'naive-ui';

const running = ref(false);
const generation = ref(0);
const frame = ref(null);
const stage = ref(null);
const status = ref('尚未启动');
let bootTimer;
const gameUrl = computed(() => {
  const url = new URL(`${import.meta.env.BASE_URL}game-launcher/game.html`, window.location.origin);
  url.search = new URLSearchParams({ slot: '1', storageScope: 'slot-1', parentOrigin: window.location.origin, restart: String(generation.value) });
  return url.href;
});
function start() {
  if (running.value) return;
  generation.value++;
  running.value = true;
  status.value = '正在加载游戏资源…';
  clearTimeout(bootTimer);
  bootTimer = setTimeout(() => { status.value = '加载时间较长，请查看窗口内提示，或重启后重试。'; }, 90000);
}
function stop() {
  clearTimeout(bootTimer);
  running.value = false;
  status.value = '游戏已关闭';
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
  if (data.event === 'scene-running') {
    clearTimeout(bootTimer);
    status.value = '游戏启动器已加载，请在窗口内登录。';
  } else if (data.event === 'boot-failed') fail();
}
onMounted(() => window.addEventListener('message', receive));
onBeforeUnmount(() => { clearTimeout(bootTimer); window.removeEventListener('message', receive); });
</script>

<style scoped>
.game-login { max-width: 1200px; margin: 0 auto; padding: 16px; }
.game-heading { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 16px; margin-bottom: 16px; }
h1 { margin: 0 0 8px; font-size: 24px; }
.game-heading p, .game-status { color: var(--text-secondary, #777); }
.game-heading p { margin: 0; }
.game-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.game-stage { width: min(100%, 420px); aspect-ratio: 9 / 16; margin: auto; overflow: hidden; border-radius: 12px; background: #151820; box-shadow: 0 8px 30px #0002; }
.game-stage iframe { width: 100%; height: 100%; border: 0; display: block; }
.game-empty { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; color: #fff; }
.game-empty strong { font-size: 28px; }
.game-stage:fullscreen { width: 100%; height: 100%; border-radius: 0; display: flex; justify-content: center; }
.game-stage:fullscreen iframe { width: min(100%, 56.25vh); }
@media (max-width: 600px) { .game-login { padding: 8px; } .game-stage { border-radius: 8px; } }
</style>
