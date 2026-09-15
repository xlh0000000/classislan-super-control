<script setup lang="ts">
type OrgNode = { id: string; parentId: string | null; name: string; path: string; sortOrder: number };
type OrgTag = { id: string; name: string; color: string };
type OrgData = { nodes: OrgNode[]; tags: OrgTag[] };
const { data, refresh } = await useFetch<OrgData>("/api/v1/admin/organization", { default: () => ({ nodes: [], tags: [] }) });
const showNodeForm = ref(false); const showTagForm = ref(false);
const nodeName = ref(""); const parentId = ref(""); const tagName = ref(""); const tagColor = ref("#2563eb");
const editingNode = ref<{ id: string; name: string } | null>(null);
const editingTag = ref<{ id: string; name: string; color: string } | null>(null);
const toast = useToast();

async function run(action: () => Promise<unknown>, done: string) {
  try { await action(); toast.ok(done); await refresh(); }
  catch (err) { toast.err((err as { data?: { message?: string } })?.data?.message ?? "操作失败。"); }
}
async function createNode() {
  await run(async () => {
    if (!parentId.value) parentId.value = data.value.nodes[0]?.id || "";
    await $fetch("/api/v1/admin/organization/nodes", { method: "POST", headers: { origin: location.origin }, body: { parentId: parentId.value, name: nodeName.value } });
    nodeName.value = ""; showNodeForm.value = false;
  }, "已创建组织节点。");
}
async function createTag() {
  await run(async () => {
    await $fetch("/api/v1/admin/organization/tags", { method: "POST", headers: { origin: location.origin }, body: { name: tagName.value, color: tagColor.value } });
    tagName.value = ""; showTagForm.value = false;
  }, "已创建标签。");
}
async function saveNode() {
  if (!editingNode.value) return;
  const target = editingNode.value;
  await run(async () => {
    await $fetch(`/api/v1/admin/organization/nodes/${target.id}`, { method: "PATCH", headers: { origin: location.origin }, body: { name: target.name.trim() } });
    editingNode.value = null;
  }, "已重命名节点。");
}
async function saveTag() {
  if (!editingTag.value) return;
  const target = editingTag.value;
  await run(async () => {
    await $fetch(`/api/v1/admin/organization/tags/${target.id}`, { method: "PATCH", headers: { origin: location.origin }, body: { name: target.name.trim(), color: target.color } });
    editingTag.value = null;
  }, "已更新标签。");
}
/** 破坏性操作统一走二次确认弹窗，不用浏览器原生 confirm。 */
const pending = ref<{ title: string; description: string; confirmText: string; run: () => Promise<void> } | null>(null);
const confirmBusy = ref(false);
async function runPending() {
  const task = pending.value;
  if (!task) return;
  confirmBusy.value = true;
  try { await task.run(); }
  finally { confirmBusy.value = false; pending.value = null; }
}
function removeNode(node: OrgNode) {
  pending.value = {
    title: "删除组织节点",
    description: `删除组织节点「${node.name}」？子节点、设备或活动策略仍引用时服务端会拒绝。`,
    confirmText: "删除", run: () => runRemoveNode(node),
  };
}
async function runRemoveNode(node: OrgNode) {
  const url: string = `/api/v1/admin/organization/nodes/${node.id}`;
  await run(async () => { await $fetch(url, { method: "DELETE", headers: { origin: location.origin } }); }, "已删除组织节点。");
}
function removeTag(tag: OrgTag) {
  pending.value = {
    title: "删除标签",
    description: `删除标签「${tag.name}」？`,
    confirmText: "删除", run: () => runRemoveTag(tag),
  };
}
async function runRemoveTag(tag: OrgTag) {
  const url: string = `/api/v1/admin/organization/tags/${tag.id}`;
  await run(async () => { await $fetch(url, { method: "DELETE", headers: { origin: location.origin } }); }, "已删除标签。");
}
</script>

