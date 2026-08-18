<template>
  <div class="salt-field-page">
    <n-card title="盐场自动创地" :bordered="false">
      <template #header-extra>
        <n-text depth="3" style="font-size: 12px;">
          每周六 20:00-20:30 自动执行 · 吕布单将 · 关闭网页仍运行
        </n-text>
      </template>

      <n-space vertical :size="16">
        <n-alert type="info" :show-icon="true">
          勾选参与盐场的账号并保存后，每周六 20:00 服务器自动进场、吕布单将布阵、循环飞相邻格创地，到 20:30 停止。也可在盐场开放时手动点"开始"立即执行。
        </n-alert>

        <n-space align="center">
          <n-button type="primary" :loading="savingEnabled" @click="saveEnabled">保存参与账号</n-button>
          <n-button :loading="loadingAll" @click="refreshAll">刷新状态</n-button>
          <n-text depth="3">已勾选 {{ enabledIds.length }} 个</n-text>
        </n-space>

        <n-data-table
          :columns="columns"
          :data="rows"
          :bordered="true"
          :single-line="false"
          size="small"
          max-height="560"
        />
      </n-space>
    </n-card>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, h, computed } from 'vue';
import { NButton, NTag, NCheckbox, useMessage } from 'naive-ui';
import { tokenApi, saltFieldApi, ServerPushClient } from '@/api/serverApi';

const message = useMessage();
const loadingAll = ref(false);
const savingEnabled = ref(false);
const tokens = ref([]);
const statusMap = ref({});
const busy = ref({});
const enabledIds = ref([]);

let pushClient = null;

const isEnabled = (id) => enabledIds.value.includes(id);
const toggleEnabled = (id, checked) => {
  if (checked) { if (!enabledIds.value.includes(id)) enabledIds.value = [...enabledIds.value, id]; }
  else { enabledIds.value = enabledIds.value.filter(x => x !== id); }
};

const allChecked = computed(() => tokens.value.length > 0 && enabledIds.value.length >= tokens.value.length);
const someChecked = computed(() => enabledIds.value.length > 0 && !allChecked.value);
const toggleAll = (checked) => {
  enabledIds.value = checked ? tokens.value.map(t => t.id) : [];
};

const rows = computed(() => tokens.value.map(t => {
  const st = statusMap.value[t.id] || { running: false, status: 'idle' };
  return { id: t.id, name: t.name, running: st.running, status: st.status, lastMsg: st.lastMsg };
}));

const statusText = (s) => ({ idle: '空闲', running: '创地中', stopped: '已停止', failed: '失败', skipped: '未开放' }[s] || s || '-');

const columns = [
  {
    title() {
      return h(NCheckbox, {
        checked: allChecked.value,
        indeterminate: someChecked.value,
        'onUpdate:checked': (v) => toggleAll(v),
      });
    },
    key: 'enabled', width: 60,
    render(row) {
      return h(NCheckbox, {
        checked: isEnabled(row.id),
        'onUpdate:checked': (v) => toggleEnabled(row.id, v),
      });
    }
  },
  { title: '账号', key: 'name', width: 160, ellipsis: { tooltip: true } },
  {
    title: '状态', key: 'status', width: 90,
    render(row) {
      return h(NTag, { type: row.running ? 'success' : 'default', size: 'small' },
        { default: () => statusText(row.status) });
    }
  },
  { title: '最近信息', key: 'lastMsg', ellipsis: { tooltip: true }, render: r => r.lastMsg || '-' },
  {
    title: '操作', key: 'actions', width: 110,
    render(row) {
      if (row.running) {
        return h(NButton, { size: 'small', type: 'error', loading: !!busy.value[row.id], onClick: () => stop(row.id) },
          { default: () => '停止' });
      }
      return h(NButton, { size: 'small', type: 'primary', loading: !!busy.value[row.id], onClick: () => start(row) },
        { default: () => '开始' });
    }
  },
];

async function loadTokens() {
  try { tokens.value = await tokenApi.getAll(); }
  catch (e) { message.error('加载账号失败: ' + (e.message || e)); }
}

async function loadEnabled() {
  try { const r = await saltFieldApi.getEnabled(); enabledIds.value = r.tokenIds || []; }
  catch {}
}

async function saveEnabled() {
  savingEnabled.value = true;
  try { await saltFieldApi.setEnabled(enabledIds.value); message.success('已保存参与账号'); }
  catch (e) { message.error('保存失败: ' + (e.message || e)); }
  finally { savingEnabled.value = false; }
}

async function refreshAll() {
  loadingAll.value = true;
  try { statusMap.value = await saltFieldApi.statusAll(); }
  catch { message.error('刷新状态失败'); }
  finally { loadingAll.value = false; }
}

async function start(row) {
  busy.value = { ...busy.value, [row.id]: true };
  try {
    const r = await saltFieldApi.start(row.id, row.name);
    if (r.ok) message.success(r.msg || '已启动'); else message.warning(r.msg || '启动失败');
  } catch (e) { message.error('启动失败: ' + (e.message || e)); }
  finally { busy.value = { ...busy.value, [row.id]: false }; setTimeout(refreshAll, 1000); }
}

async function stop(tokenId) {
  busy.value = { ...busy.value, [tokenId]: true };
  try { await saltFieldApi.stop(tokenId); message.success('已停止'); }
  catch (e) { message.error('停止失败'); }
  finally { busy.value = { ...busy.value, [tokenId]: false }; setTimeout(refreshAll, 500); }
}

onMounted(async () => {
  await loadTokens();
  await loadEnabled();
  await refreshAll();
  pushClient = new ServerPushClient((msg) => {
    if (msg.type === 'saltfield') refreshAll();
  });
  pushClient.connect();
});

onUnmounted(() => { if (pushClient) pushClient.disconnect(); });
</script>

<style scoped>
.salt-field-page {
  padding: 16px;
  max-width: 1100px;
  margin: 0 auto;
}
</style>
