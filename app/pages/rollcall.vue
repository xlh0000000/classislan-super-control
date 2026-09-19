<script setup lang="ts">
import { type RollCallSettingKey, type RollCallSettingsDraft } from "#shared/schemas";

type ScopeType = "school" | "organization" | "device";
type Roster = {
  id: string; name: string; scopeType: ScopeType; scopeId: string | null;
  names: string[]; revision: number; updatedAt: string;
};
/** 某个作用域自己写下的点名设置行；字段为 null 表示这一项不表态。 */
type SettingsRow = RollCallSettingsDraft & {
  scopeType: ScopeType; scopeId: string | null; revision: number; updatedAt: string;
};
/** 逐台设备的生效名单：命中层级告诉教师这份名单是不是自己改得动的。 */
type EffectiveDevice = {
  deviceId: string; deviceName: string; names: string[]; revision: number;
  scopeType: ScopeType | "none"; rosterId: string | null;
  settings: RollCallSettingsDraft;
  settingSources: Partial<Record<RollCallSettingKey, string>>;
  deviceOverride: RollCallSettingsDraft | null;
};
type OrgData = { nodes: { id: string; name: string; path: string }[] };
type DeviceRow = { id: string; name: string; orgName: string };

const EMPTY_DRAFT: RollCallSettingsDraft = { enabled: null, notify: null, singleSeconds: null, multiSeconds: null };

/** 设置行带着作用域与版本等元信息，填表只取那四项表态。 */
function settingsOf(row: Pick<SettingsRow, "enabled" | "notify" | "singleSeconds" | "multiSeconds"> | null): RollCallSettingsDraft {
  return {
    enabled: row?.enabled ?? null,
    notify: row?.notify ?? null,
    singleSeconds: row?.singleSeconds ?? null,
    multiSeconds: row?.multiSeconds ?? null,
  };
}

const toast = useToast();
const { user } = useSession();
/** 教师没有名单库与组织树，只能看到自己设备上的生效名单。 */
const teacherView = user.value?.role === "teacher";
const { data, refresh } = await useFetch<{ rosters: Roster[]; settings: SettingsRow[] }>("/api/v1/admin/rollcall", {
  default: () => ({ rosters: [], settings: [] }),
  immediate: !teacherView,
});
const { data: org } = await useFetch<OrgData>("/api/v1/admin/organization", {
  default: () => ({ nodes: [] }),
  immediate: !teacherView,
});
const { data: deviceList } = await useFetch<DeviceRow[]>("/api/v1/admin/devices", { default: () => [] });
const { data: effective, refresh: refreshEffective } = await useFetch<{ devices: EffectiveDevice[] }>("/api/v1/admin/rollcall/effective", {
  default: () => ({ devices: [] }),
  immediate: teacherView,
});

const draft = ref<{ id: string | null; name: string; scopeType: ScopeType; scopeId: string; names: string } | null>(null);
const pending = ref(false);
const removing = ref<Roster | null>(null);

const scopeText: Record<ScopeType | "none", string> = { school: "全校", organization: "组织", device: "设备", none: "未设置" };

function scopeLabel(roster: Roster) {
  if (roster.scopeType === "school") return "全校";
  const target = roster.scopeType === "organization"
    ? org.value.nodes.find((node) => node.id === roster.scopeId)?.name ?? "已删除的组织"
    : deviceList.value.find((device) => device.id === roster.scopeId)?.name ?? "已删除的设备";
  return `${scopeText[roster.scopeType]} · ${target}`;
}

function openCreate() {
  draft.value = { id: null, name: "", scopeType: "school", scopeId: "", names: "" };
}

function openEdit(roster: Roster) {
  draft.value = { id: roster.id, name: roster.name, scopeType: roster.scopeType, scopeId: roster.scopeId ?? "", names: roster.names.join("\n") };
}

/** 教师改的是本机覆盖名单：以生效名单为起点，保存后就盖住上级名单。 */
function openDeviceEdit(row: EffectiveDevice) {
  draft.value = {
    id: row.scopeType === "device" ? row.rosterId : null,
    name: row.deviceName,
    scopeType: "device",
    scopeId: row.deviceId,
    names: row.names.join("\n"),
  };
}

