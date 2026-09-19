<script setup lang="ts">
import type { RollCallSettingKey, RollCallSettingsDraft } from "#shared/schemas";

type TimetableSnapshot = {
  name?: string;
  selectedClassPlanGroupId?: string;
  classPlanGroups?: Record<string, { name?: string; isGlobal?: boolean; classPlanIds?: string[] }>;
  classPlans?: Record<string, { name?: string; timeLayoutId?: string; classes?: { subjectId?: string; startTime?: string; endTime?: string }[] }>;
  timeLayouts?: Record<string, { name?: string; layouts?: { startTime?: string; endTime?: string }[] }>;
  subjects?: Record<string, { name?: string; color?: string }>;
};
type BoundTeacher = { userId: string; username: string; displayName: string; boundBy: "admin" | "qr"; createdAt: string };
type DeviceDetail = {
  id: string; name: string; orgNodeId: string | null; pluginVersion: string; appVersion: string; platform: string; transport: string;
  capabilityDigest: string; policyRevision: number; driftCount: number; lastSequence: number;
  lastSeenAt: string | null; createdAt: string | null; disabledAt: string | null; online: boolean;
  policyStatus?: { desired: { revision: number; epoch: number; hash: string; sections: string[]; lockedPointers: number }; applied: { revision: number; epoch: number; hash: string; sections: unknown; driftCount: number }; inSync: boolean };
  capabilitySnapshot: unknown; tagIds: string[]; recentCommands: { id: string; capabilityId: string; state: string; attemptCount: number; createdAt: string }[];
  teachers?: BoundTeacher[];
  timetable?: TimetableSnapshot | null;
  timetableStatus?: { digest: string; uploadedAt: string; subjectsCount: number; timeLayoutsCount: number; classPlansCount: number; classPlanGroupsCount: number } | null;
  crashStatus?: { total: number; last7d: number; lastAt: string | null } | null;
};

const props = defineProps<{ deviceId: string }>();
const emit = defineEmits<{ close: []; changed: [] }>();
const toast = useToast();
const { user, can } = useSession();
const selected = ref<DeviceDetail | null>(null);
const loading = ref(true);
const renameValue = ref("");
const showPolicy = ref(false);
/** 教师与组织范围账号看到的入口不同：写操作的按钮跟接口把关用同一份权限表。 */
const canManage = computed(() => can("devices.write"));
const canBind = computed(() => can("binding.write"));
const canApply = computed(() => can("timetable.apply"));
const canRollCall = computed(() => can("rollcall.read"));
const canWriteRollCall = computed(() => can("rollcall.write"));

/** 内容按主题分栏展示，避免长弹窗全部堆在一起。 */
const detailTabs = computed(() => [
  { key: "overview", label: "概览" },
  ...(canManage.value ? [{ key: "transport", label: "连接" }] : []),
  { key: "timetable", label: "课表" },
  ...(canRollCall.value ? [{ key: "rollcall", label: "点名" }] : []),
  ...(canBind.value ? [{ key: "teachers", label: "教师" }] : []),
  { key: "capabilities", label: "能力" },
  { key: "commands", label: "命令" },
]);
const tab = ref<string>("overview");

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

onMounted(async () => {
  try {
    const detail = await $fetch<DeviceDetail>(`/api/v1/admin/devices/${props.deviceId}`);
    selected.value = detail;
    renameValue.value = detail.name;
    // 教师列表与课表配置只是下拉的数据源：角色看不到就留空，不该因此关掉整个详情。
    const [accounts, configs] = await Promise.all([
      can("users.read") ? $fetch<UserRow[]>("/api/v1/admin/users").catch(() => [] as UserRow[]) : Promise.resolve([] as UserRow[]),
      canApply ? $fetch<ConfigurationRow[]>("/api/v1/admin/configurations").catch(() => [] as ConfigurationRow[]) : Promise.resolve([] as ConfigurationRow[]),
    ]);
    teacherAccounts.value = accounts.filter((account) => account.role === "teacher");
    profileConfigs.value = configs.filter((row) => row.kind === "profile");
    await loadRollCall();
  } catch (err) {
    toast.err((err as { data?: { message?: string } })?.data?.message ?? "加载设备详情失败。");
    emit("close");
  } finally {
    loading.value = false;
  }
});

