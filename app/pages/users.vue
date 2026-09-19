<script setup lang="ts">
import { assignableRoles, roleLabels } from "#shared/permissions";

type UserRow = { id: string; username: string; displayName: string; role: string; scopeOrgNodeId: string | null; createdAt: string; disabledAt: string | null; mustChangePassword?: number };
type OrgNode = { id: string; name: string; path: string };
type BulkResult = { created: { id: string; username: string; displayName: string; password: string }[]; rejected: { username: string; reason: string }[] };
const { data, refresh } = await useFetch<UserRow[]>("/api/v1/admin/users", { default: () => [] });
const { data: orgData } = await useFetch<{ nodes: OrgNode[] }>("/api/v1/admin/organization", { default: () => ({ nodes: [] }) });
const orgNodes = computed(() => orgData.value.nodes);
const roles = Object.entries(roleLabels) as [string, string][];
const creatableRoles = assignableRoles.map((role) => [role, roleLabels[role] ?? role] as [string, string]);
const showCreate = ref(false);
const editing = ref<UserRow | null>(null);
const toast = useToast();

const createForm = reactive({ username: "", displayName: "", password: "", role: "viewer", scopeOrgNodeId: "" });
const editForm = reactive({ displayName: "", role: "viewer", password: "", scopeOrgNodeId: "" });

