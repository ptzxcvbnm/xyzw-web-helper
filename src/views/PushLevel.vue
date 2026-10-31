<!-- Adapted from https://github.com/w1249178256/xyzw_web_helper/blob/main/src/views/PushingLevels.vue (CC BY-NC-SA 4.0). -->
<template>
  <div class="pushing-levels-page">
    <div class="pl-header">
      <div>
        <h2>战斗推关</h2>
        <p>主线推图 · 服务器后台运行，关闭网页后继续</p>
      </div>
      <div class="pl-header-actions">
        <n-switch v-model:value="autoContinue" size="small">
          <template #checked>自动继续</template>
          <template #unchecked>过一关停止</template>
        </n-switch>
        <n-button size="small" :loading="loadingAll" @click="refreshAll">刷新状态</n-button>
      </div>
    </div>

    <n-alert type="info">
      普通推关按服务器计时结算；模拟推关会提前跳过预测失败局，预测胜局仍等待正常结算时间。
      两种模式均在后台运行。重连等待设为 0 时，掉线自动停止。设置在下次启动时生效。
    </n-alert>

    <!-- 账号列表（上方，勾选模式，4个一行，简洁） -->
    <n-card class="account-card-top" :content-style="{ padding: '12px 16px' }">
      <div class="account-toolbar">
        <n-input
          v-model:value="searchKeyword"
          clearable
          size="tiny"
          placeholder="搜索账号"
          class="search-input"
        />
        <n-checkbox
          :checked="allVisibleSelected"
          :indeterminate="someVisibleSelected"
          @update:checked="toggleAllVisible"
        >
          全选
        </n-checkbox>
        <div v-if="tokenGroups.length" class="group-list-inline">
          <button
            v-for="group in tokenGroups"
            :key="group.id"
            class="group-chip"
            :class="{ selected: selectedGroupIds.includes(group.id) }"
            :style="groupChipStyle(group)"
            @click="toggleGroup(group)"
          >
            {{ group.name }}
          </button>
        </div>
      </div>

      <div v-if="filteredTokens.length" class="token-grid">
        <div
          v-for="gameToken in filteredTokens"
          :key="gameToken.id"
          class="token-cell"
          :class="{ selected: selectedTokenIds.includes(gameToken.id) }"
          @click="toggleToken(gameToken.id, !selectedTokenIds.includes(gameToken.id))"
        >
          <n-checkbox
            :checked="selectedTokenIds.includes(gameToken.id)"
            @update:checked="(checked) => toggleToken(gameToken.id, checked)"
            @click.stop
          />
          <span class="token-server" :title="gameToken.server || '未知区服'">
            {{ gameToken.server || "未知区服" }}
          </span>
          <span class="token-sep">-</span>
          <span class="token-name" :title="gameToken.name || gameToken.id">
            {{ gameToken.name || gameToken.id }}
          </span>
          <span
            class="status-dot"
            :class="getStatusClass(gameToken.id)"
            :title="getStatusTitle(gameToken.id)"
          ></span>
        </div>
      </div>
      <n-empty v-else description="暂无账号" size="small" />
    </n-card>

    <!-- 操作区：火把配置 + 控制按钮（同行） -->
    <n-card class="control-card" :content-style="{ padding: '12px 16px' }">
      <div class="control-row">
        <div class="torch-field">
          <span class="torch-label">推关模式</span>
          <n-select v-model:value="pushMode" :options="modeOptions" size="small" class="mode-select" />
        </div>
        <div class="torch-field">
          <span class="torch-label">掉线重连等待（分钟，0 为停止）</span>
          <n-input-number v-model:value="reconnectMinutes" :min="0" :max="1440" :precision="0" size="small" class="reconnect-input" />
        </div>
        <div class="torch-field">
          <span class="torch-label">连续失败上限</span>
          <n-input-number
            v-model:value="maxRetries"
            :min="1"
            :max="999999"
            :precision="0"
            size="small"
            class="retry-input"
          />
        </div>
        <div class="torch-field">
          <span class="torch-label">火把类型</span>
          <n-select
            v-model:value="torchItemId"
            :options="torchOptions"
            size="small"
            class="torch-select"
          />
        </div>
        <div class="torch-field">
          <span class="torch-label">使用数量（1-999）</span>
          <n-input-number
            v-model:value="torchQuantity"
            :min="1"
            :max="999"
            :precision="0"
            size="small"
            class="torch-input"
          />
        </div>
        <n-button
          size="small"
          type="primary"
          :disabled="!hasSelectedRunning"
          :loading="torchRunning"
          @click="useTorchForSelected"
        >
          使用火把
        </n-button>
        <n-button
          type="primary"
          size="small"
          :disabled="!selectedTokenIds.length || allSelectedRunning"
          :loading="startingBatch"
          @click="startSelected"
        >
          开始推图
        </n-button>
        <n-button
          type="error"
          size="small"
          :disabled="!hasSelectedRunning"
          :loading="stoppingBatch"
          @click="stopSelected"
        >
          停止所选
        </n-button>
        <div class="control-spacer"></div>
        <span class="status-text"
          >已选择 {{ selectedTokenIds.length }} 个账号，正在推图
          {{ runningCount }} 个账号</span
        >
        <n-button size="small" @click="clearSelection">清除选择</n-button>
      </div>
    </n-card>

    <!-- 推图卡片区 -->
    <div v-if="runningCards.length" class="running-section">
      <n-card
        v-for="card in runningCards"
        :key="card.tokenId"
        class="running-card"
        :class="{ active: card.running }"
      >
        <div class="running-head">
          <div class="card-title">
            <strong :title="card.tokenName">{{ card.tokenName }}</strong>
            <span
              class="status-dot small"
              :class="getStatusClass(card.tokenId)"
              :title="getStatusTitle(card.tokenId)"
            ></span>
          </div>
          <n-space size="small">
            <n-tag size="small" type="success">通过 {{ card.passed }}</n-tag>
            <n-tag size="small" type="error">结算失败 {{ card.losses }}</n-tag>
            <n-tag
              size="small"
              type="warning"
              title="连续失败次数：自上次胜利起累计，达到最大失败次数后自动停止推图"
            >
              连败 {{ card.failStreak }}/{{ card.maxFail || maxRetries }}
            </n-tag>
          </n-space>
        </div>
        <n-space size="small" class="mode-tags">
          <n-tag size="small" :type="card.accelerated ? 'info' : 'default'">{{ card.accelerated ? '模拟推关' : '普通推关' }}</n-tag>
          <n-tag size="small" :type="card.reconnecting ? 'warning' : card.running ? 'success' : 'default'">{{ phaseLabel(card) }}</n-tag>
          <n-tag v-if="card.accelerated" size="small">模拟 {{ card.simulationAttempts || 0 }} 局 · 预测失败 {{ card.predictedLosses || 0 }}</n-tag>
        </n-space>
        <div class="level-line">
          当前关卡：{{ card.level > 0 ? `${card.level}关` : "--" }}
        </div>
        <div class="level-line">boss：{{ card.bossName || "--" }}</div>
        <div class="level-line torch-line">{{ getTorchLabel(card) }}</div>
        <div v-if="card.running" class="latest-message">{{ card.lastMsg }}</div>
        <div class="running-body">
          <template v-if="card.running">
            <div class="countdown-row">

              <span class="countdown-text"
                >{{ countdownLabel(card) }}</span
              >
              <n-progress
                v-if="card.countdown > 0"
                class="inline-progress"
                type="line"
                :percentage="progressPercent(card)"
                :show-indicator="false"
                :height="8"
                status="success"
              />
            </div>
            <div class="card-actions">
              <span>已结算 {{ card.passed + card.losses }} 场</span>
              <n-button size="tiny" type="error" :loading="busy[card.tokenId] === 'stop'" @click="stopOne(card.tokenId)"
                >停止</n-button
              >
            </div>
          </template>
          <template v-else>
            <div class="waiting-line">{{ card.stopReason || "等待推图" }}</div>
            <div class="card-actions">
              <span class="err-text" :title="card.lastMsg || '无'">
                最近信息：{{ card.lastMsg || "无" }}
              </span>
              <n-button
                size="tiny"
                type="primary"
                :loading="busy[card.tokenId] === 'start'"
                @click="startOne(card.tokenId)"
                >启动</n-button
              >
            </div>
          </template>
        </div>
      </n-card>
    </div>

    <!-- 推图日志区 -->
    <n-card class="log-card" :content-style="{ padding: '12px 16px' }">
      <template #header>
        <div class="log-header">
          <div>
            推图日志
            <n-tag size="small">{{ logs.length }}/2000 条</n-tag>
          </div>
          <div class="log-actions">
            <n-checkbox v-model:checked="autoScroll" size="small"
              >自动滚动</n-checkbox
            >
            <n-checkbox v-model:checked="onlyErrors" size="small"
              >只看异常</n-checkbox
            >
            <n-button size="tiny" @click="clearLogs">清空</n-button>
          </div>
        </div>
      </template>
      <div class="log-filter">
        <span class="log-filter-label">筛选账号：</span>
        <n-select
          v-model:value="logFilterTokenId"
          :options="logFilterOptions"
          size="small"
          clearable
          placeholder="全部账号"
          class="log-filter-select"
        />
        <n-button
          size="tiny"
          :disabled="!logFilterTokenId"
          @click="logFilterTokenId = null"
        >
          清除筛选
        </n-button>
        <span class="log-filter-count">共 {{ visibleLogs.length }} 条</span>
      </div>
      <div ref="logsContainer" class="log-container">
        <div
          v-for="(log, logIndex) in visibleLogs"
          :key="log.id || logIndex"
          class="log-item"
          :class="log.type"
        >
          <span class="log-time">{{ formatLogTime(log.ts) }}</span>
          <span class="log-name">[{{ log.tokenName }}]</span>
          <span class="log-msg">{{ log.msg }}</span>
        </div>
        <n-empty
          v-if="!visibleLogs.length"
          description="暂无日志"
          size="small"
        />
      </div>
    </n-card>
  </div>