async function save() {
  const value = draft.value;
  if (!value) return;
  if (!value.name.trim()) return toast.err("请填写名单名称。");
  if (value.scopeType !== "school" && !value.scopeId) return toast.err("请选择名单作用的目标。");
  pending.value = true;
  try {
    await $fetch("/api/v1/admin/rollcall", {
      method: "POST" as const,
      headers: import.meta.client ? { origin: window.location.origin } : undefined,
      body: {
        name: value.name.trim(),
        scopeType: value.scopeType,
        scopeId: value.scopeType === "school" ? null : value.scopeId,
        names: value.names.split(/\r?\n/),
      },
    });
    if (teacherView) await refreshEffective();
    else await refresh();
    draft.value = null;
    toast.ok("名单已保存并开始下发。");
  } catch (err) { toast.err((err as { data?: { message?: string } })?.data?.message ?? "保存名单失败。"); }
  finally { pending.value = false; }
}

/** 删除本机覆盖名单：设备会退回上一级（组织或全校）名单。 */
const removingDevice = ref<EffectiveDevice | null>(null);
async function removeDeviceRoster() {
  const row = removingDevice.value;
  if (!row?.rosterId) return;
  pending.value = true;
  try {
    await $fetch(`/api/v1/admin/rollcall/${row.rosterId}`, {
      method: "DELETE" as const,
      headers: import.meta.client ? { origin: window.location.origin } : undefined,
    });
    await refreshEffective();
    removingDevice.value = null;
    toast.ok("已删除本机名单，退回上级名单。");
  } catch (err) { toast.err((err as { data?: { message?: string } })?.data?.message ?? "删除名单失败。"); }
  finally { pending.value = false; }
}

async function remove() {
  const roster = removing.value;
  if (!roster) return;
  pending.value = true;
  try {
    await $fetch(`/api/v1/admin/rollcall/${roster.id}`, {
      method: "DELETE" as const,
      headers: import.meta.client ? { origin: window.location.origin } : undefined,
    });
    await refresh();
    removing.value = null;
    toast.ok("名单已删除，设备下次轮询即清空。");
  } catch (err) { toast.err((err as { data?: { message?: string } })?.data?.message ?? "删除名单失败。"); }
  finally { pending.value = false; }
}

/** 点名默认设置：先定作用域，再看这一层已经写下的那一行。 */
const defaultScope = ref<{ type: "school" | "organization"; id: string }>({ type: "school", id: "" });
const defaultRow = computed(() => data.value.settings.find((row) =>
  row.scopeType === defaultScope.value.type && (row.scopeId ?? "") === defaultScope.value.id) ?? null);
const defaultDraft = ref<RollCallSettingsDraft>(settingsOf(defaultRow.value));
const defaultsBusy = ref(false);

/** 换作用域就把表单换成那一行自己的表态，不把上一作用域的值带过去。 */
watch(defaultScope, () => {
  defaultDraft.value = settingsOf(defaultRow.value);
}, { deep: true });

async function saveDefaults(cleared = false) {
  if (defaultsBusy.value) return;
  const scope = defaultScope.value;
  if (scope.type !== "school" && !scope.id) return toast.err("请选择默认设置作用的目标组织。");
  defaultsBusy.value = true;
  try {
    const draft = defaultDraft.value;
    await $fetch("/api/v1/admin/rollcall/settings", {
      method: "POST" as const,
      headers: import.meta.client ? { origin: window.location.origin } : undefined,
      body: {
        scopeType: scope.type, scopeId: scope.type === "school" ? null : scope.id,
        enabled: draft.enabled, notify: draft.notify,
        singleSeconds: draft.singleSeconds, multiSeconds: draft.multiSeconds,
      },
    });
    await refresh();
    defaultDraft.value = settingsOf(defaultRow.value);
    toast.ok(cleared ? "已清除本层设置，交回上级与设备决定。" : "默认设置已保存并开始下发。");
  } catch (err) { toast.err((err as { data?: { message?: string } })?.data?.message ?? "保存默认设置失败。"); }
  finally { defaultsBusy.value = false; }
}

/** 清除本层设置：四项全不表态，服务端据此删掉这一行。 */
async function clearDefaults() {
  defaultDraft.value = { ...EMPTY_DRAFT };
  await saveDefaults(true);
}
</script>

