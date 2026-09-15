<script setup lang="ts">
import { CONFIG_KIND_LABELS } from "#shared/classisland-config";
import { configKindEntries, configKindEntry } from "#shared/configuration-kinds";

type ConfigRow = { configurationId: string; kind: string; name: string; revision: number; createdAt: string };
type Revision = { id: string; revision: number; name: string; documentJson: string; documentHash: string; createdBy: string | null; createdAt: string };
/** 传 kind 就是某一类型的专用页，不传就是配置库总览。 */
const props = defineProps<{ kind?: string }>();
const entry = computed(() => (props.kind ? configKindEntry(props.kind) : null));
const title = computed(() => (props.kind ? kindLabel(props.kind) : "配置库"));
const { data, refresh } = await useFetch<ConfigRow[]>("/api/v1/admin/configurations", { default: () => [] });
const rows = computed(() => (props.kind ? (data.value ?? []).filter((item) => item.kind === props.kind) : data.value ?? []));

const showEditor = ref(false); const fileInput = ref<HTMLInputElement>();
const busy = ref(false);
const rolling = ref(false);
const form = reactive({ name: "", kind: "profile", document: "{}" });
const kinds = configKindEntries.map((item) => [item.id, CONFIG_KIND_LABELS[item.id] ?? item.id]);
const selected = ref<ConfigRow | null>(null);
const revisions = ref<Revision[]>([]);
const fromRev = ref<number | null>(null); const toRev = ref<number | null>(null);
const diff = ref<Record<string, unknown> | null>(null);
const loading = ref(false);
const deployTarget = ref<ConfigRow | null>(null);
const editTarget = ref<ConfigRow | null>(null);
const pendingRollback = ref<{ revision: number; name: string } | null>(null);
const toast = useToast();

function kindLabel(value: string) { return CONFIG_KIND_LABELS[value] ?? value; }
function onDeployed() { void refresh(); }
function onSaved() { void refresh(); }

function openCreate() {
  form.name = ""; form.kind = props.kind ?? "profile"; form.document = "{}";
  showEditor.value = true;
}

/** 先建配置，再交给可视化编辑器搭建内容：新建不必先手写 JSON。 */
async function create() {
  const name = form.name.trim();
  if (!name) { toast.err("请填写配置名称。"); return; }
  let document: Record<string, unknown>;
  try { document = JSON.parse(form.document) as Record<string, unknown>; }
  catch { toast.err("导入的内容不是有效的 JSON 文档。"); return; }
  busy.value = true;
  try {
    const created = await $fetch<{ configurationId: string }>("/api/v1/admin/configurations", {
      method: "POST", headers: { origin: location.origin }, body: { name, kind: form.kind, document },
    });
    showEditor.value = false;
    await refresh();
    const row = (data.value ?? []).find((item) => item.configurationId === created.configurationId);
    editTarget.value = row ?? { configurationId: created.configurationId, kind: form.kind, name, revision: 1, createdAt: "" };
    toast.ok(`已创建「${name}」。`);
  } catch (err) {
    toast.err((err as { data?: { message?: string } })?.data?.message ?? "创建失败，请确认导入内容的结构有效。");
  } finally {
    busy.value = false;
  }
}
async function importFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  try {
    form.document = JSON.stringify(JSON.parse(await file.text()), null, 2);
    if (!form.name.trim()) form.name = file.name.replace(/\.json$/i, "");
    toast.ok("已读取文件内容。");
  } catch {
    toast.err("导入失败：文件不是有效的 JSON。");
  }
}
async function open(config: ConfigRow) {
  diff.value = null; loading.value = true; selected.value = config;
  try {
    revisions.value = await $fetch<Revision[]>(`/api/v1/admin/configurations/${config.configurationId}/history`);
    const sorted = [...revisions.value].sort((a, b) => b.revision - a.revision);
    toRev.value = sorted[0]?.revision ?? null;
    fromRev.value = sorted[1]?.revision ?? sorted[0]?.revision ?? null;
  } catch (err) { toast.err((err as { data?: { message?: string } })?.data?.message ?? "加载修订历史失败。"); }
  finally { loading.value = false; }
}
async function loadDiff() {
  if (!selected.value || fromRev.value === null || toRev.value === null) return;
  loading.value = true;
  try {
    const result = await $fetch<{ changes: Record<string, unknown> }>(`/api/v1/admin/configurations/${selected.value.configurationId}/diff`, { query: { from: fromRev.value, to: toRev.value } });
    diff.value = result.changes;
  } catch (err) { toast.err((err as { data?: { message?: string } })?.data?.message ?? "计算差异失败。"); }
  finally { loading.value = false; }
}
function rollback(revision: number) {
  if (!selected.value) return;
  pendingRollback.value = { revision, name: selected.value.name };
}
async function confirmRollback() {
  const target = pendingRollback.value;
  if (!target || !selected.value) return;
  rolling.value = true;
  try {
    await $fetch(`/api/v1/admin/configurations/${selected.value.configurationId}/rollback`, { method: "POST", headers: { origin: location.origin }, body: { revision: target.revision } });
    toast.ok(`已回滚到 R${target.revision}，生成新修订。`);
    await open(selected.value);
    await refresh();
  } catch (err) { toast.err((err as { data?: { message?: string } })?.data?.message ?? "回滚失败。"); }
  finally { rolling.value = false; pendingRollback.value = null; }
}
</script>

