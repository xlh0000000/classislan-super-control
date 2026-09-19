<script setup lang="ts">
// 贡献者：威廉
// RhineLab 详情页标题结构：微标签行（左标签 / 右动作）+ 大标题 + 2px 深色分隔线。
defineProps<{ kicker?: string; title: string }>();
</script>

<template>
  <header class="page-heading">
    <div class="head-top">
      <span class="kicker">{{ kicker }}</span>
      <div class="actions"><slot /></div>
    </div>
    <h1>{{ title }}</h1>
    <i class="rule" aria-hidden="true" />
  </header>
</template>

<style scoped>
.page-heading { margin-bottom: 30px; }
.head-top { display: flex; align-items: center; justify-content: space-between; gap: 24px; }
.kicker { color: var(--ink-muted); font-size: 11px; letter-spacing: 1.4px; }
.page-heading h1 { margin: 20px 0 0; font-size: clamp(30px, 3.4vw, 40px); font-weight: 600; letter-spacing: -1.1px; }
.rule { display: block; height: 2px; margin-top: 26px; background: var(--ink); }

/* 标题栏动作默认是文字按钮，主操作加 .solid。 */
.actions { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.actions :deep(a),
.actions :deep(button) {
  min-height: var(--control-h-sm);
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 0 10px;
  border: 0;
  background: transparent;
  color: var(--ink-soft);
  font-size: 12px;
  letter-spacing: 0.5px;
  text-decoration: none;
  cursor: pointer;
  transition: color var(--t-mid) var(--ease-enter), background var(--t-mid) var(--ease-enter);
}
.actions :deep(a:hover),
.actions :deep(button:hover:not(:disabled)) { background: transparent; color: var(--accent); }
.actions :deep(.solid) {
  min-height: var(--control-h-sm);
  padding: 0 16px;
  background: var(--fill);
  color: var(--fill-ink);
  font-size: 12px;
  letter-spacing: 0.5px;
}
.actions :deep(.solid:hover) { background: var(--fill-hover); color: var(--fill-ink); }
.actions :deep(button:disabled) { opacity: 0.45; cursor: not-allowed; }

@media (max-width: 760px) {
  .head-top { flex-direction: column; align-items: flex-start; gap: 14px; }
  .actions { margin-left: -10px; }
}
</style>