<template>
  <PageHeading :kicker="teacherView ? '跟着设备生效' : '名单下发给设备悬浮窗'" :title="teacherView ? '我的点名名单' : '点名名单'">
    <button v-if="!teacherView" type="button" class="solid" @click="openCreate">新增名单</button>
  </PageHeading>

  <template v-if="teacherView">
    <EmptyState v-if="!effective.devices.length" title="还没有绑定到你的设备" action="查看设备" to="/devices" />
    <section v-else class="rosters">
      <article v-for="row in effective.devices" :key="row.deviceId">
        <header>
          <strong>{{ row.deviceName }}</strong>
          <span class="scope">{{ scopeText[row.scopeType] }}</span>
        </header>
        <p class="names">{{ row.names.length ? `${row.names.slice(0, 12).join("、")}${row.names.length > 12 ? " …" : ""}` : "暂无姓名" }}</p>
        <footer>
          <small>{{ row.names.length }} 人 · 第 {{ row.revision }} 版</small>
          <div>
            <button type="button" class="ghost" @click="openDeviceEdit(row)">编辑</button>
            <button v-if="row.scopeType === 'device' && row.rosterId" type="button" class="ghost remove" @click="removingDevice = row">删除</button>
          </div>
        </footer>
      </article>
    </section>
  </template>

  <template v-else>
  <EmptyState v-if="!data.rosters.length" title="还没有点名名单" />

  <section v-else class="rosters">
    <article v-for="roster in data.rosters" :key="roster.id">
      <header>
        <strong>{{ roster.name }}</strong>
        <span class="scope">{{ scopeLabel(roster) }}</span>
      </header>
      <p class="names">{{ roster.names.slice(0, 12).join("、") }}{{ roster.names.length > 12 ? " …" : "" }}</p>
      <footer>
        <small>{{ roster.names.length }} 人 · 第 {{ roster.revision }} 版</small>
        <div>
          <button type="button" class="ghost" @click="openEdit(roster)">编辑</button>
          <button type="button" class="ghost remove" @click="removing = roster">删除</button>
        </div>
      </footer>
    </article>
  </section>

  <fieldset class="defaults">
    <legend>点名默认设置</legend>
    <div class="scope-pick">
      <label>作用范围
        <select v-model="defaultScope.type" @change="defaultScope.id = ''">
          <option value="school">全校</option>
          <option value="organization">组织</option>
        </select>
      </label>
      <label v-if="defaultScope.type === 'organization'">目标组织
        <select v-model="defaultScope.id">
          <option value="">请选择组织</option>
          <option v-for="node in org.nodes" :key="node.id" :value="node.id">{{ node.name }}</option>
        </select>
      </label>
    </div>
    <RollCallSettingsFields v-model="defaultDraft" follow-label="交给设备" :disabled="defaultsBusy" />
    <footer class="defaults-foot">
      <small>{{ defaultRow
        ? `${revisionLabel(defaultRow.revision)} · ${defaultRow.updatedAt.slice(5, 16).replace("T", " ")}`
        : "这一层还没表态，设备用自己的设置。" }}</small>
      <div class="controls">
        <button type="button" class="ghost" :disabled="defaultsBusy || !defaultRow" @click="clearDefaults">清除本层设置</button>
        <button type="button" class="solid" :disabled="defaultsBusy" @click="saveDefaults()">{{ defaultsBusy ? "保存中…" : "保存并下发" }}</button>
      </div>
    </footer>
  </fieldset>
  </template>

  <AppDialog v-if="draft" :title="teacherView ? `编辑 ${draft.name}` : (draft.id ? '编辑名单' : '新增名单')" :kicker="teacherView ? '每行一个姓名' : '选好范围，填上姓名'" width="640px" @close="draft = null">
    <div v-if="!teacherView" class="form">
      <label>名单名称<input v-model="draft.name" maxlength="60" placeholder="例如：高一（2）班"></label>
      <label>作用范围
        <select v-model="draft.scopeType" @change="draft.scopeId = ''">
          <option value="school">全校</option>
          <option value="organization">组织</option>
          <option value="device">设备</option>
        </select>
      </label>
      <label v-if="draft.scopeType === 'organization'">目标组织
        <select v-model="draft.scopeId">
          <option value="">请选择组织</option>
          <option v-for="node in org.nodes" :key="node.id" :value="node.id">{{ node.name }}</option>
        </select>
      </label>
      <label v-if="draft.scopeType === 'device'">目标设备
        <select v-model="draft.scopeId">
          <option value="">请选择设备</option>
          <option v-for="device in deviceList" :key="device.id" :value="device.id">{{ device.name }} · {{ device.orgName }}</option>
        </select>
      </label>
    </div>
    <label class="names-box">姓名列表（每行一个）
      <textarea v-model="draft.names" rows="10" placeholder="张三&#10;李四"></textarea>
    </label>
    <template #footer>
      <button type="button" class="ghost" @click="draft = null">取消</button>
      <button type="button" class="solid" :disabled="pending" @click="save">{{ pending ? "保存中…" : "保存并下发" }}</button>
    </template>
  </AppDialog>

  <ConfirmDialog
    v-if="removing"
    title="删除名单"
    :description="`确定删除「${removing.name}」？设备端会在下次轮询后清空该名单。`"
    confirm-text="删除"
    danger
    :busy="pending"
    @close="removing = null"
    @confirm="remove"
  />

  <ConfirmDialog
    v-if="removingDevice"
    title="删除本机名单"
    :description="`确定删除「${removingDevice.deviceName}」的本机名单？该设备改用上级名单。`"
    confirm-text="删除"
    danger
    :busy="pending"
    @close="removingDevice = null"
    @confirm="removeDeviceRoster"
  />
