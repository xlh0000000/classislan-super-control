<script setup lang="ts">
defineProps<{
  label: string;
  value: string | number;
  note: string;
  tone?: "normal" | "good" | "warning" | "critical";
}>();
</script>

<template>
  <article class="metric" :data-tone="tone || 'normal'">
    <div><span>{{ label }}</span><i /></div>
    <strong>{{ value }}</strong>
    <p>{{ note }}</p>
  </article>
</template>

<style scoped>
.metric { min-height: 162px; padding: 21px; border-radius: var(--radius-md); background: var(--surface-1); }
.metric > div { display: flex; align-items: center; justify-content: space-between; }
.metric span { color: var(--ink-muted); font-size: 10px; letter-spacing: .08em; }
.metric i { width: 9px; height: 9px; border-radius: 50%; background: var(--accent); }
.metric[data-tone="good"] i { background: var(--good); }.metric[data-tone="warning"] i { background: var(--warning); }.metric[data-tone="critical"] i { background: var(--critical); }
.metric strong { display: block; margin-top: 22px; font-size: clamp(32px, 4vw, 52px); font-variant-numeric: tabular-nums; letter-spacing: -.04em; }
.metric p { margin: 10px 0 0; color: var(--ink-soft); font-size: 11px; line-height: 1.6; }
</style>
