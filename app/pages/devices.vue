<script setup lang="ts">
type DeviceRow = { id: string; name: string; pluginVersion: string; appVersion: string; transport: string; lastSeen: string | null; disabledAt: string | null; orgName: string; online: boolean; disabled: boolean };
type DeviceDetail = {
  id: string; name: string; orgNodeId: string | null; pluginVersion: string; appVersion: string; platform: string; transport: string;
  capabilityDigest: string; policyRevision: number; driftCount: number; lastSequence: number;
  lastSeenAt: string | null; createdAt: string | null; disabledAt: string | null; online: boolean;
  policyStatus?: { desired: { revision: number; epoch: number; hash: string; sections: string[]; lockedPointers: number }; applied: { revision: number; epoch: number; hash: string; sections: unknown; driftCount: number }; inSync: boolean };
  capabilitySnapshot: unknown; tagIds: string[]; recentCommands: { id: string; capabilityId: string; state: string; attemptCount: number; createdAt: string }[];
};
const { data: devices, refresh } = await useFetch<DeviceRow[]>("/api/v1/admin/devices", { default: () => [] });
const selected = ref<DeviceDetail | null>(null);
const loading = ref(false);
const toast = useToast();
const renameValue = ref("");
/** 设备长期不上报时是“离线未上报”，不是正在重同步，避免误判成服务端没跟插件对上。 */
const syncText = computed(() => {
  const status = selected.value?.policyStatus;
  if (!status) return "—";
  if (status.inSync) return "已同步";
  if (selected.value?.disabledAt) return "已禁用";
  return selected.value?.online ? "漂移待重同步" : "离线未上报";
});
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

/** 连接模式由集控端指定：设备在下一轮同步时按新传输重连。 */
async function setTransport(transport: "http" | "websocket") {
  if (!selected.value || selected.value.transport === transport) return;
  try {
    await $fetch(`/api/v1/admin/devices/${selected.value.id}`, { method: "PATCH", headers: { origin: location.origin }, body: { transport } });
    selected.value.transport = transport;
    toast.ok(transport === "websocket" ? "已切换为 WebSocket 长连接。" : "已切换为 HTTP 轮询。");
    await refresh();
  } catch (err) { toast.err((err as { data?: { message?: string } })?.data?.message ?? "切换连接模式失败。"); }
}