<template>
  <PageHeading kicker="ORGANIZATION / 组织结构" title="组织与标签" description="设备只属于一个组织树节点，并继承祖先策略；标签用于跨组织筛选和显式优先级策略。">
    <button type="button" @click="showNodeForm = !showNodeForm">新建节点</button><button type="button" @click="showTagForm = !showTagForm">新建标签</button>
  </PageHeading>
  <AppDialog v-if="showNodeForm" title="新建组织节点" kicker="ORGANIZATION / 组织树" @close="showNodeForm = false">
    <form id="node-create" class="editor-form" @submit.prevent="createNode"><label>父节点<select v-model="parentId" required><option v-for="node in data.nodes" :key="node.id" :value="node.id">{{ node.name }}</option></select></label><label>节点名称<input v-model="nodeName" required maxlength="80"></label></form>
    <template #footer>
      <button type="button" class="ghost" @click="showNodeForm = false">取消</button>
      <button type="submit" form="node-create">创建节点</button>
    </template>
  </AppDialog>
  <AppDialog v-if="showTagForm" title="新建设备标签" kicker="ORGANIZATION / 标签" @close="showTagForm = false">
    <form id="tag-create" class="editor-form" @submit.prevent="createTag"><label>标签名称<input v-model="tagName" required maxlength="50"></label><label>标签颜色<input v-model="tagColor" type="color"></label></form>
    <template #footer>
      <button type="button" class="ghost" @click="showTagForm = false">取消</button>
      <button type="submit" form="tag-create">创建标签</button>
    </template>
  </AppDialog>
  <AppDialog v-if="editingNode" title="重命名组织节点" kicker="ORGANIZATION / 组织树" @close="editingNode = null">
    <form id="node-edit" class="editor-form" @submit.prevent="saveNode"><label>节点名称<input v-model="editingNode.name" required maxlength="80"></label></form>
    <template #footer>
      <button type="button" class="ghost" @click="editingNode = null">取消</button>
      <button type="submit" form="node-edit">保存</button>
    </template>
  </AppDialog>
  <AppDialog v-if="editingTag" title="编辑设备标签" kicker="ORGANIZATION / 标签" @close="editingTag = null">
    <form id="tag-edit" class="editor-form" @submit.prevent="saveTag"><label>标签名称<input v-model="editingTag.name" required maxlength="50"></label><label>标签颜色<input v-model="editingTag.color" type="color"></label></form>
    <template #footer>
      <button type="button" class="ghost" @click="editingTag = null">取消</button>
      <button type="submit" form="tag-edit">保存</button>
    </template>
  </AppDialog>
  <section class="split">
    <article><header><span>ORGANIZATION TREE</span><h2>组织树</h2></header><ul v-if="data.nodes.length"><li v-for="node in data.nodes" :key="node.id" :style="{ paddingLeft: `${20 + Math.max(0, node.path.split('/').length - 2) * 18}px` }"><strong>{{ node.name }}</strong><small>{{ node.path }}</small><button type="button" class="ghost" @click="editingNode = { id: node.id, name: node.name }">重命名</button><button type="button" class="ghost danger" @click="removeNode(node)">删除</button></li></ul><EmptyState v-else title="尚未建立组织树" description="先添加学校根节点下的校区、年级、楼栋或班级。" /></article>
    <article><header><span>DEVICE TAGS</span><h2>设备标签</h2></header><ul v-if="data.tags.length"><li v-for="tag in data.tags" :key="tag.id"><i :style="{ background: tag.color }" /><strong>{{ tag.name }}</strong><button type="button" class="ghost" @click="editingTag = { id: tag.id, name: tag.name, color: tag.color }">编辑</button><button type="button" class="ghost danger" @click="removeTag(tag)">删除</button></li></ul><EmptyState v-else title="尚无设备标签" description="标签适合表达教室类型、硬件批次或临时维护范围。" /></article>
  </section>
  <ConfirmDialog
    v-if="pending"
    :title="pending.title"
    :description="pending.description"
    :confirm-text="pending.confirmText"
    danger
    :busy="confirmBusy"
    @close="pending = null"
    @confirm="runPending"
  />
</template>

<style scoped>

.editor-form { display: grid; gap: 14px; }.editor-form label { display: grid; gap: 7px; color: var(--ink-soft); font-size: 10px; }.editor-form input,.editor-form select { min-height: 44px; padding: 0 14px; border: 0; border-radius: 14px; background: var(--surface-2); color: var(--ink); }.editor-form input[type=color] { padding: 4px; width: 66px; }.split { display: grid; grid-template-columns: 1.25fr 1fr; gap: 14px; margin-top: 14px; }.split > article { min-height: 390px; padding: 24px; border-radius: var(--radius-md); background: var(--surface-1); }.split header span { color: var(--ink-muted); font-size: 9px; letter-spacing: .12em; }.split h2 { margin: 7px 0 20px; font-size: 21px; }ul { display: grid; gap: 7px; margin: 0; padding: 0; list-style: none; }li { min-height: 48px; display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-radius: var(--radius-row); background: var(--surface-2); }li small { margin-left: auto; color: var(--ink-muted); }li strong { flex: 1; }li i { width: 10px; height: 10px; border-radius: 50%; flex: none; }li button { flex: none; min-height: var(--control-h-sm); padding: 0 12px; border: 0; border-radius: var(--radius-control-sm); background: var(--ink); color: var(--canvas); cursor: pointer; font-size: 11px; }li button.ghost { background: var(--surface-1); color: var(--ink); }li button.danger { color: var(--bad); }li .inline { flex: 1; min-height: var(--control-h-sm); padding: 0 12px; border: 0; border-radius: var(--radius-control-sm); background: var(--surface-1); color: var(--ink); }li .swatch-input { flex: none; width: 54px; min-height: var(--control-h-sm); padding: 2px; border: 0; border-radius: var(--radius-control-sm); background: var(--surface-1); }@media (max-width: 800px) { .split { grid-template-columns: 1fr; } }
</style>