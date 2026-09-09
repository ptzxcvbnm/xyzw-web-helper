<template>
  <div class="push-level-page">
    <n-card title="后端协议推关" :bordered="false">
      <template #header-extra>
        <n-text depth="3" style="font-size: 12px;">
          纯协议推关 · 关闭网页仍持续运行
        </n-text>
      </template>

      <n-space vertical :size="16">
        <!-- 说明 -->
        <n-alert type="info" :show-icon="true">
          推关在服务器后台运行，关闭网页不影响。模拟加速会提前放弃失败局，只为预测胜局等待正常结算时间；资源版本不匹配时会拒绝启动。
        </n-alert>

        <!-- 全局设置 -->
        <n-space align="center" wrap>
          <span>连续失败停止次数：</span>
          <n-input-number v-model:value="maxFail" :min="1" :max="999" :precision="0" style="width: 140px;" />
          <span>掉线后重连等待：</span>
          <n-input-number v-model:value="reconnectMinutes" :min="0" :max="1440" :precision="0" style="width: 140px;">
            <template #suffix>分钟</template>
          </n-input-number>
          <span>本地模拟加速：</span>
          <n-switch v-model:value="accelerated" />
          <n-button type="primary" :loading="loadingAll" @click="refreshAll">刷新状态</n-button>
        </n-space>

        <!-- 账号列表 -->
        <div class="table-frame">
          <n-data-table
            class="push-level-table"
            :columns="columns"
            :data="rows"
            :scroll-x="1180"
            :bordered="true"
            :single-line="false"
            size="small"
          />
        </div>
        <span class="mobile-scroll-hint">可在表格内左右滑动查看全部列</span>
      </n-space>
    </n-card>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, h, computed } from 'vue';
import { NButton, NTag, useMessage } from 'naive-ui';
import { tokenApi, pushLevelApi, ServerPushClient } from '@/api/serverApi';

const message = useMessage();
const maxFail = ref(20);
const reconnectMinutes = ref(0);
const accelerated = ref(false);
const loadingAll = ref(false);
const tokens = ref([]);
const statusMap = ref({}); // tokenId -> status
const busy = ref({});      // tokenId -> bool（按钮loading）

let pushClient = null;

const rows = computed(() => tokens.value.map(t => {
  const st = statusMap.value[t.id] || { running: false };
  return {
    id: t.id,
    name: t.name,
    running: st.running,
    currLevel: st.currLevel,
    bossName: st.bossName,
    passed: st.passed,
    failStreak: st.failStreak,
    maxFail: st.maxFail,
    reconnectMinutes: st.reconnectMinutes,
    reconnecting: st.reconnecting,
    reconnectState: st.reconnectState,
    accelerated: st.accelerated,
    simulationAttempts: st.simulationAttempts,
    lastMsg: st.lastMsg,
    stopReason: st.stopReason,
  };
}));

const columns = [
  { title: '账号', key: 'name', width: 160, ellipsis: { tooltip: true } },
  {
    title: '状态', key: 'running', width: 90,
    render(row) {
      const type = row.reconnecting ? 'warning' : row.running ? 'success' : 'default';
      const label = row.reconnectState === 'waiting'
        ? '等待重连'
        : row.reconnectState === 'connecting'
          ? '重连中'
          : row.running ? (row.accelerated ? '模拟推关' : '推关中') : '停止';
      return h(NTag, { type, size: 'small' }, { default: () => label });
    }
  },
  { title: '当前关', key: 'currLevel', width: 90, render: r => r.currLevel ?? '-' },
  { title: '当前BOSS', key: 'bossName', width: 120, ellipsis: { tooltip: true }, render: r => r.bossName || '-' },
  { title: '已过', key: 'passed', width: 70, render: r => r.passed ?? 0 },
  { title: '模拟局数', key: 'simulationAttempts', width: 80, render: r => r.simulationAttempts ?? 0 },
  {
    title: '连续失败', key: 'failStreak', width: 90,
    render: r => (r.failStreak != null ? `${r.failStreak}/${r.maxFail ?? maxFail.value}` : '-')
  },
  { title: '最近信息', key: 'lastMsg', width: 360, ellipsis: { tooltip: true }, render: r => r.lastMsg || (r.stopReason ? '已停止: ' + r.stopReason : '-') },
  {
    title: '操作', key: 'actions', width: 120,
    render(row) {
      if (row.running) {
        return h(NButton, { size: 'small', type: 'error', loading: !!busy.value[row.id], onClick: () => stop(row.id) },
          { default: () => '停止' });
      }
      return h(NButton, { size: 'small', type: 'primary', loading: !!busy.value[row.id], onClick: () => start(row.id) },
        { default: () => '开始' });
    }
  },
];