/** 批量切换已选设备的连接模式。 */
function bulkTransport(transport: "http" | "websocket") {
  if (!deviceIds.value.length || bulkBusy.value) return;
  pending.value = {
    title: "切换连接模式",
    description: `把已选的 ${deviceIds.value.length} 台设备切换为${transport === "websocket" ? " WebSocket 长连接" : " HTTP 轮询"}？`,
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

function capabilityEntries() {
  const snapshot = selected.value?.capabilitySnapshot;
  if (!snapshot || typeof snapshot !== "object") return [] as { key: string; value: string }[];
  const source = (snapshot as { capabilities?: unknown }).capabilities ?? snapshot;
  if (!Array.isArray(source)) return [{ key: "snapshot", value: JSON.stringify(source, null, 2) }];
  return source.map((item, index) => {
    const entry = (item ?? {}) as Record<string, unknown>;
    const key = String(entry.capabilityId ?? entry.id ?? `#${index}`);
    const mode = entry.mode ?? entry.modes ?? entry.access ?? entry.availability ?? "";
    return { key, value: typeof mode === "object" ? JSON.stringify(mode) : String(mode) };
  });
}

async function open(device: DeviceRow) {
  loading.value = true;
  try {
    selected.value = await $fetch<DeviceDetail>(`/api/v1/admin/devices/${device.id}`);
    renameValue.value = selected.value.name;
  } catch (err) { toast.err((err as { data?: { message?: string } })?.data?.message ?? "加载设备详情失败。"); }
  finally { loading.value = false; }
}

async function rename() {
  if (!selected.value || !renameValue.value.trim() || renameValue.value === selected.value.name) return;
  try {
    await $fetch(`/api/v1/admin/devices/${selected.value.id}`, { method: "PATCH", headers: { origin: location.origin }, body: { name: renameValue.value.trim() } });
    selected.value.name = renameValue.value.trim(); toast.ok("已保存设备名称。"); await refresh();
  } catch (err) { toast.err((err as { data?: { message?: string } })?.data?.message ?? "重命名失败。"); }
}

function setDisabled(disabled: boolean) {
  if (!selected.value) return;
  if (!disabled) { void runSetDisabled(false); return; }
  pending.value = {
    title: "禁用设备",
    description: `禁用设备 ${selected.value.name}？进行中的命令会被取消。`,
    confirmText: "禁用", danger: true, run: () => runSetDisabled(true),
  };
}
async function runSetDisabled(disabled: boolean) {
  const device = selected.value;
  if (!device) return;
  try {
    const action = disabled ? "disable" : "enable";
    await $fetch(`/api/v1/admin/devices/${device.id}/${action}`, { method: "POST", headers: { origin: location.origin } });
    device.disabledAt = disabled ? new Date().toISOString() : null;
    toast.ok(disabled ? "已禁用设备。" : "已恢复设备。"); await refresh();
  } catch (err) { toast.err((err as { data?: { message?: string } })?.data?.message ?? "操作失败。"); }
}

/** 解除集控只能由管理员下发命令；设备端收到回执前仍保持接入状态。 */
function releaseDevice() {
  if (!selected.value) return;
  const device = selected.value;
  pending.value = {
    title: "解除集控",
    description: `解除 ${device.name} 的集控？设备会清除入网身份，之后需重新下发接入码才能接入。`,
    confirmText: "解除", danger: true, run: () => runRelease(device),
  };
}
async function runRelease(device: DeviceDetail) {
  try {
    await $fetch(`/api/v1/admin/devices/${device.id}/release`, {
      method: "POST", headers: { origin: location.origin }, body: { reason: "管理员手动解除" },
    });
    toast.ok("解除命令已下发，等待设备回执。");
    await refresh();
  } catch (err) { toast.err((err as { data?: { message?: string } })?.data?.message ?? "解除失败。"); }
}

function removeDevice() {
  if (!selected.value) return;
  pending.value = {
    title: "删除设备",
    description: `删除设备 ${selected.value.name}？其标签、命令与能力快照会一并移除，此操作不可撤销。`,
    confirmText: "删除", danger: true, run: () => runRemoveDevice(),
  };
}
async function runRemoveDevice() {
  const device = selected.value;
  if (!device) return;
  try {
    await $fetch(`/api/v1/admin/devices/${device.id}`, { method: "DELETE", headers: { origin: location.origin } });
    selected.value = null; toast.ok("已删除设备。"); await refresh();
  } catch (err) { toast.err((err as { data?: { message?: string } })?.data?.message ?? "删除失败。"); }
}
</script>

<template>
  <PageHeading kicker="CLIENT DIRECTORY / 设备目录" title="设备" description="查看轮询、能力、策略合规与最后执行结果。在线状态只表示最近成功联系，不代表所有策略均已应用。">
    <NuxtLink to="/enrollment">接入设备</NuxtLink>
  </PageHeading>
  <section class="bulk">
    <div><span>BULK / 批量操作</span><strong>{{ targetEmpty ? "未选择目标" : targetSummary }}</strong><small>{{ targetCount }} 台设备</small></div>
    <div class="bulk-actions">
      <button type="button" class="ghost pick" @click="showTargets = true">选择目标</button>
      <button type="button" :disabled="bulkBusy || targetEmpty" @click="bulk('enable')">批量启用</button>
      <button type="button" class="danger" :disabled="bulkBusy || targetEmpty" @click="bulk('disable')">批量停用</button>
      <button type="button" :disabled="bulkBusy || targetEmpty" @click="bulkTransport('http')">改轮询</button>
      <button type="button" :disabled="bulkBusy || targetEmpty" @click="bulkTransport('websocket')">改长连接</button>
    </div>
  </section>
  <div v-if="devices.length" class="table-shell">
    <table><thead><tr><th>设备</th><th>组织</th><th>状态</th><th>连接</th><th>插件 / 宿主</th><th>最后联系</th><th></th></tr></thead>
      <tbody><tr v-for="device in devices" :key="device.id" :class="{ selected: selected?.id === device.id }"><td><strong>{{ device.name }}</strong><small>{{ device.id }}</small></td><td>{{ device.orgName }}</td><td><span class="state" :data-online="device.online" :data-disabled="device.disabled">{{ device.disabled ? "已禁用" : device.online ? "在线" : "离线" }}</span></td><td>{{ device.transport === "websocket" ? "长连接" : "轮询" }}</td><td>{{ device.pluginVersion }} / {{ device.appVersion }}</td><td>{{ device.lastSeen || "从未" }}</td><td class="row-actions"><button type="button" @click="open(device)">详情</button></td></tr></tbody>
    </table>
  </div>
  <EmptyState v-else title="尚无受管设备" description="创建短时一次性接入码，或生成绑定组织节点的预配置批量包。有效凭据注册后会自动激活。" action="创建接入凭据" to="/enrollment" />
  <TargetPickerDialog v-if="showTargets" @close="showTargets = false" />
  <AppDialog v-if="loading" title="设备详情"
 kicker="CLIENT DIRECTORY / 设备详情" width="940px" @close="loading = false">
    <p class="muted">正在加载设备详情…</p>
  </AppDialog>
  <AppDialog v-else-if="selected" :title="selected.name" kicker="CLIENT DIRECTORY / 设备详情" width="940px" @close="selected = null">
    <small class="muted">{{ selected.id }}</small>
    <div class="detail-grid">
      <article><h3>标识与版本</h3><dl><dt>插件版本</dt><dd>{{ selected.pluginVersion || "—" }}</dd><dt>宿主版本</dt><dd>{{ selected.appVersion || "—" }}</dd><dt>平台</dt><dd>{{ selected.platform || "—" }}</dd><dt>能力摘要</dt><dd>{{ selected.capabilityDigest || "—" }}</dd></dl></article>
      <article><h3>合规与同步</h3><dl><dt>期望策略</dt><dd>R{{ selected.policyStatus?.desired.revision ?? selected.policyRevision }} · epoch {{ selected.policyStatus?.desired.epoch ?? "—" }}</dd><dt>已应用</dt><dd>R{{ selected.policyRevision }} · epoch {{ selected.policyStatus?.applied.epoch ?? "—" }}</dd><dt>同步状态</dt><dd>{{ syncText }}</dd><dt>偏差计数</dt><dd>{{ selected.driftCount }}</dd><dt>最近序号</dt><dd>{{ selected.lastSequence }}</dd><dt>最后联系</dt><dd>{{ selected.online ? "在线" : "离线" }} · {{ selected.lastSeenAt || "从未" }}</dd><dt>注册时间</dt><dd>{{ selected.createdAt }}</dd></dl></article>
    </div>
    <form class="rename" @submit.prevent="rename"><label>设备名称<input v-model.trim="renameValue" maxlength="100"></label><button :disabled="!renameValue.trim() || renameValue === selected.name">保存名称</button></form>
    <div class="actions"><button v-if="!selected.disabledAt" type="button" class="danger" @click="setDisabled(true)">禁用设备</button><button v-else type="button" @click="setDisabled(false)">恢复设备</button><button type="button" class="danger" @click="releaseDevice">解除集控</button><button type="button" class="danger" @click="removeDevice">删除设备</button></div>
    <article class="block"><h3>连接方式</h3>
      <div class="seg">
        <button type="button" :data-active="selected.transport !== 'websocket'" @click="setTransport('http')">HTTP 轮询</button>
        <button type="button" :data-active="selected.transport === 'websocket'" @click="setTransport('websocket')">WebSocket 长连接</button>
      </div>
      <p class="muted">长连接省去每次轮询的握手；改动在设备下次同步后生效。</p>
    </article>
    <article class="block"><h3>能力快照</h3><ul v-if="capabilityEntries().length" class="caps"><li v-for="entry in capabilityEntries()" :key="entry.key"><code>{{ entry.key }}</code><span>{{ entry.value }}</span></li></ul><p v-else class="muted">设备尚未上报能力快照。</p></article>
    <article class="block"><h3>最近命令</h3><ul v-if="selected.recentCommands.length" class="caps"><li v-for="command in selected.recentCommands" :key="command.id"><code>{{ command.capabilityId }}</code><span>{{ command.state }} · 尝试 {{ command.attemptCount }} · {{ command.createdAt }}</span></li></ul><p v-else class="muted">尚无下发命令记录。</p></article>
  </AppDialog>
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

.table-shell{margin-top:14px;overflow:auto;border-radius:var(--radius-md);background:var(--surface-1)}table{width:100%;border-collapse:collapse}th,td{padding:18px 20px;text-align:left}th{color:var(--ink-muted);font-size:9px;letter-spacing:.08em}td{font-size:12px}tbody tr{background:var(--surface-1)}tbody tr:nth-child(odd){background:var(--surface-2)}tbody tr.selected{outline:2px solid var(--ink)}td:first-child{display:grid;gap:3px}td small{color:var(--ink-muted)}.state{display:inline-flex;align-items:center;gap:7px}.state::before{content:"";width:8px;height:8px;border-radius:50%;background:var(--ink-muted)}.state[data-online="true"]::before{background:var(--good)}.state[data-disabled="true"]::before{background:var(--bad)}.row-actions{text-align:right}.row-actions button,.rename button,.actions button,.detail header button{min-height:44px;padding:0 16px;border:0;border-radius:14px;background:var(--surface-2);color:var(--ink);cursor:pointer}.rename button,.actions button:not(.danger){background:var(--ink);color:var(--canvas)}.actions button.danger{color:var(--bad)}button:disabled{opacity:.45;cursor:not-allowed}
.bulk{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-top:14px;padding:16px 20px;border-radius:var(--radius-md);background:var(--surface-1)}.bulk div:first-child{display:grid;gap:4px}.bulk span{color:var(--ink-muted);font-size:9px;letter-spacing:.12em}.bulk strong{font-size:14px}.bulk small{color:var(--ink-muted);font-size:10px}.bulk-actions{display:flex;gap:8px}.bulk-actions button{min-height:44px;padding:0 16px;border:0;border-radius:14px;background:var(--surface-2);color:var(--ink);cursor:pointer}.bulk-actions button.danger{color:var(--bad)}.bulk-actions .pick{color:var(--ink-soft)}.detail{margin-top:16px;padding:24px;border-radius:var(--radius-md);background:var(--surface-1)}.detail header{display:flex;justify-content:space-between;align-items:start}.detail header span{color:var(--ink-muted);font-size:9px;letter-spacing:.12em}.detail h2{margin:7px 0 4px;font-size:22px}.detail header small{color:var(--ink-muted)}.detail-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:18px}.detail-grid article,.block{padding:18px;border-radius:16px;background:var(--surface-2)}.detail h3{margin:0 0 12px;font-size:13px}dl{display:grid;grid-template-columns:auto 1fr;gap:8px 16px;margin:0}dt{color:var(--ink-muted);font-size:10px}dd{margin:0;font-size:12px}.rename{display:flex;align-items:end;gap:12px;margin-top:14px}.rename label{display:grid;gap:7px;flex:1;font-size:10px;color:var(--ink-soft)}.rename input{min-height:44px;padding:0 14px;border:0;border-radius:14px;background:var(--surface-2);color:var(--ink)}.actions{display:flex;gap:10px;margin-top:14px}.block{margin-top:14px}.caps{display:grid;gap:6px;margin:0;padding:0;list-style:none}.caps li{display:flex;justify-content:space-between;gap:14px;padding:10px 14px;border-radius:12px;background:var(--surface-1);font-size:11px}.caps code{font-family:ui-monospace,monospace}.caps span{color:var(--ink-soft)}@media(max-width:780px){.detail-grid{grid-template-columns:1fr}.rename{flex-direction:column;align-items:stretch}}
</style>