function roleLabel(value: string) { return roleLabels[value] ?? value; }
function scopeLabel(value: string | null) { return value ? (orgNodes.value.find((node) => node.id === value)?.name ?? value) : "全校"; }
async function createUser() {
  try {
    await $fetch("/api/v1/admin/users", { method: "POST", headers: { origin: location.origin }, body: { username: createForm.username, displayName: createForm.displayName || undefined, password: createForm.password, role: createForm.role, scopeOrgNodeId: createForm.role === "teacher" ? null : (createForm.scopeOrgNodeId || null) } });
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
  // 转成教师时清掉组织范围：他的可用设备只由绑定关系决定。
  const scopeValue = editForm.role === "teacher" ? null : (editForm.scopeOrgNodeId || null);
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

/** 批量建号：每行“用户名[, 显示名]”，初始密码由服务端生成且只显示这一次。 */
const MAX_BULK = 50;
const showBulk = ref(false);
const bulkBusy = ref(false);
const bulkText = ref("");
const bulkResult = ref<BulkResult | null>(null);
const bulkAccounts = computed(() => bulkText.value.split(/\r?\n/)
  .map((line) => line.split(/[,，\s]+/).filter(Boolean))
  .filter((parts) => parts.length)
  .map((parts) => ({ username: parts[0]!, displayName: parts.slice(1).join(" ") || undefined })));
const bulkOver = computed(() => bulkAccounts.value.length > MAX_BULK);

async function createBulk() {
  if (!bulkAccounts.value.length || bulkOver.value || bulkBusy.value) return;
  bulkBusy.value = true;
  try {
    bulkResult.value = await $fetch<BulkResult>("/api/v1/admin/users/bulk-teachers", {
      method: "POST", headers: { origin: location.origin },
      body: { accounts: bulkAccounts.value },
    });
    await refresh();
    if (bulkResult.value.created.length) toast.ok(`已创建 ${bulkResult.value.created.length} 个教师账号。`);
  } catch (err) { toast.err((err as { data?: { message?: string } })?.data?.message ?? "批量创建失败。"); }
  finally { bulkBusy.value = false; }
}

function closeBulk() {
  showBulk.value = false; bulkText.value = ""; bulkResult.value = null;
}

async function copyPasswords() {
  const text = (bulkResult.value?.created ?? []).map((row) => `${row.username}\t${row.password}`).join("\n");
  try { await navigator.clipboard.writeText(text); toast.ok("已复制账号与初始密码。"); }
  catch { toast.err("浏览器不允许复制，请手抄。"); }
}
</script>

<template>
  <PageHeading kicker="谁能登录、能做什么" title="用户">
    <button type="button" @click="showBulk = true">批量新建教师</button>
    <button type="button" class="solid" @click="showCreate = true">新建用户</button>
  </PageHeading>

  <AppDialog v-if="showBulk" title="批量新建教师" kicker="初始密码只显示一次" width="720px" @close="closeBulk">
    <template v-if="!bulkResult">
      <span class="count">本次 {{ bulkAccounts.length }} / {{ MAX_BULK }} 个</span>
      <label class="bulk-lines">账号列表（每行一个：用户名 显示名）
        <textarea v-model="bulkText" rows="12" spellcheck="false" placeholder="teacher01 王老师"></textarea>
      </label>
      <p v-if="bulkOver" class="hint bad">一次最多 {{ MAX_BULK }} 个，请删掉一些再创建。</p>
    </template>
    <template v-else>
      <div v-if="bulkResult.created.length" class="table-shell issued">
        <table>
          <thead><tr><th>用户名</th><th>显示名</th><th>初始密码</th></tr></thead>
          <tbody><tr v-for="row in bulkResult.created" :key="row.id"><td>{{ row.username }}</td><td>{{ row.displayName }}</td><td class="pwd">{{ row.password }}</td></tr></tbody>
        </table>
      </div>
      <p v-if="bulkResult.created.length" class="hint">教师首次登录需改密。</p>
      <ul v-if="bulkResult.rejected.length" class="rejected">
        <li v-for="row in bulkResult.rejected" :key="row.username"><strong>{{ row.username }}</strong><span>{{ row.reason }}</span></li>
      </ul>
    </template>
    <template #footer>
      <template v-if="bulkResult">
        <button type="button" class="ghost" @click="closeBulk">完成</button>
        <button v-if="bulkResult.created.length" type="button" @click="copyPasswords">复制账号与密码</button>
      </template>
      <template v-else>
        <button type="button" class="ghost" @click="closeBulk">取消</button>
        <button type="button" class="solid" :disabled="bulkBusy || !bulkAccounts.length || bulkOver" @click="createBulk">{{ bulkBusy ? "创建中…" : "创建教师账号" }}</button>
      </template>
    </template>
  </AppDialog>

  <AppDialog v-if="showCreate" title="新建用户" kicker="账号与角色" @close="showCreate = false">
    <form id="user-create" class="editor" @submit.prevent="createUser">
      <label>用户名<input v-model.trim="createForm.username" required minlength="3" maxlength="32" pattern="[A-Za-z0-9_.\-]+" placeholder="operator01"></label>
      <label>显示名称<input v-model.trim="createForm.displayName" maxlength="50" placeholder="可选"></label>
      <label>初始密码<input v-model="createForm.password" type="password" required minlength="12" maxlength="128" autocomplete="new-password"></label>
      <label>角色<select v-model="createForm.role"><option v-for="role in creatableRoles" :key="role[0]" :value="role[0]">{{ role[1] }}</option></select></label>
      <!-- 教师的可用设备只由绑定关系决定，管理范围对他没有意义。 -->
      <label v-if="createForm.role !== 'teacher'">管理范围<select v-model="createForm.scopeOrgNodeId"><option value="">全校</option><option v-for="node in orgNodes" :key="node.id" :value="node.id">{{ node.name }}</option></select></label>
    </form>
    <template #footer>
      <button type="button" class="ghost" @click="showCreate = false">取消</button>
      <button type="submit" form="user-create">创建用户</button>
    </template>
  </AppDialog>

  <AppDialog v-if="editing" title="编辑用户" kicker="账号与角色" @close="editing = null">
    <form id="user-edit" class="editor" @submit.prevent="saveEdit">
      <label>显示名称<input v-model.trim="editForm.displayName" maxlength="50"></label>
      <label>角色<select v-model="editForm.role" :disabled="editing.role === 'owner'"><option v-for="role in roles" :key="role[0]" :value="role[0]" :disabled="editing.role === 'owner' && role[0] !== 'owner'">{{ role[1] }}</option></select></label>
      <label v-if="editForm.role !== 'teacher'">管理范围<select v-model="editForm.scopeOrgNodeId" :disabled="editing.role === 'owner' || editForm.role === 'owner'"><option value="">全校</option><option v-for="node in orgNodes" :key="node.id" :value="node.id">{{ node.name }}</option></select></label>
      <label>重置密码<input v-model="editForm.password" type="password" minlength="12" maxlength="128" autocomplete="new-password" placeholder="留空表示不修改"></label>
    </form>
    <template #footer>
      <button type="button" class="ghost" @click="editing = null">取消</button>
      <button type="submit" form="user-edit">保存</button>
    </template>
  </AppDialog>

  <div v-if="data.length" class="table-shell">
    <table>
      <thead><tr><th>账号</th><th>角色</th><th>范围</th><th>创建时间</th><th>状态</th><th></th></tr></thead>
      <tbody>
        <tr v-for="user in data" :key="user.id">
          <td class="account"><strong>{{ user.displayName }}</strong><small>{{ user.username }}</small></td>
          <td>{{ roleLabel(user.role) }}</td>
          <td>{{ user.role === 'teacher' ? '绑定设备' : scopeLabel(user.scopeOrgNodeId) }}</td>
          <td class="time">{{ user.createdAt }}</td>
          <td>{{ user.disabledAt ? '已停用' : user.mustChangePassword ? '待改密' : '正常' }}</td>
          <td class="row-actions">
            <button type="button" @click="openEdit(user)">编辑</button>
            <button type="button" :disabled="user.role === 'owner'" @click="toggleUser(user)">{{ user.disabledAt ? '启用' : '停用' }}</button>
            <button type="button" :disabled="user.role === 'owner'" @click="removeUser(user)">删除</button>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
  <EmptyState v-else title="还没有用户" />

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
</template><style scoped>
.editor { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
.editor label { display: grid; gap: 8px; color: var(--ink-muted); font-size: 11px; letter-spacing: 0.6px; }
.editor input, .editor select { width: 100%; }
.table-shell { overflow: auto; border-top: 1px solid var(--line-strong); }
.account { display: grid; gap: 4px; }
.account strong { font-size: 14px; font-weight: 600; color: var(--ink); }
.account small { color: var(--ink-muted); font-size: 10px; letter-spacing: 0.6px; }
.time { color: var(--ink-muted); font-size: 11px; font-variant-numeric: tabular-nums; }
.row-actions { justify-content: flex-end; }
.row-actions button:disabled { opacity: 0.35; }
/* 批量建号：一行一个账号，结果里的初始密码只在这一次可见。 */
.count { display: block; margin-bottom: 10px; color: var(--ink-faint); font-size: 10px; letter-spacing: 0.9px; }
.bulk-lines { display: grid; gap: 8px; color: var(--ink-muted); font-size: 11px; letter-spacing: 0.6px; }
.bulk-lines textarea { width: 100%; padding: 12px 14px; line-height: 1.9; resize: vertical; font-family: ui-monospace, monospace; font-size: 12px; }
.hint { margin: 14px 0 0; color: var(--ink-muted); font-size: 11px; }
.hint.bad { color: var(--bad); }
.issued { margin-top: 4px; }
.pwd { font-family: ui-monospace, monospace; letter-spacing: 0.6px; }
.rejected { display: grid; gap: 0; margin: 16px 0 0; padding: 0; list-style: none; border-top: 1px solid var(--line-soft); }
.rejected li { display: flex; justify-content: space-between; gap: 16px; padding: 10px 2px; border-bottom: 1px solid var(--line-soft); font-size: 12px; }
.rejected li span { color: var(--ink-muted); }
@media (max-width: 780px) { .editor { grid-template-columns: 1fr; } }
</style>