async function rename() {
  const device = selected.value;
  if (!device || !renameValue.value.trim() || renameValue.value === device.name) return;
  try {
    await $fetch(`/api/v1/admin/devices/${device.id}`, { method: "PATCH", headers: { origin: location.origin }, body: { name: renameValue.value.trim() } });
    device.name = renameValue.value.trim();
    toast.ok("已保存设备名称。");
    emit("changed");
  } catch (err) { toast.err((err as { data?: { message?: string } })?.data?.message ?? "重命名失败。"); }
}

/** 连接模式由集控端指定：设备在下一轮同步时按新传输重连。 */
async function setTransport(transport: "http" | "websocket") {
  if (!selected.value || selected.value.transport === transport) return;
  try {
    await $fetch(`/api/v1/admin/devices/${selected.value.id}`, { method: "PATCH", headers: { origin: location.origin }, body: { transport } });
    selected.value.transport = transport;
    toast.ok(transport === "websocket" ? "已切换为长连接。" : "已切换为定时轮询。");
    emit("changed");
  } catch (err) { toast.err((err as { data?: { message?: string } })?.data?.message ?? "切换连接模式失败。"); }
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
    toast.ok(disabled ? "已禁用设备。" : "已恢复设备。");
    emit("changed");
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
    emit("changed");
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
    toast.ok("已删除设备。");
    emit("changed");
    emit("close");
  } catch (err) { toast.err((err as { data?: { message?: string } })?.data?.message ?? "删除失败。"); }
}

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
    toast.ok(`已采纳为配置「${result.name}」（第 ${result.revision} 版）。`);
  } catch (err) { toast.err((err as { data?: { message?: string } })?.data?.message ?? "采纳失败。"); }
  finally { adopting.value = false; }
}

/** 套用课表（教师主路径）：把配置库里的一份课表下发到这台设备。 */
type ConfigurationRow = { configurationId: string; name: string; kind: string; currentRevision: number | null };
const profileConfigs = ref<ConfigurationRow[]>([]);
const applyConfigId = ref("");
const applying = ref(false);
async function applyTimetable() {
  const device = selected.value;
  if (!device || !applyConfigId.value || applying.value) return;
  applying.value = true;
  try {
    await $fetch(`/api/v1/admin/configurations/${applyConfigId.value}/deploy`, {
      method: "POST", headers: { origin: location.origin },
      body: { targets: [{ type: "device", id: device.id }] },
    });
    toast.ok("课表已下发，设备下次联系时生效。");
  } catch (err) { toast.err((err as { data?: { message?: string } })?.data?.message ?? "套用课表失败。"); }
  finally { applying.value = false; }
}

/** 教师绑定：管理端挑教师账号绑到本机；教师本人只能解自己的绑。 */
type UserRow = { id: string; username: string; displayName: string; role: string };
const teacherAccounts = ref<UserRow[]>([]);
const bindUserId = ref("");
const binding = ref(false);
const unbinding = ref("");

async function reloadDetail() {
  try { selected.value = await $fetch<DeviceDetail>(`/api/v1/admin/devices/${props.deviceId}`); }
  catch (err) { toast.err((err as { data?: { message?: string } })?.data?.message ?? "刷新设备详情失败。"); }
}

/** 可选的教师：还没绑到本机上的那几位。 */
const bindCandidates = computed(() => {
  const bound = new Set((selected.value?.teachers ?? []).map((teacher) => teacher.userId));
  return teacherAccounts.value.filter((account) => !bound.has(account.id));
});

async function bindSelectedTeacher() {
  const device = selected.value;
  if (!device || !bindUserId.value || binding.value) return;
  binding.value = true;
  try {
    await $fetch(`/api/v1/admin/devices/${device.id}/teachers`, { method: "POST", headers: { origin: location.origin }, body: { userId: bindUserId.value } });
    bindUserId.value = "";
    toast.ok("已绑定教师。");
    await reloadDetail();
  } catch (err) { toast.err((err as { data?: { message?: string } })?.data?.message ?? "绑定教师失败。"); }
  finally { binding.value = false; }
}

