<script setup lang="ts">
// 贡献者：威廉
// RhineLab .empty-results：大号占位符 + 一句结论 + 下划线文字按钮。
const props = withDefaults(defineProps<{ title: string; action?: string; to?: string }>(), { action: "", to: "" });
</script>

<template>
  <div class="empty fade-in">
    <span aria-hidden="true">∅</span>
    <strong>{{ title }}</strong>
    <slot name="action">
      <NuxtLink v-if="props.action && props.to" :to="props.to">{{ props.action }} <i class="arrow">→</i></NuxtLink>
    </slot>
  </div>
</template>

<style scoped>
.empty { min-height: 260px; display: grid; place-items: center; align-content: center; gap: 16px; padding: 34px; border: 1px solid var(--line-soft); background: var(--surface-1); text-align: center; }
.empty > span { color: #a39b8a; font-size: 44px; font-weight: 300; line-height: 1; }
.empty strong { font-size: 18px; font-weight: 400; letter-spacing: -0.2px; }
.empty a { margin-top: 4px; padding-bottom: 6px; border-bottom: 1px solid var(--line-strong); color: var(--ink-soft); font-size: 12px; text-decoration: none; transition: color var(--t-mid) var(--ease-enter), border-color var(--t-mid) var(--ease-enter); }
.empty a:hover { border-color: var(--accent); color: var(--accent); }
.empty :deep(button) { min-height: var(--control-h); padding: 0 18px; border: 0; background: var(--fill); color: var(--fill-ink); font-size: 11px; letter-spacing: 1px; }
.empty :deep(button:hover) { background: var(--fill-hover); }
</style>