<script setup lang="ts">
import { CONFIG_KIND_LABELS } from "#shared/classisland-config";
// labelOf 与 POLICY_SECTION_LABELS 来自 app/utils/labels.ts，由 Nuxt 自动导入。

type Reference = { section: string; configurationId: string; name: string | null; kind: string | null; revision: number | null };
type Payload = {
  id: string; revision: number; name: string; mode: "replace" | "append"; documentHash: string;
  baseRevision: number | null; createdAt: string; createdByName: string | null;
  document: Record<string, unknown>; references: Reference[]; locks: string[];
  scope: { assignmentId: string; scopeType: string; scopeId: string | null; scopeName: string; priority: number } | null;
};

const props = defineProps<{ revisionId: string }>();
const emit = defineEmits<{ close: [] }>();
const toast = useToast();
const data = ref<Payload | null>(null);
const loading = ref(true);

const scopeLabels: Record<string, string> = { school: "全校", organization: "组织", tag: "标签", device: "设备" };
const sections = computed(() => Object.keys(data.value?.document ?? {}));
function referenceFor(section: string) { return data.value?.references.find((item) => item.section === section) ?? null; }
const pretty = computed(() => JSON.stringify(data.value?.document ?? {}, null, 2));

onMounted(async () => {
  try {
    data.value = await $fetch<Payload>(`/api/v1/admin/policies/${props.revisionId}`);
  } catch (error) {
    toast.err((error as { data?: { message?: string } })?.data?.message ?? "读取策略详情失败。");
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <AppDialog :title="data ? `第 ${data.revision} 版 · ${data.name}` : '策略详情'" kicker="这一版策略的内容" width="760px" @close="emit('close')">
    <p v-if="loading" class="muted">加载中…</p>
    <template v-else-if="data">
      <dl class="summary">
        <div><dt>挂在哪</dt><dd>{{ data.scope ? `${scopeLabels[data.scope.scopeType] ?? data.scope.scopeType} · ${data.scope.scopeName}` : "未生效" }}</dd></div>
        <div><dt>写法</dt><dd>{{ data.mode === "append" ? "追加覆盖" : "整份替换" }}</dd></div>
        <div><dt>优先级</dt><dd>{{ data.scope?.priority ?? "—" }}</dd></div>
        <div><dt>基于</dt><dd>{{ data.baseRevision ? `第 ${data.baseRevision} 版` : "无" }}</dd></div>
        <div><dt>谁发的</dt><dd>{{ data.createdByName ?? "系统" }}</dd></div>
        <div><dt>时间</dt><dd>{{ timeLabel(data.createdAt) }}</dd></div>
      </dl>
      <article v-if="sections.length" class="block">
        <h3>管到哪些内容 <small>{{ sections.length }} 节</small></h3>
        <ul>
          <li v-for="section in sections" :key="section">
            <span class="name">{{ labelOf(POLICY_SECTION_LABELS, section) }}</span>
            <small v-if="referenceFor(section)" class="ref">
              引用配置库里的：{{ referenceFor(section)!.name ?? "配置已删除或没有修订" }}<template v-if="referenceFor(section)!.kind"> · {{ CONFIG_KIND_LABELS[referenceFor(section)!.kind!] ?? referenceFor(section)!.kind }}</template><template v-if="referenceFor(section)!.revision !== null"> · 第 {{ referenceFor(section)!.revision }} 版</template>
            </small>
            <small v-else class="ref">写死在这一版里</small>
          </li>
        </ul>
      </article>
      <p v-else class="muted">这一版没有内容（空文档）。</p>
      <article class="block">
        <h3>锁定路径 <small>{{ data.locks.length }}</small></h3>
        <div v-if="data.locks.length" class="chips"><code v-for="pointer in data.locks" :key="pointer">{{ pointer }}</code></div>
        <p v-else class="pad muted">没有锁定任何路径。</p>
      </article>
      <article class="block">
        <h3>原文 <small>{{ data.documentHash.slice(0, 12) }}</small></h3>
        <pre>{{ pretty }}</pre>
      </article>
    </template>
    <p v-else class="muted">读不到这一版策略。</p>
    <template #footer>
      <button type="button" class="ghost" @click="emit('close')">关闭</button>
    </template>
  </AppDialog>
</template>

<style scoped>
.summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(118px, 1fr)); gap: 0; margin: 0 0 18px; border-top: 1px solid var(--line-soft); }
.summary div { padding: 14px 16px; border-bottom: 1px solid var(--line-soft); }
.summary dt { color: var(--ink-muted); font-size: 10px; letter-spacing: 1px; }
.summary dd { margin: 8px 0 0; font-size: 14px; font-weight: 600; overflow-wrap: anywhere; }
.block { border: 1px solid var(--line-soft); background: var(--surface-1); margin-top: 14px; }
h3 { display: flex; align-items: baseline; gap: 10px; margin: 0; padding: 16px 18px; border-bottom: 1px solid var(--line-strong); font-size: 14px; font-weight: 600; }
h3 small { color: var(--ink-muted); font-size: 10px; font-weight: 400; letter-spacing: 1px; font-family: ui-monospace, monospace; }
ul { margin: 0; padding: 0; list-style: none; }
li { display: grid; gap: 6px; padding: 14px 18px; border-bottom: 1px solid var(--line-soft); }
li:last-child { border-bottom: 0; }
.name { font-size: 13px; }
.ref { color: var(--ink-muted); font-size: 11px; }
.chips { display: flex; flex-wrap: wrap; gap: 8px; padding: 16px 18px; }
.chips code { padding: 5px 10px; border: 1px solid var(--line); font-family: ui-monospace, monospace; font-size: 11px; }
.pad { padding: 16px 18px; }
pre { margin: 0; padding: 16px 18px; overflow: auto; max-height: 320px; font-family: ui-monospace, monospace; font-size: 12px; line-height: 1.7; }
.muted { margin: 0; }
</style>