function unbindTeacher(teacher: BoundTeacher) {
  const device = selected.value;
  if (!device) return;
  pending.value = {
    title: "解除教师绑定",
    description: `解除 ${teacher.displayName} 与「${device.name}」的绑定？解绑后该教师在这台设备上不再有权限。`,
    confirmText: "解除", danger: true, run: () => runUnbind(teacher),
  };
}
async function runUnbind(teacher: BoundTeacher) {
  const device = selected.value;
  if (!device) return;
  unbinding.value = teacher.userId;
  try {
    await $fetch(`/api/v1/admin/devices/${device.id}/teachers/${teacher.userId}`, { method: "DELETE", headers: { origin: location.origin } });
    toast.ok("已解除绑定。");
    await reloadDetail();
  } catch (err) { toast.err((err as { data?: { message?: string } })?.data?.message ?? "解除绑定失败。"); }
  finally { unbinding.value = ""; }
}

/** 点名面板的生效层级：none 表示作用域链上没给这台设备指派名单。 */
const ROLLCALL_SCOPE_LABELS: Record<string, string> = {
  school: "全校默认", organization: "组织默认", device: "本机覆盖", none: "还没指派",
};
const EMPTY_DRAFT: RollCallSettingsDraft = { enabled: null, notify: null, singleSeconds: null, multiSeconds: null };

/** 这一台设备的点名现状：名单与四项设置各自按 本机 > 组织 > 全校 继承。 */
type RollCallState = {
  revision: number; names: string[]; scopeType: "school" | "organization" | "device" | "none"; rosterId: string | null;
  settings: RollCallSettingsDraft;
  settingSources: Record<RollCallSettingKey, string>;
  deviceOverride: RollCallSettingsDraft | null;
};
const rollCall = ref<RollCallState | null>(null);
const rollCallBusy = ref(false);
const showRoster = ref(false);
const rosterDraft = ref("");
const settingsDraft = ref<RollCallSettingsDraft>({ ...EMPTY_DRAFT });

const rosterSourceText = computed(() => {
  const state = rollCall.value;
  if (!state) return "";
  if (state.scopeType === "none") return "集控端还没给这台设备指派名单";
  return `${ROLLCALL_SCOPE_LABELS[state.scopeType]} · ${state.names.length} 人 · ${revisionLabel(state.revision)}`;
});

async function loadRollCall() {
  if (!canRollCall.value) return;
  try {
    const result = await $fetch<{ devices: RollCallState[] }>("/api/v1/admin/rollcall/effective", { query: { deviceId: props.deviceId } });
    const state = result.devices[0];
    if (!state) return;
    rollCall.value = state;
    // 只把本机那一层摊回表单：沿用上级名单时输入框保持空，保存才会创建覆盖。
    rosterDraft.value = state.scopeType === "device" ? state.names.join("\n") : "";
    settingsDraft.value = { ...EMPTY_DRAFT, ...(state.deviceOverride ?? {}) };
  } catch (err) { toast.err((err as { data?: { message?: string } })?.data?.message ?? "加载点名设置失败。"); }
}

async function saveRoster() {
  const device = selected.value;
  if (!device || rollCallBusy.value) return;
  const names = rosterDraft.value.split(/\r?\n/).map((name) => name.trim()).filter(Boolean);
  if (!names.length) return toast.err("本机名单里至少要有一个姓名。");
  rollCallBusy.value = true;
  try {
    await $fetch("/api/v1/admin/rollcall", {
      method: "POST", headers: { origin: location.origin },
      body: { name: `${device.name} 本机名单`, scopeType: "device", scopeId: device.id, names },
    });
    toast.ok("本机名单已保存并开始下发。");
    await loadRollCall();
  } catch (err) { toast.err((err as { data?: { message?: string } })?.data?.message ?? "保存本机名单失败。"); }
  finally { rollCallBusy.value = false; }
}

function confirmRemoveRoster() {
  const state = rollCall.value;
  const device = selected.value;
  if (!state?.rosterId || !device) return;
  pending.value = {
    title: "删除本机名单",
    description: `删除「${device.name}」的本机名单？该设备改用上级名单。`,
    confirmText: "删除", danger: true, run: removeRoster,
  };
}
async function removeRoster() {
  const state = rollCall.value;
  if (!state?.rosterId || rollCallBusy.value) return;
  rollCallBusy.value = true;
  try {
    await $fetch(`/api/v1/admin/rollcall/${state.rosterId}`, { method: "DELETE", headers: { origin: location.origin } });
    toast.ok("已删除本机名单，退回上级名单。");
    await loadRollCall();
  } catch (err) { toast.err((err as { data?: { message?: string } })?.data?.message ?? "删除本机名单失败。"); }
  finally { rollCallBusy.value = false; }
}