async function loadTokens() {
  try {
    tokens.value = await tokenApi.getAll();
  } catch (e) {
    message.error('加载账号失败: ' + (e.message || e));
  }
}

async function refreshAll() {
  loadingAll.value = true;
  try {
    statusMap.value = await pushLevelApi.statusAll();
  } catch (e) {
    message.error('刷新状态失败');
  } finally {
    loadingAll.value = false;
  }
}

async function start(tokenId) {
  busy.value = { ...busy.value, [tokenId]: true };
  try {
    const r = await pushLevelApi.start(tokenId, maxFail.value, reconnectMinutes.value, accelerated.value);
    if (r.ok) message.success(r.msg || '已开始');
    else message.warning(r.msg || '开始失败');
    await refreshOne(tokenId);
  } catch (e) {
    message.error('开始失败: ' + (e.response?.data?.msg || e.message));
  } finally {
    busy.value = { ...busy.value, [tokenId]: false };
  }
}

async function stop(tokenId) {
  busy.value = { ...busy.value, [tokenId]: true };
  try {
    const r = await pushLevelApi.stop(tokenId);
    if (r.ok) message.success(r.msg || '已停止');
    else message.warning(r.msg || '停止失败');
    await refreshOne(tokenId);
  } catch (e) {
    message.error('停止失败: ' + (e.message || e));
  } finally {
    busy.value = { ...busy.value, [tokenId]: false };
  }
}

async function refreshOne(tokenId) {
  try {
    const st = await pushLevelApi.status(tokenId);
    statusMap.value = { ...statusMap.value, [tokenId]: st };
  } catch {}
}

onMounted(async () => {
  await loadTokens();
  await refreshAll();

  // 实时接收后端推送的推关状态
  pushClient = new ServerPushClient((msg) => {
    if (msg.type === 'pushLevel' && msg.data?.tokenId) {
      statusMap.value = { ...statusMap.value, [msg.data.tokenId]: msg.data.status };
    }
  });
  pushClient.connect();
});

onUnmounted(() => {
  if (pushClient) pushClient.disconnect();
});
</script>

<style scoped>
.push-level-page {
  padding: 16px;
  max-width: 1100px;
  margin: 0 auto;
  min-width: 0;
}

.table-frame {
  width: 100%;
  min-width: 0;
  overflow: hidden;
}

.push-level-table {
  width: 100%;
  min-width: 0;
}

/* scroll-x 已让 Naive UI 的内部容器负责横向滚动，避免双层滚动区域抢手势。 */
.push-level-table :deep(.n-data-table-base-table-body > .n-scrollbar-container) {
  touch-action: pan-x pan-y;
  overscroll-behavior-x: contain;
  -webkit-overflow-scrolling: touch;
}

.mobile-scroll-hint {
  display: none;
  color: var(--text-secondary);
  font-size: 12px;
  text-align: center;
}

@media (max-width: 768px) {
  .push-level-page {
    padding: 8px;
  }

  .mobile-scroll-hint {
    display: block;
  }
}
</style>
