<script setup lang="ts">
type UserRow = { id: string; username: string; displayName: string; role: string; scopeOrgNodeId: string | null; createdAt: string; disabledAt: string | null };
type OrgNode = { id: string; name: string; path: string };
const { data, refresh } = await useFetch<UserRow[]>("/api/v1/admin/users", { default: () => [] });
const { data: orgData } = await useFetch<{ nodes: OrgNode[] }>("/api/v1/admin/organization", { default: () => ({ nodes: [] }) });
const orgNodes = computed(() => orgData.value.nodes);
const roles = [["owner", "所有者"], ["admin", "管理员"], ["operator", "操作员"], ["auditor", "审计员"], ["viewer", "只读"]] as const;
const creatableRoles = roles.filter((role) => role[0] !== "owner");
const showCreate = ref(false);
const editing = ref<UserRow | null>(null);
const toast = useToast();

const createForm = reactive({ username: "", displayName: "", password: "", role: "viewer", scopeOrgNodeId: "" });
const editForm = reactive({ displayName: "", role: "viewer", password: "", scopeOrgNodeId: "" });

function roleLabel(value: string) { return roles.find((role) => role[0] === value)?.[1] ?? value; }
function scopeLabel(value: string | null) { return value ? (orgNodes.value.find((node) => node.id === value)?.name ?? value) : "全校"; }
async function createUser() {
  try {
    await $fetch("/api/v1/admin/users", { method: "POST", headers: { origin: location.origin }, body: { username: createForm.username, displayName: createForm.displayName || undefined, password: createForm.password, role: createForm.role, scopeOrgNodeId: createForm.scopeOrgNodeId || null } });
    createForm.username = ""; createForm.displayName = ""; createForm.password = ""; createForm.role = "viewer"; createForm.scopeOrgNodeId = "";
    showCreate.value = false; toast.ok("已创建用户。"); await refresh();
  } catch (err) { toast.err((err as { data?: { message?: string } })?.data?.message ?? "创建失败。"); }
}

function openEdit(user: UserRow) {
  editing.value = user;
  editForm.displayName = user.displayName; editForm.role = user.role; editForm.password = ""; editForm.scopeOrgNodeId = user.scopeOrgNodeId ?? "";
}