/** 保存本机覆盖：四项全不表态等于清除覆盖，交还给上级与设备本机设置。 */
async function saveSettings(clear = false) {
  const device = selected.value;
  if (!device || rollCallBusy.value) return;
  rollCallBusy.value = true;
  try {
    const draft = settingsDraft.value;
    const result = await $fetch<{ settings: RollCallSettingsDraft | null }>("/api/v1/admin/rollcall/settings", {
      method: "POST", headers: { origin: location.origin },
      body: {
        scopeType: "device", scopeId: device.id,
        enabled: clear ? null : draft.enabled,
        notify: clear ? null : draft.notify,
        singleSeconds: clear ? null : draft.singleSeconds,
        multiSeconds: clear ? null : draft.multiSeconds,
      },
    });
    toast.ok(result.settings ? "点名设置已下发到本机。" : "已清除本机覆盖，交还给上级设置。");
    await loadRollCall();
  } catch (err) { toast.err((err as { data?: { message?: string } })?.data?.message ?? "保存点名设置失败。"); }
  finally { rollCallBusy.value = false; }
}
</script>

<template>
  <AppDialog v-if="loading" title="设备详情" kicker="设备详情" width="940px" @close="emit('close')">
    <p class="muted">正在加载…</p>
  </AppDialog>
  <AppDialog v-else-if="selected" :title="selected.name" kicker="设备详情" width="940px" @close="emit('close')">
    <small class="muted">{{ selected.id }}</small>
    <PageTabs v-model="tab" :items="detailTabs" class="detail-tabs" />
    <template v-if="tab === 'overview'">
      <div class="detail-grid">
      <article><h3>版本</h3><dl><dt>插件版本</dt><dd>{{ selected.pluginVersion || "—" }}</dd><dt>宿主版本</dt><dd>{{ selected.appVersion || "—" }}</dd><dt>平台</dt><dd>{{ selected.platform || "—" }}</dd><dt>能力摘要</dt><dd>{{ selected.capabilityDigest || "—" }}</dd></dl></article>
      <article><h3>同步</h3><dl><dt>期望策略</dt><dd>第 {{ selected.policyStatus?.desired.revision ?? selected.policyRevision }} 版</dd><dt>已应用</dt><dd>第 {{ selected.policyRevision }} 版</dd><dt>同步状态</dt><dd>{{ syncText }}</dd><dt>偏差计数</dt><dd>{{ selected.driftCount }}</dd><dt>崩溃记录</dt><dd>{{ crashText }} <NuxtLink v-if="can('crashes.read')" class="crash-link" :to="`/crashes?deviceId=${selected.id}`">明细</NuxtLink></dd><dt>最近序号</dt><dd>{{ selected.lastSequence }}</dd><dt>最后联系</dt><dd>{{ selected.online ? "在线" : "离线" }} · {{ selected.lastSeenAt || "从未" }}</dd><dt>注册时间</dt><dd>{{ selected.createdAt }}</dd></dl></article>
    </div>
    <form v-if="canManage" class="rename toolbar" @submit.prevent="rename"><label>设备名称<input v-model.trim="renameValue" maxlength="100"></label><button :disabled="!renameValue.trim() || renameValue === selected.name">保存名称</button></form>
    <div class="actions"><button type="button" @click="showPolicy = true">生效策略明细</button><template v-if="canManage"><button v-if="!selected.disabledAt" type="button" class="danger" @click="setDisabled(true)">禁用设备</button><button v-else type="button" @click="setDisabled(false)">恢复设备</button><button type="button" class="danger" @click="releaseDevice">解除集控</button><button type="button" class="danger" @click="removeDevice">删除设备</button></template></div>
    </template>
    <article v-else-if="tab === 'transport'" class="block">
      <div class="seg">
        <button type="button" :data-active="selected.transport !== 'websocket'" @click="setTransport('http')">定时轮询</button>
        <button type="button" :data-active="selected.transport === 'websocket'" @click="setTransport('websocket')">长连接</button>
      </div>
      <p class="muted">长连接不用反复握手，下次同步生效。</p>
    </article>
    <article v-else-if="tab === 'timetable'" class="block timetable-block">
      <div v-if="canApply" class="apply-row toolbar">
        <label>套用课表
          <select v-model="applyConfigId">
            <option value="">请选择课表配置</option>
            <option v-for="row in profileConfigs" :key="row.configurationId" :value="row.configurationId">{{ row.name }} · 第 {{ row.currentRevision }} 版</option>
          </select>
        </label>
        <button type="button" class="solid" :disabled="!applyConfigId || applying" @click="applyTimetable">{{ applying ? "下发中…" : "下发到本机" }}</button>
      </div>
      <template v-if="selected.timetable">
        <div class="timetable-toolbar controls">
          <span class="timetable-summary">{{ timetableSummary() }}<template v-if="selected.timetableStatus"> · 摘要 {{ selected.timetableStatus.digest.slice(0, 12) }}…</template></span>
          <button v-if="can('configurations.write')" type="button" :disabled="adopting" @click="adoptTimetable">采纳为配置</button>
        </div>
        <p class="muted">「{{ selected.timetable.name || "未命名" }}」· {{ selected.timetableStatus?.uploadedAt || "—" }}</p>
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
    <article v-else-if="tab === 'rollcall'" class="block rollcall-block">
      <p v-if="!rollCall" class="muted">没有可显示的点名内容。</p>
      <template v-else>
        <div class="roster-line">
          <span class="roster-source">{{ rosterSourceText }}</span>
          <button v-if="rollCall.names.length" type="button" class="ghost" @click="showRoster = !showRoster">
            {{ showRoster ? "收起名单" : "查看当前名单" }}
          </button>
        </div>
        <p v-if="showRoster" class="roster-names">{{ rollCall.names.join("、") }}</p>

        <template v-if="canWriteRollCall">
          <h4>本机覆盖名单</h4>
          <label class="names-box">姓名（每行一个）
            <textarea v-model="rosterDraft" rows="6" placeholder="每行一个姓名"></textarea>
          </label>
          <div class="line-actions controls">
            <button type="button" :disabled="rollCallBusy" @click="saveRoster">保存为本机名单</button>
            <button v-if="rollCall.scopeType === 'device'" type="button" class="ghost remove" :disabled="rollCallBusy" @click="confirmRemoveRoster">删除本机名单</button>
          </div>

          <h4>点名行为</h4>
        </template>
        <RollCallSettingsFields v-model="settingsDraft" :effective="rollCall.settings" :sources="rollCall.settingSources" :disabled="!canWriteRollCall || rollCallBusy" />
        <div v-if="canWriteRollCall" class="line-actions controls">
          <button type="button" class="solid" :disabled="rollCallBusy" @click="saveSettings()">{{ rollCallBusy ? "保存中…" : "保存并下发" }}</button>
          <button v-if="rollCall.deviceOverride" type="button" class="ghost remove" :disabled="rollCallBusy" @click="saveSettings(true)">清除本机覆盖</button>
        </div>
      </template>
    </article>
    <article v-else-if="tab === 'teachers'" class="block">
      <ul v-if="selected.teachers?.length" class="teacher-list">
        <li v-for="teacher in selected.teachers" :key="teacher.userId">
          <div class="teacher-name"><strong>{{ teacher.displayName }}</strong><small>{{ teacher.username }}</small></div>
          <span class="teacher-meta">{{ teacher.boundBy === "qr" ? "扫码绑定" : "管理端绑定" }} · {{ teacher.createdAt.slice(5, 16).replace("T", " ") }}</span>
          <button type="button" class="ghost remove" :disabled="unbinding === teacher.userId" @click="unbindTeacher(teacher)">
            {{ teacher.userId === user?.id ? "解除我的绑定" : "解绑" }}
          </button>
        </li>
      </ul>
      <p v-else class="muted">这台设备还没有教师绑定。</p>
      <div v-if="can('users.read')" class="bind-row toolbar">
        <label>绑定教师
          <select v-model="bindUserId">
            <option value="">请选择教师账号</option>
            <option v-for="account in bindCandidates" :key="account.id" :value="account.id">{{ account.displayName }} · {{ account.username }}</option>
          </select>
        </label>
        <button type="button" :disabled="!bindUserId || binding" @click="bindSelectedTeacher">{{ binding ? "绑定中…" : "绑定" }}</button>
      </div>
    </article>
    <article v-else-if="tab === 'capabilities'" class="block"><ul v-if="capabilityEntries().length" class="caps"><li v-for="entry in capabilityEntries()" :key="entry.key"><code>{{ entry.key }}</code><span>{{ entry.value }}</span></li></ul><p v-else class="muted">还没上报能力。</p></article>
    <article v-else-if="tab === 'commands'" class="block"><ul v-if="selected.recentCommands.length" class="caps"><li v-for="command in selected.recentCommands" :key="command.id"><code>{{ labelOf(CAPABILITY_LABELS, command.capabilityId) }}</code><span>{{ labelOf(COMMAND_STATE_LABELS, command.state) }} · 尝试 {{ command.attemptCount }} · {{ command.createdAt }}</span></li></ul><p v-else class="muted">还没有下发记录。</p></article>
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
  <DevicePolicyDialog v-if="showPolicy" :device-id="deviceId" @close="showPolicy = false" />
