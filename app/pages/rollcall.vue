<script setup lang="ts">
type ScopeType = "school" | "organization" | "device";
type Roster = {
  id: string; name: string; scopeType: ScopeType; scopeId: string | null;
  names: string[]; revision: number; updatedAt: string;
};
type OrgData = { nodes: { id: string; name: string; path: string }[] };
type DeviceRow = { id: string; name: string; orgName: string };

const toast = useToast();
const { data, refresh } = await useFetch<{ rosters: Roster[] }>("/api/v1/admin/rollcall", {
  default: () => ({ rosters: [] }),
});
const { data: org } = await useFetch<OrgData>("/api/v1/admin/organization", {
  default: () => ({ nodes: [] }),
});
const { data: deviceList } = await useFetch<DeviceRow[]>("/api/v1/admin/devices", { default: () => [] });

const draft = ref<{ id: string | null; name: string; scopeType: ScopeType; scopeId: string; names: string } | null>(null);
const pending = ref(false);
const removing = ref<Roster | null>(null);

const scopeText: Record<ScopeType, string> = { school: "全校", organization: "组织", device: "设备" };

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
    await refresh();
    draft.value = null;
    toast.ok("名单已保存并开始下发。");
  } catch (err) { toast.err((err as { data?: { message?: string } })?.data?.message ?? "保存名单失败。"); }
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
</script>

<template>
  <PageHeading kicker="名单下发给设备悬浮窗" title="点名名单">
    <button type="button" class="solid" @click="openCreate">新增名单</button>
  </PageHeading>

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

  <AppDialog v-if="draft" :title="draft.id ? '编辑名单' : '新增名单'" kicker="选好范围，填上姓名" width="640px" @close="draft = null">
    <div class="form">
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
@media (max-width: 640px) { .form { grid-template-columns: 1fr; } }
</style>