<template>
  <PageHeading :kicker="entry?.kicker ?? 'CONFIGURATION LIBRARY / 配置资源'" :title="title" :description="entry?.description ?? '新建后直接进可视化编辑器搭建内容：档案与组件布局是结构化控件，自动化与插件设置走 JSON。下发时作用于已选目标。'">
    <NuxtLink v-if="!entry" to="/timetable">编辑课表</NuxtLink>
    <button type="button" @click="openCreate">{{ entry ? `＋ 新建${title}` : "＋ 新建配置" }}</button>
  </PageHeading>
  <AppDialog v-if="showEditor" title="新建配置" kicker="NEW CONFIGURATION / 新建配置" width="640px" @close="showEditor = false">
    <form id="config-editor" class="editor" @submit.prevent="create">
      <label>名称<input v-model="form.name" maxlength="100" placeholder="例如：标准机房档案"></label>
      <label>类型<select v-model="form.kind"><option v-for="kind in kinds" :key="kind[0]" :value="kind[0]">{{ kind[1] }}</option></select></label>
      <label class="wide">从 JSON 文件导入（可选）<input ref="fileInput" type="file" accept="application/json,.json" @change="importFile"></label>
      <p class="static">创建后进入可视化编辑器，可随时保存为新的修订。</p>
    </form>
    <template #footer>
      <button type="button" class="ghost" @click="showEditor = false">取消</button>
      <button type="submit" form="config-editor" :disabled="busy || !form.name.trim()">{{ busy ? "创建中…" : "创建并编辑" }}</button>
    </template>
  </AppDialog>
  <section v-if="!entry" class="kind-grid"><article v-for="kind in kinds" :key="kind[0]"><span>CONFIG TYPE</span><strong>{{ kind[1] }}</strong><small>{{ data.filter(item => item.kind === kind[0]).length }} 个模板</small></article></section>
  <section v-if="rows.length" class="list"><article v-for="item in rows" :key="item.configurationId" :class="{ selected: selected?.configurationId === item.configurationId }"><div><strong>{{ item.name }}</strong><small>{{ kindLabel(item.kind) }} · R{{ item.revision }}</small></div><time>{{ item.createdAt }}</time><div class="row-actions"><button type="button" @click="editTarget = item">编辑</button><button type="button" @click="open(item)">历史</button><button type="button" @click="deployTarget = item">下发</button></div></article></section><EmptyState v-else :title="entry ? `还没有${title}配置` : '配置库为空'" :description="entry ? `点「＋ 新建${title}」创建，再在可视化编辑器里搭建内容。` : '点「＋ 新建配置」创建，再在可视化编辑器里搭建内容。'" />
  <AppDialog v-if="selected" :title="selected.name" kicker="REVISION HISTORY / 修订与回滚" width="840px" @close="selected = null">
    <div v-if="loading" class="muted">加载中…</div>
    <template v-else>
      <div class="diff-controls"><label>起始修订<select v-model.number="fromRev"><option v-for="rev in revisions" :key="rev.id" :value="rev.revision">R{{ rev.revision }}</option></select></label><label>目标修订<select v-model.number="toRev"><option v-for="rev in revisions" :key="rev.id" :value="rev.revision">R{{ rev.revision }}</option></select></label><button type="button" @click="loadDiff">比较差异</button></div>
      <pre v-if="diff" class="diff">{{ JSON.stringify(diff, null, 2) }}</pre>
      <ul class="history"><li v-for="rev in revisions" :key="rev.id"><div><strong>R{{ rev.revision }} · {{ rev.name }}</strong><small>{{ rev.createdAt }} · {{ rev.documentHash.slice(0, 12) }}</small></div><button type="button" @click="rollback(rev.revision)">回滚到此修订</button></li></ul>
    </template>
  </AppDialog>
  <VisualConfigEditor v-if="editTarget" :configuration-id="editTarget.configurationId" :kind="editTarget.kind" :name="editTarget.name" :revision="editTarget.revision" @saved="onSaved" @close="editTarget = null" />
  <DeployTargets v-if="deployTarget" :configuration-id="deployTarget.configurationId" :configuration-name="deployTarget.name" :revision="deployTarget.revision" @deployed="onDeployed" @close="deployTarget = null" />
  <ConfirmDialog
    v-if="pendingRollback"
    :title="`回滚到 R${pendingRollback.revision}`"
    :description="`「${pendingRollback.name}」会以 R${pendingRollback.revision} 的内容生成一个新修订，历史修订不会被删除。`"
    confirm-text="回滚"
    :busy="rolling"
    @close="pendingRollback = null"
    @confirm="confirmRollback"
  />