</template>

<style scoped>
.detail-tabs { margin-top: 16px; }
.detail-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.detail-grid article, .block { padding: 20px 22px; border: 1px solid var(--line-soft); background: var(--surface-1); }
.detail-grid h3 { margin: 0 0 16px; color: var(--ink-muted); font-size: 10px; font-weight: 400; letter-spacing: 1.2px; }
.crash-link { color: var(--accent); text-decoration: none; border-bottom: 1px solid var(--accent); }
dl { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 10px 18px; margin: 0; }
dt { color: var(--ink-muted); font-size: 11px; }
dd { margin: 0; font-size: 13px; word-break: break-all; }
.rename { margin: 18px 0 0; }
.rename label { flex: 1; }
.rename input { width: 100%; }
.actions { display: flex; flex-wrap: wrap; gap: 14px; margin-top: 18px; }
button:disabled { opacity: 0.45; cursor: not-allowed; }
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
/* 教师绑定与课表套用：与设备详情其余区块同一套发丝线刻度。 */
.apply-row, .bind-row { margin-bottom: 18px; }
.apply-row { padding-bottom: 18px; border-bottom: 1px solid var(--line-soft); }
.bind-row { margin: 18px 0 0; }
.apply-row label, .bind-row label { flex: 1; }
.apply-row select, .bind-row select { width: 100%; }
.teacher-list { display: grid; gap: 0; margin: 0; padding: 0; list-style: none; border-top: 1px solid var(--line-soft); }
.teacher-list li { display: flex; align-items: center; gap: 16px; padding: 12px 2px; border-bottom: 1px solid var(--line-soft); }
.teacher-name { display: grid; gap: 3px; min-width: 0; }
.teacher-name strong { font-size: 13px; font-weight: 600; }
.teacher-name small { color: var(--ink-faint); font-size: 10px; letter-spacing: 0.6px; }
.teacher-meta { margin-left: auto; color: var(--ink-muted); font-size: 10px; letter-spacing: 0.6px; font-variant-numeric: tabular-nums; }
.teacher-list .remove { min-height: 0; padding: 0 0 3px; border: 0; border-bottom: 1px solid transparent; background: none; color: var(--ink-muted); font-size: 11px; }
.teacher-list .remove:hover:not(:disabled) { border-bottom-color: var(--bad); background: none; color: var(--bad); }
/* 点名面板：沿用设备详情的发丝线分区，名单与设置各占一段。 */
.rollcall-block h4 { margin: 24px 0 4px; font-size: 11px; font-weight: 400; letter-spacing: 1.2px; color: var(--ink-muted); }
.rollcall-block h4:first-child { margin-top: 0; }
.roster-line { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding-bottom: 14px; border-bottom: 1px solid var(--line-soft); }
.roster-source { color: var(--ink-soft); font-size: 12px; font-variant-numeric: tabular-nums; }
.roster-names { margin: 14px 0 0; padding: 12px 14px; max-height: 190px; overflow-y: auto; border: 1px solid var(--line); background: var(--canvas); color: var(--ink-soft); font-size: 12px; line-height: 1.9; }
.names-box { display: grid; gap: 8px; margin-top: 10px; color: var(--ink-muted); font-size: 11px; letter-spacing: 0.6px; }
.names-box textarea { width: 100%; padding: 12px 14px; line-height: 1.9; resize: vertical; }
.line-actions { display: flex; flex-wrap: wrap; gap: 14px; margin-top: 14px; }
.line-actions .remove { color: var(--bad); }
@media (max-width: 780px) {
  .detail-grid { grid-template-columns: 1fr; }
  .rename { flex-direction: column; align-items: stretch; }
}
</style>