</template>

<style scoped>
.rosters { display: grid; grid-template-columns: repeat(auto-fill, minmax(330px, 1fr)); gap: 14px; }
.rosters article { display: grid; gap: 14px; padding: 24px 26px; border: 1px solid var(--line-soft); background: var(--surface-1); transition: border-color var(--t-base) var(--ease-enter); }
.rosters article:hover { border-color: var(--accent); }
.rosters header { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
.rosters strong { font-size: 18px; font-weight: 600; letter-spacing: -0.3px; }
.scope { padding: 4px 9px; border: 1px solid var(--line); color: var(--ink-muted); font-size: 10px; letter-spacing: 0.6px; }
.names { margin: 0; color: var(--ink-soft); font-size: 12px; line-height: 1.8; }
.rosters footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-top: 12px; border-top: 1px solid var(--line-soft); }
.rosters small { color: var(--ink-faint); font-size: 10px; letter-spacing: 0.8px; font-variant-numeric: tabular-nums; }
.rosters footer div { display: flex; gap: 16px; }
.rosters footer button { min-height: 0; padding: 0 0 3px; border: 0; border-bottom: 1px solid transparent; background: none; color: var(--ink-muted); font-size: 11px; letter-spacing: 0.5px; }
.rosters footer button:hover:not(:disabled) { border-bottom-color: var(--accent); background: none; color: var(--accent); }
.rosters .remove:hover:not(:disabled) { border-bottom-color: var(--bad); color: var(--bad); }
.form { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
.form label, .names-box { display: grid; gap: 8px; color: var(--ink-muted); font-size: 11px; letter-spacing: 0.6px; }
.form input, .form select, .names-box textarea { width: 100%; }
.names-box { margin-top: 18px; }
.names-box textarea { padding: 12px 14px; line-height: 1.9; resize: vertical; }
.defaults { margin-top: 14px; padding: 22px 24px; border: 1px solid var(--line-soft); background: var(--surface-1); }
.defaults legend { padding: 0 10px; color: var(--ink-muted); font-size: 10px; letter-spacing: 1.2px; }
.scope-pick { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; padding-bottom: 16px; border-bottom: 1px solid var(--line-soft); }
.scope-pick label { display: grid; gap: 8px; color: var(--ink-muted); font-size: 11px; letter-spacing: 0.6px; }
.scope-pick select { width: 100%; }
.defaults-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--line-soft); }
.defaults-foot small { color: var(--ink-faint); font-size: 10px; letter-spacing: 0.8px; font-variant-numeric: tabular-nums; }
.defaults-foot div { display: flex; align-items: center; gap: 14px; }
@media (max-width: 640px) { .form, .scope-pick { grid-template-columns: 1fr; } }
</style>