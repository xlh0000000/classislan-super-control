<script setup lang="ts">
type DeviceRow = { id: string; name: string; pluginVersion: string; appVersion: string; transport: string; lastSeen: string | null; disabledAt: string | null; orgName: string; online: boolean; disabled: boolean };
const { data: devices, refresh } = await useFetch<DeviceRow[]>("/api/v1/admin/devices", { default: () => [] });
const detailId = ref<string | null>(null);
const toast = useToast();
const { deviceIds, summary: targetSummary, count: targetCount, empty: targetEmpty } = useTargetSelection();
const showTargets = ref(false);

const bulkBusy = ref(false);
/** 破坏性操作统一走二次确认弹窗，不用浏览器原生 confirm。 */
const pending = ref<{ title: string; description: string; confirmText: string; danger: boolean; run: () => Promise<void> } | null>(null);
const confirmBusy = ref(false);
async function runPending() {
  const task = pending.value;
  if (!task) return;
  confirmBusy.value = true;
  try { await task.run(); }
  finally { confirmBusy.value = false; pending.value = null; }
}

/** 批量操作直接作用于已选目标。 */
function bulk(action: "enable" | "disable") {
  if (!deviceIds.value.length) return;
  if (action === "enable") { void runBulk("enable"); return; }
  pending.value = {
    title: "停用设备",
    description: `停用已选的 ${deviceIds.value.length} 台设备？进行中的命令会被取消。`,
    confirmText: "停用", danger: true, run: () => runBulk("disable"),
  };
}
async function runBulk(action: "enable" | "disable") {
  bulkBusy.value = true;
  let done = 0; const failed: string[] = [];
  for (const id of deviceIds.value) {
    try { await $fetch(`/api/v1/admin/devices/${id}/${action}`, { method: "POST", headers: { origin: location.origin } }); done += 1; }
    catch (err) { failed.push(`${id.slice(0, 8)}：${(err as { data?: { message?: string } })?.data?.message ?? "失败"}`); }
  }
  bulkBusy.value = false;
  if (done) toast.ok(`已${action === "disable" ? "停用" : "启用"} ${done} 台设备。`);
  if (failed.length) toast.err(`${failed.length} 台失败：${failed.join("；")}`);
  await refresh();
}

/** 批量切换已选设备的连接模式。 */
function bulkTransport(transport: "http" | "websocket") {
  if (!deviceIds.value.length || bulkBusy.value) return;
  pending.value = {
    title: "切换连接模式",
    description: `把已选的 ${deviceIds.value.length} 台设备切换为${transport === "websocket" ? "长连接" : "定时轮询"}？`,
    confirmText: "切换", danger: false, run: () => runBulkTransport(transport),
  };
}
async function runBulkTransport(transport: "http" | "websocket") {
  bulkBusy.value = true;
  let done = 0; const failed: string[] = [];
  for (const id of deviceIds.value) {
    try { await $fetch(`/api/v1/admin/devices/${id}`, { method: "PATCH", headers: { origin: location.origin }, body: { transport } }); done += 1; }
    catch (err) { failed.push(`${id.slice(0, 8)}：${(err as { data?: { message?: string } })?.data?.message ?? "失败"}`); }
  }
  bulkBusy.value = false;
  if (done) toast.ok(`已切换 ${done} 台设备为${transport === "websocket" ? "长连接" : "轮询"}。`);
  if (failed.length) toast.err(`${failed.length} 台失败：${failed.join("；")}`);
  await refresh();
}
</script>