</template>

<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useMessage } from 'naive-ui';
import { tokenApi, statusApi, pushLevelApi, ServerPushClient } from '@/api/serverApi';
import { BOSS_NAMES } from '@/utils/pushLevelBossNames';

// Layout adapted from w1249178256/xyzw_web_helper, src/views/PushingLevels.vue.
// CC BY-NC-SA 4.0. Browser battle loops replaced with our server task APIs.
const message = useMessage();
const tokens = ref([]);
const tokenGroups = ref([]);
const selectedTokenIds = ref([]);
const searchKeyword = ref('');
const autoContinue = ref(true);
const maxRetries = ref(20);
const reconnectMinutes = ref(0);
const pushMode = ref('normal');
const loadingAll = ref(false);
const startingBatch = ref(false);
const stoppingBatch = ref(false);
const busy = ref({});
const statusMap = ref({});
const connectionMap = ref({});
const logs = ref([]);
const logsContainer = ref(null);
const logFilterTokenId = ref(null);
const autoScroll = ref(true);
const onlyErrors = ref(false);
const torchRunning = ref(false);
const torchItemId = ref(1008);
const torchQuantity = ref(1);
const tickNow = ref(Date.now());
const torchOptions = [
  { label: '木材火把', value: 1008 },
  { label: '青铜火把', value: 1009 },
  { label: '咸神火把', value: 1010 },
];
const modeOptions = [
  { label: '普通推关', value: 'normal' },
  { label: '模拟推关（加速）', value: 'accelerated' },
];
let pushClient;
let tickTimer;
let refreshTimer;
let disposed = false;
let batchGeneration = 0;
let clearedBefore = 0;

