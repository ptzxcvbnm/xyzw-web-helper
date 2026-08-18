<template>
  <div class="force-online-page">
    <n-card title="强制在线（秒顶号）" :bordered="false">
      <template #header-extra>
        <n-text depth="3" style="font-size: 12px;">
          勾选的账号强制保持在线 · 被顶下线立即重连抢回 · 关闭网页仍运行
        </n-text>
      </template>

      <n-space vertical :size="16">
        <n-alert type="warning" :show-icon="true">
          勾选并保存后，服务器会让这些账号强制在线：一旦被别人登录挤下线，立即重连抢回（秒顶）。
          若重连累计失败 3000 次（通常是该号 bin 已失效），会自动关闭该号的强制在线并清理其失败日志，需重新导入 bin 后再开启。
          注意：开启期间该号无法在别处正常登录，请确认是自己的号。
        </n-alert>

        <n-space align="center">
          <n-button type="primary" :loading="savingEnabled" @click="saveEnabled">保存并生效</n-button>
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
import { tokenApi, forceOnlineApi, ServerPushClient } from '@/api/serverApi';

const message = useMessage();
const loadingAll = ref(false);
const savingEnabled = ref(false);
const tokens = ref([]);
const statusMap = ref({});
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
  const st = statusMap.value[t.id] || {};
  return { id: t.id, name: t.name, status: st.status || 'idle', fail: st.fail || 0, on: !!st.enabled };
}));

const statusText = (s) => ({ connected: '在线', connecting: '连接中', disconnected: '掉线', error: '错误', idle: '未启用' }[s] || s || '-');

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
    title: '连接状态', key: 'status', width: 100,
    render(row) {
      return h(NTag, { type: row.status === 'connected' ? 'success' : (row.on ? 'warning' : 'default'), size: 'small' },
        { default: () => statusText(row.status) });
    }
  },
  {
    title: '重连失败次数', key: 'fail', width: 120,
    render: r => h('span', { style: r.fail > 0 ? 'color:#e88080' : '' }, `${r.fail} / 3000`)
  },
];

async function loadTokens() {
  try { tokens.value = await tokenApi.getAll(); }
  catch (e) { message.error('加载账号失败: ' + (e.message || e)); }
}

async function loadEnabled() {
  try { const r = await forceOnlineApi.getEnabled(); enabledIds.value = r.tokenIds || []; }
  catch {}
}

async function saveEnabled() {
  savingEnabled.value = true;
  try { await forceOnlineApi.setEnabled(enabledIds.value); message.success('已保存，强制在线已生效'); setTimeout(refreshAll, 1500); }
  catch (e) { message.error('保存失败: ' + (e.message || e)); }
  finally { savingEnabled.value = false; }
}

async function refreshAll() {
  loadingAll.value = true;
  try { statusMap.value = await forceOnlineApi.statusAll(); }
  catch { message.error('刷新状态失败'); }
  finally { loadingAll.value = false; }
}

onMounted(async () => {
  await loadTokens();
  await loadEnabled();
  await refreshAll();
  pushClient = new ServerPushClient((msg) => {
    if (msg.type === 'connection') refreshAll();
  });
  pushClient.connect();
});

onUnmounted(() => { if (pushClient) pushClient.disconnect(); });
</script>

<style scoped>
.force-online-page {
  padding: 16px;
  max-width: 1100px;
  margin: 0 auto;
}
</style>
