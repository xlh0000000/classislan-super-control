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
  <PageHeading kicker="谁做了什么" title="操作记录" />
  <section v-if="events.length" class="list timeline">
    <article v-for="event in events" :key="event.id">
      <span class="seq">{{ String(event.sequence).padStart(5, '0') }}</span>
      <div class="row-main">
        <strong>{{ event.summary }}</strong>
        <small>{{ event.action }} · {{ event.actorType }} / {{ event.actorId || 'system' }} · {{ event.targetType }}</small>
      </div>
      <time>{{ event.createdAt }}</time>
      <code>{{ event.eventHash.slice(0, 12) }}</code>
    </article>
  </section>
  <EmptyState v-else title="还没有记录" />
  <button v-if="nextCursor !== null" class="more" type="button" :disabled="loading" @click="loadMore">{{ loading ? '加载中…' : '加载更早的记录' }}</button>
</template>

<style scoped>
.timeline article { display: grid; grid-template-columns: 56px minmax(0, 1fr) auto 108px; gap: 18px; }
.seq, .timeline time, .timeline code { color: var(--ink-faint); font-size: 10px; letter-spacing: 0.8px; font-variant-numeric: tabular-nums; }
.timeline code { text-align: right; font-family: ui-monospace, monospace; }
.more { margin-top: 18px; min-height: var(--control-h); }
@media (max-width: 760px) {
  .timeline article { grid-template-columns: 46px minmax(0, 1fr); }
  .timeline time, .timeline code { grid-column: 2; text-align: left; }
}
</style>