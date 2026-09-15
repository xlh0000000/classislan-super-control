<script setup lang="ts">
defineProps<{ kicker: string; title: string; description?: string }>();
</script>

<template>
  <header class="page-heading">
    <div><span>{{ kicker }}</span><h1>{{ title }}</h1><p v-if="description">{{ description }}</p></div>
    <div class="actions"><slot /></div>
  </header>
</template>

<style scoped>
.page-heading { display: flex; align-items: flex-end; justify-content: space-between; gap: 24px; padding: 28px 30px 34px; border-radius: var(--radius-lg); background: var(--surface-2); }.page-heading span { color: var(--ink-muted); font-size: 9px; letter-spacing: .14em; }.page-heading h1 { margin: 16px 0 8px; font-size: clamp(32px, 5vw, 56px); letter-spacing: -.045em; }.page-heading p { max-width: 700px; margin: 0; color: var(--ink-soft); font-size: 13px; line-height: 1.75; }
.actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }.actions :deep(a), .actions :deep(button) { min-height: var(--control-h); display: inline-flex; align-items: center; padding: 0 16px; border: 0; border-radius: var(--radius-control); background: var(--ink); color: var(--canvas); text-decoration: none; cursor: pointer; }
/* 次要动作：标题栏里的轻量入口，避免一排全是深色主按钮。 */
.actions :deep(.ghost) { min-height: var(--control-h-sm); padding: 0 12px; border-radius: var(--radius-control-sm); background: var(--surface-1); color: var(--ink-soft); font-size: 11px; }.actions :deep(.ghost:hover) { background: var(--surface-3); color: var(--ink); }
@media (max-width: 700px) { .page-heading { align-items: flex-start; flex-direction: column; padding: 24px; } }
</style>