</template>

<style scoped>

.editor { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 14px; padding: 22px; border-radius: var(--radius-md); background: var(--surface-1); }.editor label { display: grid; gap: 7px; font-size: 10px; color: var(--ink-soft); }.editor .wide { grid-column: 1/-1; }.editor input,.editor select,.editor textarea { padding: 12px; border: 0; border-radius: 14px; background: var(--surface-2); color: var(--ink); }.editor button { min-height: 44px; border: 0; border-radius: 14px; background: var(--ink); color: var(--canvas); }.editor .static { grid-column: 1/-1; margin: 0; color: var(--ink-muted); font-size: 10px; }.editor input[type=file] { padding: 10px 12px; }.kind-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin: 14px 0; }.kind-grid article { min-height: 130px; display: grid; align-content: end; gap: 7px; padding: 19px; border-radius: var(--radius-md); background: var(--surface-2); }.kind-grid span,.kind-grid small,.list small,.list time { color: var(--ink-muted); font-size: 8px; }.list { display: grid; gap: 8px; }.list article { display: grid; grid-template-columns: 1fr auto auto; align-items: center; gap: 14px; padding: 17px; border-radius: var(--radius-row); background: var(--surface-1); }.list article.selected { outline: 2px solid var(--ink); }.list div { display: grid; gap: 5px; }.row-actions { display: flex; gap: 6px; }.list button,.list a,.detail header button,.diff-controls button,.history button { min-height: 44px; display: inline-flex; align-items: center; padding: 0 16px; border: 0; border-radius: 14px; background: var(--surface-2); color: var(--ink); cursor: pointer; text-decoration: none; }.detail { margin-top: 16px; padding: 24px; border-radius: var(--radius-md); background: var(--surface-1); }.detail header { display: flex; justify-content: space-between; align-items: start; }.detail header span { color: var(--ink-muted); font-size: 9px; letter-spacing: .12em; }.detail h2 { margin: 7px 0 0; font-size: 21px; }.diff-controls { display: flex; align-items: end; gap: 12px; margin: 18px 0; flex-wrap: wrap; }.diff-controls label { display: grid; gap: 7px; font-size: 10px; color: var(--ink-soft); }.diff-controls select { min-height: 44px; padding: 0 12px; border: 0; border-radius: 14px; background: var(--surface-2); color: var(--ink); }.diff { max-height: 320px; overflow: auto; padding: 18px; border-radius: 16px; background: var(--surface-2); font-size: 11px; }.history { display: grid; gap: 8px; margin: 18px 0 0; padding: 0; list-style: none; }.history li { display: flex; justify-content: space-between; align-items: center; gap: 14px; padding: 14px; border-radius: 14px; background: var(--surface-2); }.history div { display: grid; gap: 4px; }.history small { color: var(--ink-muted); font-size: 9px; }@media(max-width:850px){.kind-grid{grid-template-columns:1fr 1fr}.editor{grid-template-columns:1fr}.editor .wide{grid-column:auto}.list article{grid-template-columns:1fr auto}.list article time{display:none}.row-actions{flex-wrap:wrap}}
</style>