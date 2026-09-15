<script setup lang="ts">
type AuditEvent = { id:string;sequence:number;summary:string;action:string;actorType:string;actorId:string|null;targetType:string;targetId:string|null;createdAt:string;eventHash:string };
type AuditPage = { items: AuditEvent[]; nextCursor: number | null };
const { data } = await useFetch<AuditPage>("/api/v1/admin/audit", { default: () => ({ items: [] as AuditEvent[], nextCursor: null }) });
const events = ref<AuditEvent[]>([...(data.value?.items ?? [])]);
const nextCursor = ref<number | null>(data.value?.nextCursor ?? null);
const loading = ref(false);
watch(data, (page) => { events.value = [...(page?.items ?? [])]; nextCursor.value = page?.nextCursor ?? null; });
async function loadMore() {
  if (nextCursor.value === null || loading.value) return;
  loading.value = true;
  try {
    const page = await $fetch<AuditPage>("/api/v1/admin/audit", { query: { cursor: nextCursor.value } });
    events.value.push(...page.items);
    nextCursor.value = page.nextCursor;
  } finally { loading.value = false; }
}
</script>

<template>
  <PageHeading kicker="AUDIT TRAIL / 审计轨迹" title="审计" description="记录谁在何时对哪些目标做了什么，以及服务端和设备的最终结果。敏感值与设备私钥绝不写入日志。" />
  <section v-if="events.length" class="timeline"><article v-for="event in events" :key="event.id"><span>{{ String(event.sequence).padStart(5,'0') }}</span><div><strong>{{ event.summary }}</strong><small>{{ event.action }} · {{ event.actorType }} / {{ event.actorId || 'system' }} · {{ event.targetType }}</small></div><time>{{ event.createdAt }}</time><code>{{ event.eventHash.slice(0,12) }}</code></article></section>
  <EmptyState v-else title="尚无审计事件" description="登录、接入、权限、策略发布、配置回滚和任务执行后，事件会形成可验证时间线。" />
  <button v-if="nextCursor !== null" class="load-more" type="button" :disabled="loading" @click="loadMore">{{ loading ? '加载中…' : '加载更早的事件' }}</button>
</template>

<style scoped>
.timeline{display:grid;gap:8px;margin-top:14px}.timeline article{display:grid;grid-template-columns:60px 1fr auto 100px;align-items:center;gap:14px;padding:17px;border-radius:var(--radius-row);background:var(--surface-1)}.timeline>article:nth-child(even){background:var(--surface-2)}.timeline article>span,.timeline small,.timeline time,.timeline code{color:var(--ink-muted);font-size:9px}.timeline div{display:grid;gap:5px}.timeline code{text-align:right}.load-more{margin-top:14px;min-height:44px;padding:0 20px;border:0;border-radius:14px;background:var(--surface-2);color:var(--ink)}.load-more:disabled{opacity:.6}@media(max-width:700px){.timeline article{grid-template-columns:45px 1fr}.timeline time,.timeline code{grid-column:2}}
</style>