const tokenIds = computed(() => new Set(tokens.value.map(t => t.id)));
const filteredTokens = computed(() => {
  const keyword = searchKeyword.value.trim().toLowerCase();
  return tokens.value.filter(t => !keyword || [t.name, t.server, t.remark, t.id]
    .some(v => String(v || '').toLowerCase().includes(keyword)));
});
const allVisibleSelected = computed(() => filteredTokens.value.length > 0
  && filteredTokens.value.every(t => selectedTokenIds.value.includes(t.id)));
const someVisibleSelected = computed(() => !allVisibleSelected.value
  && filteredTokens.value.some(t => selectedTokenIds.value.includes(t.id)));
const selectedGroupIds = computed(() => tokenGroups.value.filter(g => {
  const ids = (g.tokenIds || []).filter(id => tokenIds.value.has(id));
  return ids.length && ids.every(id => selectedTokenIds.value.includes(id));
}).map(g => g.id));
const runningCount = computed(() => tokens.value.filter(t => statusMap.value[t.id]?.running).length);
const allSelectedRunning = computed(() => selectedTokenIds.value.length > 0
  && selectedTokenIds.value.every(id => statusMap.value[id]?.running || busy.value[id] === 'start'));
const hasSelectedRunning = computed(() => selectedTokenIds.value.some(id => statusMap.value[id]?.running));
const runningCards = computed(() => tokens.value
  .filter(t => selectedTokenIds.value.includes(t.id) || statusMap.value[t.id]?.startedAt)
  .map(t => {
    const st = statusMap.value[t.id] || {};
    const until = st.reconnecting ? Date.parse(st.reconnectAt) : st.waitUntil;
    const now = Math.max(tickNow.value, Date.now());
    const totalTime = (st.reconnecting ? (st.reconnectMinutes || 0) * 60000 : st.waitDurationMs || 0) / 1000;
    return {
      ...st, tokenId: t.id, tokenName: t.name || t.id, level: st.currLevel || 0,
      bossName: st.bossName || BOSS_NAMES[st.currLevel] || '',
      passed: st.passed || 0, losses: st.losses || 0, failStreak: st.failStreak || 0,
      countdown: st.running && until ? Math.min(Math.ceil(totalTime), Math.max(0, Math.ceil((until - now) / 1000))) : 0,
      totalTime,
    };
  }));
