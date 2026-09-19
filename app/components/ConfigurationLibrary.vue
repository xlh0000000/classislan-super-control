<script setup lang="ts">
import { CONFIG_KIND_LABELS } from "#shared/classisland-config";
import { starterProfile, writeProfileDocument } from "#shared/classisland-profile";
import { configKindEntries, configKindEntry } from "#shared/configuration-kinds";

type ConfigRow = { configurationId: string; kind: string; name: string; currentRevision: number | null; revisionCreatedAt: string | null; updatedAt: string };
type Revision = { id: string; revision: number; name: string; documentJson: string; documentHash: string; createdBy: string | null; createdAt: string };
/** 传 kind 就是某一类型的专用页，不传就是配置库总览。 */
const props = defineProps<{ kind?: string }>();
const entry = computed(() => (props.kind ? configKindEntry(props.kind) : null));
const title = computed(() => (props.kind ? kindLabel(props.kind) : "配置库"));
/** 新建按钮跟着导航短名走，「新建档案与课表」这种念起来太累。 */
const newLabel = computed(() => (entry.value ? entry.value.nav : "配置"));
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
function fmt(iso: string | null) { return iso ? new Date(iso).toLocaleString() : "—"; }
function countOf(value: string) { return (data.value ?? []).filter((item) => item.kind === value).length; }
function onDeployed() { void refresh(); }
function onSaved() { void refresh(); }

/** 课表的内容在课表页排，其余类型就地用可视化编辑器改。 */
function edit(config: ConfigRow) {
  if (config.kind === "profile") { void navigateTo(`/timetable?config=${config.configurationId}`); return; }
  editTarget.value = config;
}

function openCreate() {
  form.name = ""; form.kind = props.kind ?? "profile"; form.document = "{}";
  showEditor.value = true;
}

/** 先建配置，再交给可视化编辑器搭建内容：新建不必先手写 JSON。 */
async function create() {
  const name = form.name.trim();
  if (!name) { toast.err("先填个名字。"); return; }
  let document: Record<string, unknown>;
  try { document = JSON.parse(form.document) as Record<string, unknown>; }
  catch { toast.err("导入的文件内容格式有误。"); return; }
  // 课表新建就是一份起始档案：默认作息 + ClassIsland 那套默认科目，省得先空着手去补科目。
  if (form.kind === "profile" && !Object.keys(document).length) document = writeProfileDocument(starterProfile(name));
  busy.value = true;
  try {
    const created = await $fetch<{ configurationId: string }>("/api/v1/admin/configurations", {
      method: "POST", headers: { origin: location.origin }, body: { name, kind: form.kind, document },
    });
    showEditor.value = false;
    await refresh();
    const row = (data.value ?? []).find((item) => item.configurationId === created.configurationId);
    const createdRow = row ?? { configurationId: created.configurationId, kind: form.kind, name, currentRevision: 1, revisionCreatedAt: null, updatedAt: "" };
    if (form.kind === "profile") await navigateTo(`/timetable?config=${createdRow.configurationId}`);
    else editTarget.value = createdRow;
    toast.ok(`已创建「${name}」。`);
  } catch (err) {
    toast.err((err as { data?: { message?: string } })?.data?.message ?? "创建失败，检查一下内容结构。");
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
    const parsed: unknown = JSON.parse(await file.text());
    // ClassIsland 的自动化配置文件是裸数组；配置库统一存成 { workflows: [...] }。
    if (Array.isArray(parsed)) {
      form.kind = "automation";
      form.document = JSON.stringify({ workflows: parsed }, null, 2);
    } else {
      form.document = JSON.stringify(parsed, null, 2);
    }
    if (!form.name.trim()) form.name = file.name.replace(/\.json$/i, "");
    toast.ok("文件读好了。");
  } catch {
    toast.err("这个文件的内容格式有误。");
  }
}
async function open(config: ConfigRow) {
  diff.value = null; loading.value = true; selected.value = config;
  try {
    revisions.value = await $fetch<Revision[]>(`/api/v1/admin/configurations/${config.configurationId}/history`);
    const sorted = [...revisions.value].sort((a, b) => b.revision - a.revision);
    toRev.value = sorted[0]?.revision ?? null;
    fromRev.value = sorted[1]?.revision ?? sorted[0]?.revision ?? null;
  } catch (err) { toast.err((err as { data?: { message?: string } })?.data?.message ?? "读不到修订历史。"); }
  finally { loading.value = false; }
}
async function loadDiff() {
  if (!selected.value || fromRev.value === null || toRev.value === null) return;
  loading.value = true;
  try {
    const result = await $fetch<{ changes: Record<string, unknown> }>(`/api/v1/admin/configurations/${selected.value.configurationId}/diff`, { query: { from: fromRev.value, to: toRev.value } });
    diff.value = result.changes;
  } catch (err) { toast.err((err as { data?: { message?: string } })?.data?.message ?? "算不出差异。"); }
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
    toast.ok(`已回滚到第 ${target.revision} 版，生成新修订。`);
    await open(selected.value);
    await refresh();
  } catch (err) { toast.err((err as { data?: { message?: string } })?.data?.message ?? "回滚失败。"); }
  finally { rolling.value = false; pendingRollback.value = null; }
}
</script>