<template>
  <PageHeading kicker="每台终端的状态" title="设备">
    <NuxtLink to="/enrollment">接入设备</NuxtLink>
  </PageHeading>
  <section class="bulk">
    <div><span>批量下发</span><strong>{{ targetEmpty ? "未选择目标" : targetSummary }}</strong><small>{{ targetCount }} 台设备</small></div>
    <div class="bulk-actions">
      <button type="button" class="solid pick" @click="showTargets = true">选择目标</button>
      <button type="button" :disabled="bulkBusy || targetEmpty" @click="bulk('enable')">批量启用</button>
      <button type="button" class="danger" :disabled="bulkBusy || targetEmpty" @click="bulk('disable')">批量停用</button>
      <button type="button" :disabled="bulkBusy || targetEmpty" @click="bulkTransport('http')">改轮询</button>
      <button type="button" :disabled="bulkBusy || targetEmpty" @click="bulkTransport('websocket')">改长连接</button>
    </div>
  </section>
  <div v-if="devices.length" class="table-shell">
    <table><thead><tr><th>设备</th><th>组织</th><th>状态</th><th>连接</th><th>插件 / 宿主</th><th>最后联系</th><th></th></tr></thead>
      <tbody><tr v-for="device in devices" :key="device.id" :class="{ selected: detailId === device.id }"><td><strong>{{ device.name }}</strong><small>{{ device.id }}</small></td><td>{{ device.orgName }}</td><td><span class="state" :data-online="device.online" :data-disabled="device.disabled">{{ device.disabled ? "已禁用" : device.online ? "在线" : "离线" }}</span></td><td>{{ device.transport === "websocket" ? "长连接" : "轮询" }}</td><td>{{ device.pluginVersion }} / {{ device.appVersion }}</td><td>{{ device.lastSeen || "从未" }}</td><td class="row-actions"><button type="button" @click="detailId = device.id">详情</button></td></tr></tbody>
    </table>
  </div>
  <EmptyState v-else title="还没有设备接入" action="创建接入凭据" to="/enrollment" />
  <TargetPickerDialog v-if="showTargets" @close="showTargets = false" />
  <DeviceDetailDialog v-if="detailId" :device-id="detailId" @close="detailId = null" @changed="refresh" />
  <ConfirmDialog
    v-if="pending"
    :title="pending.title"
    :description="pending.description"
    :confirm-text="pending.confirmText"
    :danger="pending.danger"
    :busy="confirmBusy"
    @close="pending = null"
    @confirm="runPending"
  />
</template>

<style scoped>
.table-shell { margin-top: 16px; overflow: auto; border-top: 1px solid var(--line-strong); }
.account, td:first-child { display: grid; gap: 4px; }
td:first-child strong { font-size: 14px; font-weight: 600; color: var(--ink); }
td small { color: var(--ink-faint); font-size: 10px; letter-spacing: 0.5px; }
tbody tr.selected { background: var(--accent-wash); }
.state { display: inline-flex; align-items: center; gap: 8px; }
.state::before { content: ""; width: 7px; height: 7px; background: var(--ink-faint); }
.state[data-online="true"]::before { background: var(--good); }
.state[data-disabled="true"]::before { background: var(--bad); }
.row-actions { text-align: right; }
.row-actions button { min-height: 0; padding: 0 0 3px; border: 0; border-bottom: 1px solid transparent; background: none; color: var(--ink-muted); font-size: 11px; letter-spacing: 0.5px; }
.row-actions button:hover:not(:disabled) { border-bottom-color: var(--accent); background: none; color: var(--accent); }
button:disabled { opacity: 0.45; cursor: not-allowed; }

/* 批量条：RhineLab 微标签 + 发丝框。 */
.bulk {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  margin-bottom: 4px;
  padding: 20px 24px;
  border: 1px solid var(--line-soft);
  background: var(--surface-1);
}
.bulk div:first-child { display: grid; gap: 6px; }
.bulk span { color: var(--ink-muted); font-size: 10px; letter-spacing: 1.2px; }
.bulk strong { font-size: 15px; font-weight: 600; }
.bulk small { color: var(--ink-faint); font-size: 10px; letter-spacing: 0.6px; }
.bulk-actions { display: flex; flex-wrap: wrap; gap: 8px; }
</style>