const visibleLogs = computed(() => logs.value.filter(log =>
  (!logFilterTokenId.value || log.tokenId === logFilterTokenId.value)
  && (!onlyErrors.value || ['warning', 'error'].includes(log.type))));
const logFilterOptions = computed(() => tokens.value.map(t => ({ label: t.name || t.id, value: t.id })));

watch(() => [visibleLogs.value.at(-1)?.id, onlyErrors.value, logFilterTokenId.value], async () => {
  if (!autoScroll.value) return;
  await nextTick();
  const el = logsContainer.value;
  if (el) el.scrollTop = el.scrollHeight;
});

function toggleToken(id, checked) {
  selectedTokenIds.value = checked ? [...new Set([...selectedTokenIds.value, id])]
    : selectedTokenIds.value.filter(value => value !== id);
}
function toggleAllVisible(checked) {
  const visible = new Set(filteredTokens.value.map(t => t.id));
  selectedTokenIds.value = checked ? [...new Set([...selectedTokenIds.value, ...visible])]
    : selectedTokenIds.value.filter(id => !visible.has(id));
}
function toggleGroup(group) {
  const checked = !selectedGroupIds.value.includes(group.id);
  for (const id of group.tokenIds || []) if (tokenIds.value.has(id)) toggleToken(id, checked);
}
function groupChipStyle(group) {
  return selectedGroupIds.value.includes(group.id)
    ? { backgroundColor: group.color, borderColor: group.color, color: '#fff' }
    : { borderColor: group.color, color: group.color };
}
function clearSelection() {
  selectedTokenIds.value = [];
}
function getStatusClass(id) {
  const status = connectionMap.value[id];
  return status === 'connected' ? 'status-green'
    : status === 'connecting' ? 'status-blue' : status === 'error' ? 'status-red' : 'status-gray';
}
function getStatusTitle(id) {
  return ({ connected: '已连接', connecting: '连接中', error: '连接异常' })[connectionMap.value[id]] || '未连接';
}
function phaseLabel(card) {
  if (!card.running) return '已停止';
  if (card.reconnectState === 'waiting') return '等待重连';
  if (card.reconnectState === 'connecting') return '重连中';
  return ({ starting: '正在启动', calculating: '计算战斗时间', simulating: '模拟计算中',
    battle: '战斗中', settling: '正在结算', interval: '等待下一局' })[card.phase] || '推关中';
}
function formatDuration(seconds) {
  const safe = Math.max(0, Math.ceil(seconds || 0));
  return safe >= 60 ? `${Math.floor(safe / 60)}分${safe % 60}秒` : `${safe}秒`;
}
function countdownLabel(card) {
  if (!card.countdown) return phaseLabel(card);
  return `${card.reconnecting ? '重连等待' : card.phase === 'interval' ? '下局等待' : '战斗剩余'} ${formatDuration(card.countdown)}`;
}
function progressPercent(card) {
  return card.totalTime ? Math.max(0, Math.min(100, (1 - card.countdown / card.totalTime) * 100)) : 0;
}
function getTorchLabel(card) {
  if (!card.torch) return '火把状态未读取';
  const remaining = Math.max(0, Math.ceil((card.torch.expiresAt - Math.max(tickNow.value, Date.now())) / 1000));
  if (!card.torch.type || !remaining) return '火把 无';
  return `${torchOptions.find(t => t.value === card.torch.type)?.label || '火把'} ${formatDuration(remaining)}`;
}
function formatLogTime(ts) {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
}
function errorText(error) {
  return error.response?.data?.msg || error.response?.data?.error || error.message || String(error);
}
function mergeLogs(incoming) {
  const map = new Map(logs.value.map(log => [log.id, log]));
  for (const log of incoming) {
    if (!tokenIds.value.has(log.tokenId) || log.ts <= clearedBefore) continue;
    const id = log.id || `${log.ts}:${log.tokenId}:${log.message}`;
    const type = log.level === 'warn' ? 'warning' : log.level;
    map.set(id, { ...log, id, type, tokenName: tokens.value.find(t => t.id === log.tokenId)?.name || log.tokenId,
      msg: log.message.replace(/^\[推关\]\s*/, '') });
  }
  logs.value = [...map.values()].sort((a, b) => a.ts - b.ts).slice(-2000);
}
function clearLogs() {
  clearedBefore = Date.now();
  logs.value = [];
}
async function refreshAll() {
  if (loadingAll.value || disposed) return;
  loadingAll.value = true;
  try {
    const [accounts, groups, states, history, connections] = await Promise.all([
      tokenApi.getAll(), tokenApi.getAllGroups(), pushLevelApi.statusAll(), pushLevelApi.logs(), statusApi.getAll(),
    ]);
    if (disposed) return;
    tokens.value = accounts;
    tokenGroups.value = groups;
    selectedTokenIds.value = selectedTokenIds.value.filter(id => tokenIds.value.has(id));
    statusMap.value = states;
    connectionMap.value = Object.fromEntries(connections.map(s => [s.id, s.status]));
    mergeLogs(history);
  } catch (error) {
    if (!disposed) message.error('刷新推关数据失败：' + errorText(error));
  } finally {
    loadingAll.value = false;
  }
}
async function refreshOne(id) {
  const state = await pushLevelApi.status(id);
  if (!disposed) statusMap.value = { ...statusMap.value, [id]: state };
}
function startOptions() {
  return { maxFail: maxRetries.value, reconnectMinutes: reconnectMinutes.value,
    accelerated: pushMode.value === 'accelerated', autoContinue: autoContinue.value };
}
async function startOne(id, options = startOptions()) {
  if (busy.value[id] || statusMap.value[id]?.running) return;
  busy.value[id] = 'start';
  try {
    const result = await pushLevelApi.start(id, options.maxFail, options.reconnectMinutes, options.accelerated, options.autoContinue);
    if (!result.ok) message.warning(`${tokens.value.find(t => t.id === id)?.name || id}：${result.msg || '启动失败'}`);
    await refreshOne(id);
  } catch (error) {
    message.error('启动失败：' + errorText(error));
  } finally {
    if (busy.value[id] === 'start') delete busy.value[id];
  }
}
async function stopOne(id) {
  if (busy.value[id] === 'stop') return;
  busy.value[id] = 'stop';
  try {
    const result = await pushLevelApi.stop(id);
    if (!result.ok) message.warning(result.msg || '停止失败');
    await refreshOne(id);
  } catch (error) {
    message.error('停止失败：' + errorText(error));
  } finally {
    if (busy.value[id] === 'stop') delete busy.value[id];
  }
}
async function startSelected() {
  if (startingBatch.value) return;
  startingBatch.value = true;
  const generation = ++batchGeneration;
  const options = startOptions();
  try {
    for (const id of [...selectedTokenIds.value]) {
      if (disposed || generation !== batchGeneration) break;
      await startOne(id, options);
    }
  } finally {
    startingBatch.value = false;
  }
}
async function stopSelected() {
  ++batchGeneration;
  stoppingBatch.value = true;
  try {
    await Promise.all(selectedTokenIds.value.filter(id => statusMap.value[id]?.running).map(stopOne));
  } finally {
    stoppingBatch.value = false;
  }
}
async function useTorchForSelected() {
  if (torchRunning.value) return;
  const ids = selectedTokenIds.value.filter(id => statusMap.value[id]?.running);
  const itemId = torchItemId.value;
  const quantity = torchQuantity.value;
  if (!ids.length || !Number.isInteger(quantity) || quantity < 1 || quantity > 999) return;
  torchRunning.value = true;
  let succeeded = 0;
  try {
    for (const id of ids) {
      try {
        const result = await pushLevelApi.useTorch(id, itemId, quantity);
        if (!result.ok) throw new Error(result.msg || '使用失败');
        succeeded++;
        await refreshOne(id);
      } catch (error) {
        message.error(`${tokens.value.find(t => t.id === id)?.name || id}：${errorText(error)}`);
      }
    }
    message.info(`火把使用完成：成功 ${succeeded} 个，失败 ${ids.length - succeeded} 个`);
  } finally {
    torchRunning.value = false;
  }
}

