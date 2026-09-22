<script setup lang="ts">
// POLICY_SECTION_LABELS 与 labelOf 来自 app/utils/labels.ts，由 Nuxt 自动导入。
type HistoryRow = {
  id: string; revision: number; name: string; mode: "replace" | "append";
  priority: number | null; sections: string[]; locks: string[]; createdAt: string; createdByName: string | null;
  isCurrent: boolean; documentHash: string;
};

const props = defineProps<{ scopeType: string; scopeId: string | null; scopeName: string }>();
const emit = defineEmits<{ close: []; inspect: [revisionId: string] }>();
const toast = useToast();
const rows = ref<HistoryRow[]>([]);
const loading = ref(true);

onMounted(async () => {
  try {
    rows.value = await $fetch<HistoryRow[]>("/api/v1/admin/policies/history", {
      query: { scopeType: props.scopeType, scopeId: props.scopeId ?? "" },
    });
  } catch (error) {
    toast.err((error as { data?: { message?: string } })?.data?.message ?? "读取历史修订失败。");
  } finally {
    loading.value = false;
  }
});

/** 一次只开一层弹窗：去看某一版内容时先把这层收掉。 */
function inspect(revisionId: string) {
  emit("close");
  emit("inspect", revisionId);
}
</script>

<template>
  <AppDialog :title="`${scopeName}的历史修订`" kicker="按这一路挂过的版本" width="720px" @close="emit('close')">
    <p v-if="loading" class="muted">加载中…</p>
    <ul v-else-if="rows.length" class="list">
      <li v-for="row in rows" :key="row.id" class="clickable" @click="inspect(row.id)">
        <div class="row-main">
          <strong>第 {{ row.revision }} 版 · {{ row.name }}</strong>
          <small>{{ timeLabel(row.createdAt) }}<template v-if="row.priority !== null"> · 优先级 {{ row.priority }}</template><template v-if="row.mode === 'append'"> · 追加覆盖</template><template v-if="row.createdByName"> · {{ row.createdByName }}</template></small>
          <span class="chips"><code v-for="section in row.sections" :key="section">{{ labelOf(POLICY_SECTION_LABELS, section) }}</code><code v-if="!row.sections.length" class="none">空文档</code><code v-if="row.locks.length" class="lock">锁 {{ row.locks.length }} 处</code></span>
        </div>
        <span class="tag" :data-current="row.isCurrent">{{ row.isCurrent ? "生效中" : "已顶替" }}</span>
      </li>
    </ul>
    <p v-else class="muted">这一路还没有挂过策略。</p>
    <template #footer>
      <button type="button" class="ghost" @click="emit('close')">关闭</button>
    </template>
  </AppDialog>
</template>

<style scoped>
.list { margin: 0; padding: 0; list-style: none; border-top: 1px solid var(--line-soft); }
li { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 16px 18px; border-bottom: 1px solid var(--line-soft); }
li.clickable { cursor: pointer; transition: background var(--t-base) var(--ease-enter); }
li.clickable:hover { background: var(--accent-wash); }
.row-main { display: grid; gap: 7px; min-width: 0; }
.row-main strong { font-size: 14px; font-weight: 600; }
.row-main small { color: var(--ink-muted); font-size: 11px; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chips code { padding: 3px 8px; border: 1px solid var(--line); color: var(--ink-soft); font-size: 10px; }
.chips code.none, .chips code.lock { color: var(--ink-faint); border-style: dashed; }
.tag { flex: none; padding: 5px 10px; border: 1px solid var(--line); color: var(--ink-muted); font-size: 10px; letter-spacing: 0.6px; }
.tag[data-current="true"] { border-color: var(--accent); color: var(--accent); }
.muted { margin: 0; }
</style>