async function saveEdit() {
  if (!editing.value) return;
  const body: Record<string, unknown> = {};
  if (editForm.displayName && editForm.displayName !== editing.value.displayName) body.displayName = editForm.displayName;
  if (editForm.role !== editing.value.role) body.role = editForm.role;
  if (editForm.password) body.password = editForm.password;
  const scopeValue = editForm.scopeOrgNodeId || null;
  if (scopeValue !== (editing.value.scopeOrgNodeId ?? null)) body.scopeOrgNodeId = scopeValue;
  if (Object.keys(body).length === 0) { toast.info("没有需要保存的修改。"); return; }
  try {
    await $fetch(`/api/v1/admin/users/${editing.value.id}`, { method: "PATCH", headers: { origin: location.origin }, body });
    editing.value = null; toast.ok("已更新用户。"); await refresh();
  } catch (err) { toast.err((err as { data?: { message?: string } })?.data?.message ?? "更新失败。"); }
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
function toggleUser(user: UserRow) {
  if (user.disabledAt) { void runToggleUser(user); return; }
  pending.value = {
    title: "停用用户",
    description: `停用用户 ${user.username}？其会话会立即失效，需重新启用后才能登录。`,
    confirmText: "停用", danger: true, run: () => runToggleUser(user),
  };
}
async function runToggleUser(user: UserRow) {
  const action = user.disabledAt ? "enable" : "disable";
  try {
    await $fetch(`/api/v1/admin/users/${user.id}/${action}`, { method: "POST", headers: { origin: location.origin } });
    toast.ok(action === "disable" ? "已停用用户。" : "已启用用户。"); await refresh();
  } catch (err) { toast.err((err as { data?: { message?: string } })?.data?.message ?? "操作失败。"); }
}

function removeUser(user: UserRow) {
  pending.value = {
    title: "删除用户",
    description: `删除用户 ${user.username}？其会话会立即失效，此操作不可撤销。`,
    confirmText: "删除", danger: true, run: () => runRemoveUser(user),
  };
}
async function runRemoveUser(user: UserRow) {
  try {
    await $fetch(`/api/v1/admin/users/${user.id}`, { method: "DELETE", headers: { origin: location.origin } });
    toast.ok("已删除用户。"); await refresh();
  } catch (err) { toast.err((err as { data?: { message?: string } })?.data?.message ?? "删除失败。"); }
}
</script>

<template>
  <PageHeading kicker="ACCESS CONTROL / 账号与角色" title="用户" description="为管理人员分配最小必要角色。所有者唯一且不可降级；可将账号限定在某个组织子树内，仅能管理该范围内的设备与任务。密码使用 Argon2id 存储；修改密码、角色或组织范围会撤销该账号的现有会话，停用账号同样立即失效。">
    <button type="button" @click="showCreate = !showCreate">新建用户</button>
  </PageHeading>
  <AppDialog v-if="showCreate" title="新建用户" kicker="ACCESS CONTROL / 账号与角色" @close="showCreate = false">
    <form id="user-create" class="editor" @submit.prevent="createUser">
    <label>用户名<input v-model.trim="createForm.username" required minlength="3" maxlength="32" pattern="[A-Za-z0-9_.\-]+" placeholder="operator01"></label>
    <label>显示名称<input v-model.trim="createForm.displayName" maxlength="50" placeholder="可选"></label>
    <label>初始密码<input v-model="createForm.password" type="password" required minlength="12" maxlength="128" autocomplete="new-password"></label>
    <label>角色<select v-model="createForm.role"><option v-for="role in creatableRoles" :key="role[0]" :value="role[0]">{{ role[1] }}</option></select></label>
    <label>管理范围<select v-model="createForm.scopeOrgNodeId"><option value="">全校</option><option v-for="node in orgNodes" :key="node.id" :value="node.id">{{ node.name }}</option></select></label>
    </form>
    <template #footer>
      <button type="button" class="ghost" @click="showCreate = false">取消</button>
      <button type="submit" form="user-create">创建用户</button>
    </template>
  </AppDialog>
  <AppDialog v-if="editing" title="编辑用户" kicker="ACCESS CONTROL / 账号与角色" @close="editing = null">
    <form id="user-edit" class="editor" @submit.prevent="saveEdit">
    <label>显示名称<input v-model.trim="editForm.displayName" maxlength="50"></label>
    <label>角色<select v-model="editForm.role" :disabled="editing.role === 'owner'"><option v-for="role in roles" :key="role[0]" :value="role[0]" :disabled="editing.role === 'owner' && role[0] !== 'owner'">{{ role[1] }}</option></select></label>
    <label>管理范围<select v-model="editForm.scopeOrgNodeId" :disabled="editing.role === 'owner' || editForm.role === 'owner'"><option value="">全校</option><option v-for="node in orgNodes" :key="node.id" :value="node.id">{{ node.name }}</option></select></label>
    <label>重置密码<input v-model="editForm.password" type="password" minlength="12" maxlength="128" autocomplete="new-password" placeholder="留空表示不修改"></label>
    </form>
    <template #footer>
      <button type="button" class="ghost" @click="editing = null">取消</button>
      <button type="submit" form="user-edit">保存</button>
    </template>
  </AppDialog>
  <div v-if="data.length" class="table-shell">
    <table><thead><tr><th>账号</th><th>角色</th><th>范围</th><th>创建时间</th><th>状态</th><th></th></tr></thead>
      <tbody><tr v-for="user in data" :key="user.id"><td><strong>{{ user.displayName }}</strong><small>{{ user.username }}</small></td><td>{{ roleLabel(user.role) }}</td><td>{{ scopeLabel(user.scopeOrgNodeId) }}</td><td>{{ user.createdAt }}</td><td>{{ user.disabledAt ? '已停用' : '正常' }}</td><td class="row-actions"><button type="button" @click="openEdit(user)">编辑</button><button type="button" :disabled="user.role === 'owner'" @click="toggleUser(user)">{{ user.disabledAt ? '启用' : '停用' }}</button><button type="button" class="danger" :disabled="user.role === 'owner'" @click="removeUser(user)">删除</button></td></tr></tbody>
    </table>
  </div>
  <EmptyState v-else title="尚无用户" description="首位管理员通过首设向导创建；在 <code>/setup</code> 配置完成前该入口保持开启。" />
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

.editor{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:14px;padding:24px;border-radius:var(--radius-md);background:var(--surface-1)}.editor label{display:grid;gap:7px;font-size:10px;color:var(--ink-soft)}.editor input,.editor select{min-height:44px;padding:0 14px;border:0;border-radius:14px;background:var(--surface-2);color:var(--ink)}.editor .actions{grid-column:1/-1;display:flex;gap:8px}.editor button,.row-actions button{min-height:44px;padding:0 16px;border:0;border-radius:14px;background:var(--ink);color:var(--canvas);cursor:pointer}.editor button.ghost{background:var(--surface-2);color:var(--ink)}.table-shell{margin-top:14px;overflow:auto;border-radius:var(--radius-md);background:var(--surface-1)}table{width:100%;border-collapse:collapse}th,td{padding:18px 20px;text-align:left}th{color:var(--ink-muted);font-size:9px;letter-spacing:.08em}td{font-size:12px}tbody tr:nth-child(odd){background:var(--surface-2)}td:first-child{display:grid;gap:3px}td small{color:var(--ink-muted)}.row-actions{display:flex;gap:8px;justify-content:flex-end}.row-actions button{background:var(--surface-2);color:var(--ink)}.row-actions button.danger{color:var(--bad)}.row-actions button:disabled{opacity:.4;cursor:not-allowed}@media(max-width:780px){.editor{grid-template-columns:1fr}}
</style>