onMounted(() => {
  pushClient = new ServerPushClient(msg => {
    if (!tokenIds.value.has(msg.data?.tokenId)) return;
    if (msg.type === 'pushLevel') statusMap.value = { ...statusMap.value, [msg.data.tokenId]: msg.data.status };
    if (msg.type === 'connection') connectionMap.value[msg.data.tokenId] = msg.data.status;
    if (msg.type === 'log' && (msg.data.extra?.source === 'pushLevel' || msg.data.message?.startsWith('[推关]'))) {
      mergeLogs([{ ...msg.data, id: msg.data.extra?.id, ts: msg.ts }]);
    }
  });
  pushClient.connect();
  tickTimer = setInterval(() => { tickNow.value = Date.now(); }, 1000);
  refreshTimer = setInterval(() => { if (!loadingAll.value) refreshAll(); }, 15000);
  refreshAll();
});
onUnmounted(() => {
  disposed = true;
  ++batchGeneration;
  clearInterval(tickTimer);
  clearInterval(refreshTimer);
  pushClient?.disconnect();
});
</script>
<style scoped>
.pushing-levels-page {
  min-width: 0;
  min-height: 0;
  padding: 16px;
  background: var(--bg-secondary, #f6f8fb);
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.pl-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.pl-header h2 {
  margin: 0;
  color: var(--text-primary, #1f2937);
  font-size: 22px;
  font-weight: 700;
}

.pl-header p {
  margin: 2px 0 0;
  color: var(--text-secondary, #667085);
  font-size: 13px;
}

.pl-header-actions,
.account-toolbar,
.log-header,
.log-actions,
.control-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.retry-input {
  width: 110px;
}

.account-card-top,
.control-card,
.log-card,
.running-card {
  border-radius: 8px;
}

.account-card-top :deep(.n-card__content) {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 14px;
}

.search-input {
  width: 180px;
}

.group-list-inline {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.group-chip {
  border: 1px solid;
  border-radius: 999px;
  padding: 2px 8px;
  background: var(--bg-primary, #fff);
  font-size: 11px;
  cursor: pointer;
  line-height: 1.4;
}

.token-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
}

@media (max-width: 1100px) {
  .token-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

@media (max-width: 760px) {
  .token-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 480px) {
  .token-grid {
    grid-template-columns: 1fr;
  }
}

.token-cell {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border-radius: 6px;
  border: 1px solid var(--border-light, #e4e7ec);
  background: var(--bg-primary, #fff);
  font-size: 12px;
  line-height: 1.4;
  transition:
    border-color 0.2s,
    background 0.2s;
  cursor: pointer;
  min-height: 0;
}

.token-cell:hover {
  border-color: var(--text-secondary, #98a2b3);
}

.token-cell.selected {
  background: color-mix(in srgb, var(--primary-color, #6366f1) 12%, var(--bg-primary, #fff));
  border-color: #c7d2fe;
}

.token-server {
  color: var(--text-secondary, #667085);
  font-weight: 500;
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.token-sep {
  color: var(--text-secondary, #98a2b3);
}

.token-name {
  color: var(--text-primary, #101828);
  font-weight: 600;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.status-dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #d0d5dd;
  display: inline-block;
  flex-shrink: 0;
  border: 1px solid rgba(0, 0, 0, 0.05);
  transition: background 0.2s;
}

.status-dot.small {
  width: 10px;
  height: 10px;
}

.status-gray {
  background: #d0d5dd;
}

.status-green {
  background: #12b76a;
}

.status-red {
  background: #f04438;
}

.status-blue {
  background: #2e90fa;
  box-shadow: 0 0 0 3px rgba(46, 144, 250, 0.2);
  animation: pulse 1.2s ease-in-out infinite;
}

@keyframes pulse {
  0%,
  100% {
    box-shadow: 0 0 0 3px rgba(46, 144, 250, 0.2);
  }
  50% {
    box-shadow: 0 0 0 6px rgba(46, 144, 250, 0.05);
  }
}

.control-row {
  align-items: flex-end;
}

.torch-field {
  display: flex;
  flex-direction: column;
  gap: 2px;
  color: var(--text-primary, #344054);
  font-size: 11px;
}

.torch-label {
  color: var(--text-secondary, #667085);
}

.torch-select,
.torch-input {
  width: 120px;
}

.control-spacer {
  flex: 1;
}

.status-text {
  font-size: 13px;
  color: var(--text-secondary, #666);
  white-space: nowrap;
}

.running-section {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 340px), 1fr));
  gap: 10px;
}

.running-card {
  min-height: 160px;
  border: 1px solid var(--border-light, #e4e7ec);
}

.running-card.active {
  border-color: #12b76a;
}

.running-head {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  align-items: flex-start;
  flex-wrap: wrap;
  margin-bottom: 6px;
}

.card-title {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.card-title strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 140px;
}

.level-line,
.waiting-line,
.countdown-text,
.card-actions {
  color: var(--text-secondary, #667085);
  font-size: 12px;
  line-height: 1.6;
}

.level-line {
  color: var(--text-primary, #344054);
}

.torch-line {
  color: var(--warning-color, #b54708);
  font-weight: 500;
}

.running-body {
  margin-top: 8px;
}

.countdown-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.countdown-text {
  color: var(--text-primary, #1d2939);
  font-weight: 600;
  white-space: nowrap;
}

.inline-progress {
  flex: 1;
  min-width: 0;
}

.card-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 6px;
}

.err-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 160px;
}

.log-card {
  min-height: 320px;
}

.log-filter {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  flex-wrap: wrap;
}

.log-filter-label {
  color: var(--text-secondary, #667085);
  font-size: 12px;
  flex-shrink: 0;
}

.log-filter-select {
  width: 200px;
}

.log-filter-count {
  color: var(--text-secondary, #98a2b3);
  font-size: 11px;
}

.log-container {
  height: 300px;
  overflow-y: auto;
  padding: 2px;
  font-family: Consolas, "Courier New", monospace;
  font-size: 12px;
}

.log-item {
  display: grid;
  grid-template-columns: 74px minmax(110px, 180px) minmax(0, 1fr);
  gap: 8px;
  padding: 3px 6px;
  border-radius: 4px;
  color: var(--text-primary, #344054);
}

.log-item.success {
  color: var(--success-color, #047857);
}

.log-item.warning {
  color: var(--warning-color, #b54708);
}

.log-item.error {
  background: rgba(244, 63, 94, 0.1);
  color: var(--danger-color, #b42318);
}

.log-name,
.log-msg {
  overflow-wrap: anywhere;
}

@media (max-width: 640px) {
  .pushing-levels-page {
    padding: 10px;
  }

  .pl-header {
    align-items: flex-start;
    flex-direction: column;
  }

  .log-item {
    grid-template-columns: 64px minmax(80px, 110px) minmax(0, 1fr);
  }

  .torch-select,
  .torch-input,
  .log-filter-select {
    width: 100px;
  }
}

.mode-select { width: 170px; }
.reconnect-input { width: 190px; }
.mode-tags { margin-bottom: 8px; }
.latest-message { margin-top: 8px; font-size: 12px; color: var(--text-secondary, #667085); overflow-wrap: anywhere; }
:global([data-theme="dark"]) .pl-header h2,
:global([data-theme="dark"]) .token-name,
:global([data-theme="dark"]) .level-line,
:global([data-theme="dark"]) .countdown-text,
:global([data-theme="dark"]) .torch-field,
:global([data-theme="dark"]) .log-item { color: var(--text-primary, #e5e7eb); }
:global([data-theme="dark"]) .token-cell,
:global([data-theme="dark"]) .group-chip { background: var(--bg-primary, #18181c); border-color: var(--border-light, #41414a); }
:global([data-theme="dark"]) .token-cell.selected { background: #273452; border-color: #516393; }
:global([data-theme="dark"]) .log-item.error { background: #4a2128; color: #ffb4c0; }
:global([data-theme="dark"]) .log-item.warning { color: #e8bd6d; }
@media (max-width: 640px) {
  .pl-header-actions { width: 100%; }
  .status-text { white-space: normal; }
  .log-item { grid-template-columns: 65px minmax(0, 1fr); }
  .log-msg { grid-column: 1 / -1; }
}
</style>
