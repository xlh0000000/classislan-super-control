<script setup lang="ts">
// 贡献者：威廉
defineProps<{
  label: string;
  value: string | number;
  note?: string;
  tone?: "normal" | "good" | "warning" | "critical";
}>();
</script>

<template>
  <article class="metric rise" :data-tone="tone || 'normal'">
    <div class="top"><span>{{ label }}</span><i class="dot" /></div>
    <strong><RollingNumber :value="value" /></strong>
    <small v-if="note">{{ note }}</small>
  </article>
</template>

<style scoped>
/* 指标块：RhineLab .archive-counter 的微标签 + 大号数字，靠发丝线分组。 */
.metric {
  display: flex;
  flex-direction: column;
  min-height: 146px;
  padding: 22px 24px;
  border: 1px solid var(--line-soft);
  background: var(--surface-1);
}
.top { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.metric span { color: var(--ink-muted); font-size: 10px; letter-spacing: 1.2px; }
.metric i { width: 7px; height: 7px; border-radius: 0; background: var(--ink-faint); }
.metric[data-tone="good"] i { background: var(--good); }
.metric[data-tone="warning"] i { background: var(--warning); }
.metric[data-tone="critical"] i { background: var(--critical); }
.metric strong { margin-top: auto; font-size: clamp(32px, 3.4vw, 44px); font-weight: 600; letter-spacing: -1.2px; font-variant-numeric: tabular-nums; }
.metric small { margin-top: 8px; color: var(--ink-faint); font-size: 10px; letter-spacing: 0.5px; }
</style>