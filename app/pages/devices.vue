<script setup lang="ts">
type DeviceRow = { id: string; name: string; pluginVersion: string; appVersion: string; transport: string; lastSeen: string | null; disabledAt: string | null; orgName: string; online: boolean; disabled: boolean };
type TimetableSnapshot = {
  name?: string;
  selectedClassPlanGroupId?: string;
  classPlanGroups?: Record<string, { name?: string; isGlobal?: boolean; classPlanIds?: string[] }>;
  classPlans?: Record<string, { name?: string; timeLayoutId?: string; classes?: { subjectId?: string; startTime?: string; endTime?: string }[] }>;
  timeLayouts?: Record<string, { name?: string; layouts?: { startTime?: string; endTime?: string }[] }>;
  subjects?: Record<string, { name?: string; color?: string }>;
};
type DeviceDetail = {
  id: string; name: string; orgNodeId: string | null; pluginVersion: string; appVersion: string; platform: string; transport: string;
  capabilityDigest: string; policyRevision: number; driftCount: number; lastSequence: number;
  lastSeenAt: string | null; createdAt: string | null; disabledAt: string | null; online: boolean;
  policyStatus?: { desired: { revision: number; epoch: number; hash: string; sections: string[]; lockedPointers: number }; applied: { revision: number; epoch: number; hash: string; sections: unknown; driftCount: number }; inSync: boolean };
  capabilitySnapshot: unknown; tagIds: string[]; recentCommands: { id: string; capabilityId: string; state: string; attemptCount: number; createdAt: string }[];
  timetable?: TimetableSnapshot | null;
  timetableStatus?: { digest: string; uploadedAt: string; subjectsCount: number; timeLayoutsCount: number; classPlansCount: number; classPlanGroupsCount: number } | null;
  crashStatus?: { total: number; last7d: number; lastAt: string | null } | null;
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
  return selected.value?.online ? "有偏差，待重同步" : "离线未上报";
});
/** 崩溃摘要只给一行，堆栈与归组在崩溃页看。 */
const crashText = computed(() => {
  const status = selected.value?.crashStatus;
  if (!status || !status.total) return "无记录";
  const last = status.lastAt ? ` · 最近 ${status.lastAt.slice(5, 16).replace("T", " ")}` : "";
  return `${status.total} 条 · 近 7 天 ${status.last7d}${last}`;
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

/** 课表档案（贡献者：威廉）：按档案内"当前选中课表群"展开为 课表群 → 课表 → 课程。 */
function timetableEntries() {
  const timetable = selected.value?.timetable;
  if (!timetable) return [];
  const groups = timetable.classPlanGroups ?? {};
  const plans = timetable.classPlans ?? {};
  const subjects = timetable.subjects ?? {};
  const layouts = timetable.timeLayouts ?? {};
  const selectedGroupId = timetable.selectedClassPlanGroupId;
  const groupIds = selectedGroupId && groups[selectedGroupId] ? [selectedGroupId] : Object.keys(groups);
  return groupIds.map((groupId) => {
    const group = groups[groupId]!;
    const planIds = group.classPlanIds?.length ? group.classPlanIds : Object.keys(plans);
    return {
      id: groupId,
      name: group.name || "未命名课表群",
      isGlobal: group.isGlobal,
      isSelected: groupId === selectedGroupId,
      plans: planIds
        .map((planId) => plans[planId])
        .filter((plan): plan is NonNullable<typeof plan> => !!plan)
        .map((plan) => ({
          id: plan.timeLayoutId || "",
          name: plan.name || "未命名课表",
          layoutName: plan.timeLayoutId ? layouts[plan.timeLayoutId]?.name : "",
          classes: (plan.classes ?? [])
            .map((lesson) => ({
              subject: lesson.subjectId ? subjects[lesson.subjectId]?.name || "未知科目" : "自修",
              startTime: lesson.startTime ?? "",
              endTime: lesson.endTime ?? "",
            }))
            .filter((lesson) => lesson.subject || lesson.startTime || lesson.endTime),
        })),
    };
  });
}

/** 上传状态行：摘要前 12 位 + 各类计数。 */
function timetableSummary() {
  const status = selected.value?.timetableStatus;
  if (!status) return "";
  return `${status.subjectsCount} 科目 · ${status.timeLayoutsCount} 时间表 · ${status.classPlansCount} 课表 · ${status.classPlanGroupsCount} 课表群`;
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

/** 采纳为配置（贡献者：威廉）：把设备课表档案写入配置库（kind=profile），可经策略引用下发给其他设备。 */
const adopting = ref(false);
async function adoptTimetable() {
  const device = selected.value;
  if (!device || adopting.value) return;
  adopting.value = true;
  try {
    const result = await $fetch<{ configurationId: string; revision: number; name: string }>(`/api/v1/admin/devices/${device.id}/adopt-timetable`, {
      method: "POST", headers: { origin: location.origin },
    });
    toast.ok(`已采纳为配置「${result.name}」（R${result.revision}）。`);
  } catch (err) { toast.err((err as { data?: { message?: string } })?.data?.message ?? "采纳失败。"); }
  finally { adopting.value = false; }
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
      <tbody><tr v-for="device in devices" :key="device.id" :class="{ selected: selected?.id === device.id }"><td><strong>{{ device.name }}</strong><small>{{ device.id }}</small></td><td>{{ device.orgName }}</td><td><span class="state" :data-online="device.online" :data-disabled="device.disabled">{{ device.disabled ? "已禁用" : device.online ? "在线" : "离线" }}</span></td><td>{{ device.transport === "websocket" ? "长连接" : "轮询" }}</td><td>{{ device.pluginVersion }} / {{ device.appVersion }}</td><td>{{ device.lastSeen || "从未" }}</td><td class="row-actions"><button type="button" @click="open(device)">详情</button></td></tr></tbody>
    </table>
  </div>
  <EmptyState v-else title="还没有设备接入" action="创建接入凭据" to="/enrollment" />
  <TargetPickerDialog v-if="showTargets" @close="showTargets = false" />
  <AppDialog v-if="loading" title="设备详情"
 kicker="设备详情" width="940px" @close="loading = false">
    <p class="muted">正在加载…</p>
  </AppDialog>
  <AppDialog v-else-if="selected" :title="selected.name" kicker="设备详情" width="940px" @close="selected = null">
    <small class="muted">{{ selected.id }}</small>
    <div class="detail-grid">
      <article><h3>版本</h3><dl><dt>插件版本</dt><dd>{{ selected.pluginVersion || "—" }}</dd><dt>宿主版本</dt><dd>{{ selected.appVersion || "—" }}</dd><dt>平台</dt><dd>{{ selected.platform || "—" }}</dd><dt>能力摘要</dt><dd>{{ selected.capabilityDigest || "—" }}</dd></dl></article>
      <article><h3>同步</h3><dl><dt>期望策略</dt><dd>R{{ selected.policyStatus?.desired.revision ?? selected.policyRevision }}</dd><dt>已应用</dt><dd>R{{ selected.policyRevision }}</dd><dt>同步状态</dt><dd>{{ syncText }}</dd><dt>偏差计数</dt><dd>{{ selected.driftCount }}</dd><dt>崩溃记录</dt><dd>{{ crashText }} <NuxtLink class="crash-link" :to="`/crashes?deviceId=${selected.id}`">明细</NuxtLink></dd><dt>最近序号</dt><dd>{{ selected.lastSequence }}</dd><dt>最后联系</dt><dd>{{ selected.online ? "在线" : "离线" }} · {{ selected.lastSeenAt || "从未" }}</dd><dt>注册时间</dt><dd>{{ selected.createdAt }}</dd></dl></article>
    </div>
    <form class="rename" @submit.prevent="rename"><label>设备名称<input v-model.trim="renameValue" maxlength="100"></label><button :disabled="!renameValue.trim() || renameValue === selected.name">保存名称</button></form>
    <div class="actions"><button v-if="!selected.disabledAt" type="button" class="danger" @click="setDisabled(true)">禁用设备</button><button v-else type="button" @click="setDisabled(false)">恢复设备</button><button type="button" class="danger" @click="releaseDevice">解除集控</button><button type="button" class="danger" @click="removeDevice">删除设备</button></div>
    <article class="block"><h3>连接</h3>
      <div class="seg">
        <button type="button" :data-active="selected.transport !== 'websocket'" @click="setTransport('http')">HTTP 轮询</button>
        <button type="button" :data-active="selected.transport === 'websocket'" @click="setTransport('websocket')">WebSocket 长连接</button>
      </div>
      <p class="muted">长连接不用反复握手，下次同步生效。</p>
    </article>
    <article class="block timetable-block"><h3>课表</h3>
      <template v-if="selected.timetable">
        <div class="timetable-toolbar">
          <span class="timetable-summary">{{ timetableSummary() }}<template v-if="selected.timetableStatus"> · 摘要 {{ selected.timetableStatus.digest.slice(0, 12) }}…</template></span>
          <button type="button" :disabled="adopting" @click="adoptTimetable">采纳为配置</button>
        </div>
        <p class="muted">「{{ selected.timetable.name || "未命名" }}」· {{ selected.timetableStatus?.uploadedAt || "—" }}。采纳后能在策略里发给别的设备。</p>
        <div v-for="group in timetableEntries()" :key="group.id" class="timetable-group">
          <h4>{{ group.name }}<template v-if="group.isSelected"> · 当前选中</template><small v-if="group.isGlobal"> · 全局</small></h4>
          <div v-if="group.plans.length" class="timetable-plans">
            <div v-for="plan in group.plans" :key="plan.id" class="timetable-plan">
              <h5>{{ plan.name }}<small v-if="plan.layoutName"> · {{ plan.layoutName }}</small></h5>
              <ul v-if="plan.classes.length" class="lessons">
                <li v-for="(lesson, index) in plan.classes" :key="index"><span class="lesson-index">{{ index + 1 }}</span><strong>{{ lesson.subject }}</strong><span v-if="lesson.startTime">{{ lesson.startTime }}–{{ lesson.endTime || "?" }}</span></li>
              </ul>
              <p v-else class="muted">空课表</p>
            </div>
          </div>
          <p v-else class="muted">还没排课。</p>
        </div>
      </template>
      <p v-else class="muted">设备还没上传课表。</p>
    </article>
    <article class="block"><h3>能力</h3><ul v-if="capabilityEntries().length" class="caps"><li v-for="entry in capabilityEntries()" :key="entry.key"><code>{{ entry.key }}</code><span>{{ entry.value }}</span></li></ul><p v-else class="muted">还没上报能力。</p></article>
    <article class="block"><h3>最近命令</h3><ul v-if="selected.recentCommands.length" class="caps"><li v-for="command in selected.recentCommands" :key="command.id"><code>{{ command.capabilityId }}</code><span>{{ command.state }} · 尝试 {{ command.attemptCount }} · {{ command.createdAt }}</span></li></ul><p v-else class="muted">还没有下发记录。</p></article>
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

.detail header { display: flex; justify-content: space-between; align-items: flex-start; }
.detail h2 { margin: 8px 0 6px; font-size: 22px; }
.detail header small { color: var(--ink-muted); }
.detail-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-top: 20px; }
.detail-grid article, .block { padding: 20px 22px; border: 1px solid var(--line-soft); background: var(--surface-1); }
.block { margin-top: 14px; }
.detail h3, .block h3 { margin: 0 0 16px; color: var(--ink-muted); font-size: 10px; font-weight: 400; letter-spacing: 1.2px; }
.crash-link { color: var(--accent); text-decoration: none; border-bottom: 1px solid var(--accent); }
dl { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 10px 18px; margin: 0; }
dt { color: var(--ink-muted); font-size: 11px; }
dd { margin: 0; font-size: 13px; word-break: break-all; }
.rename { display: flex; align-items: flex-end; gap: 14px; margin-top: 18px; }
.rename label { display: grid; gap: 8px; flex: 1; color: var(--ink-muted); font-size: 11px; letter-spacing: 0.6px; }
.rename input { width: 100%; }
.actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 18px; }
.timetable-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap; }
.timetable-summary { color: var(--ink-soft); font-size: 12px; }
.timetable-group { margin-top: 18px; }
.timetable-group h4 { margin: 0 0 10px; font-size: 13px; font-weight: 600; }
.timetable-group h4 small { color: var(--ink-muted); font-weight: 400; }
.timetable-plans { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
.timetable-plan { padding: 14px 16px; border: 1px solid var(--line); background: var(--canvas); }
.timetable-plan h5 { margin: 0 0 10px; font-size: 13px; font-weight: 600; }
.timetable-plan h5 small { color: var(--ink-muted); font-weight: 400; }
.lessons { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }
.lessons li { display: flex; align-items: center; gap: 10px; font-size: 12px; }
.lesson-index { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; flex: none; border: 1px solid var(--line); color: var(--ink-muted); font-size: 9px; }
.lessons li strong { font-weight: 500; }
.lessons li span:last-child { margin-left: auto; color: var(--ink-soft); }
.caps { display: grid; gap: 0; margin: 0; padding: 0; list-style: none; border-top: 1px solid var(--line-soft); }
.caps li { display: flex; justify-content: space-between; gap: 16px; padding: 12px 2px; border-bottom: 1px solid var(--line-soft); font-size: 12px; }
.caps code { font-family: ui-monospace, monospace; color: var(--ink-muted); }
.caps span { color: var(--ink-soft); text-align: right; }
@media (max-width: 780px) {
  .detail-grid { grid-template-columns: 1fr; }
  .rename { flex-direction: column; align-items: stretch; }
  .bulk { flex-direction: column; align-items: flex-start; }
}
</style>