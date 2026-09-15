<script setup lang="ts">
const props = withDefaults(defineProps<{ title: string; description: string; action?: string; to?: string }>(), { action: "", to: "" });
</script>

<template>
  <div class="empty">
    <span>∅</span><strong>{{ title }}</strong><p>{{ description }}</p>
    <slot name="action">
      <NuxtLink v-if="props.action && props.to" :to="props.to">{{ props.action }} →</NuxtLink>
    </slot>
  </div>
</template>

<style scoped>
.empty { min-height: 280px; display: grid; place-items: center; align-content: center; gap: 11px; padding: 30px; border-radius: var(--radius-md); background: var(--surface-1); text-align: center; }.empty > span { color: var(--ink-muted); font-size: 28px; }.empty strong { font-size: 17px; }.empty p { max-width: 560px; margin: 0; color: var(--ink-soft); font-size: 12px; line-height: 1.8; }.empty a { margin-top: 8px; text-decoration: none; font-size: 12px; }.empty :deep(button) { min-height: 44px; padding: 0 18px; border: 0; border-radius: 14px; background: var(--ink); color: var(--canvas); cursor: pointer; }
</style>