<template>
  <PageHeading :kicker="entry?.kicker ?? '四类配置都放这里'" :title="title">
    <button type="button" class="solid" @click="openCreate">新建{{ newLabel }}</button>
  </PageHeading>

  <section v-if="!entry" class="kinds">
    <NuxtLink v-for="kind in configKindEntries" :key="kind.id" class="kind" :to="kind.page">
      <span class="micro">{{ kind.kicker }}</span>
      <strong>{{ kindLabel(kind.id) }}</strong>
      <span class="count">{{ countOf(kind.id) }} 个</span>
      <i class="arrow" aria-hidden="true">→</i>
    </NuxtLink>
  </section>

  <section v-if="rows.length" class="list">
    <article v-for="item in rows" :key="item.configurationId">
      <div class="row-main">
        <strong>{{ item.name }}</strong>
        <small>{{ kindLabel(item.kind) }} · {{ revisionLabel(item.currentRevision) }} · {{ fmt(item.revisionCreatedAt ?? item.updatedAt) }}</small>
      </div>
      <div class="row-actions">
        <button type="button" @click="edit(item)">编辑</button>
        <button v-if="item.kind === 'profile'" type="button" @click="editTarget = item">档案设置</button>
        <button type="button" @click="open(item)">修订</button>
        <button type="button" @click="deployTarget = item">下发</button>
      </div>
    </article>
  </section>
  <EmptyState v-else :title="entry ? `还没有${title}` : '配置库是空的'">
    <template #action>
      <button type="button" @click="openCreate">新建{{ newLabel }}</button>
    </template>
  </EmptyState>

  <AppDialog v-if="showEditor" title="新建配置" kicker="填名称、选类型" width="640px" @close="showEditor = false">
    <form id="config-editor" class="editor" @submit.prevent="create">
      <label class="field"><span>名称</span><input v-model="form.name" maxlength="100" placeholder="例如：标准机房档案"></label>
      <label class="field"><span>类型</span><select v-model="form.kind"><option v-for="kind in kinds" :key="kind[0]" :value="kind[0]">{{ kind[1] }}</option></select></label>
      <label class="field wide"><span>导入配置文件（可选）</span><input ref="fileInput" type="file" accept="application/json,.json" @change="importFile"></label>
    </form>
    <template #footer>
      <button type="button" class="ghost" @click="showEditor = false">取消</button>
      <button type="submit" form="config-editor" :disabled="busy || !form.name.trim()">{{ busy ? "创建中…" : "创建并编辑" }}</button>
    </template>
  </AppDialog>

  <AppDialog v-if="selected" :title="selected.name" kicker="修订历史" width="840px" @close="selected = null">
    <div v-if="loading" class="muted">加载中…</div>
    <template v-else>
      <div class="diff-controls toolbar">
        <label class="field"><span>起始修订</span><select v-model.number="fromRev"><option v-for="rev in revisions" :key="rev.id" :value="rev.revision">第 {{ rev.revision }} 版</option></select></label>
        <label class="field"><span>目标修订</span><select v-model.number="toRev"><option v-for="rev in revisions" :key="rev.id" :value="rev.revision">第 {{ rev.revision }} 版</option></select></label>
        <button type="button" @click="loadDiff">比较差异</button>
      </div>
      <pre v-if="diff" class="diff">{{ JSON.stringify(diff, null, 2) }}</pre>
      <ul class="list revisions">
        <li v-for="rev in revisions" :key="rev.id">
          <div class="row-main">
            <strong>第 {{ rev.revision }} 版 · {{ rev.name }}</strong>
            <small>{{ fmt(rev.createdAt) }} · {{ rev.documentHash.slice(0, 12) }}</small>
          </div>
          <div class="row-actions"><button type="button" @click="rollback(rev.revision)">回滚到这里</button></div>
        </li>
      </ul>
    </template>
  </AppDialog>
  <VisualConfigEditor v-if="editTarget" :configuration-id="editTarget.configurationId" :kind="editTarget.kind" :name="editTarget.name" :revision="editTarget.currentRevision ?? undefined" @saved="onSaved" @close="editTarget = null" />
  <DeployTargets v-if="deployTarget" :configuration-id="deployTarget.configurationId" :configuration-name="deployTarget.name" :revision="deployTarget.currentRevision ?? undefined" @deployed="onDeployed" @close="deployTarget = null" />
  <ConfirmDialog
    v-if="pendingRollback"
    :title="`回滚到第 ${pendingRollback.revision} 版`"
    :description="`「${pendingRollback.name}」会照第 ${pendingRollback.revision} 版重做一份新修订，旧的都留着。`"
    confirm-text="回滚"
    :busy="rolling"
    @close="pendingRollback = null"
    @confirm="confirmRollback"
  />
</template>

<style scoped>
.kinds { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 1px; margin-bottom: 34px; background: var(--line-soft); border: 1px solid var(--line-soft); }
.kind { position: relative; display: grid; align-content: end; gap: 10px; min-height: 148px; padding: 20px; background: var(--surface-1); color: inherit; text-decoration: none; transition: background var(--t-base) var(--ease-enter); }
.kind:hover { background: var(--accent-wash); }
.kind strong { font-size: 20px; font-weight: 600; letter-spacing: -0.4px; }
.kind .count { color: var(--ink-muted); font-size: 11px; letter-spacing: 0.8px; }
.kind .arrow { position: absolute; top: 20px; right: 20px; color: var(--ink-muted); font-style: normal; }

.editor { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
.editor .wide { grid-column: 1 / -1; }
.editor input, .editor select { width: 100%; }

.diff-controls { margin-bottom: 20px; }
.diff-controls .field { min-width: 130px; }
.diff { max-height: 300px; overflow: auto; margin: 0 0 20px; padding: 16px 18px; border: 1px solid var(--line-soft); background: var(--surface-2); font-family: ui-monospace, monospace; font-size: 11px; line-height: 1.7; }
.revisions { margin: 0; padding: 0; list-style: none; border-top-color: var(--line-strong); }
@media (max-width: 760px) { .editor { grid-template-columns: 1fr; } }
</style>