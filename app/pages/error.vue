<script setup lang="ts">
const route = useRoute();
const message = (route.query.error as string) || "这个页面不存在，或者暂时打不开。";
</script>

<template>
  <PageHeading kicker="出错了" title="打不开这个页面" />
  <EmptyState title="操作没有完成">
    <template #action>
      <div class="recover">
        <p class="muted">{{ message }}</p>
        <NuxtLink to="/">返回总览 <i class="arrow">→</i></NuxtLink>
      </div>
    </template>
  </EmptyState>
</template>

<style scoped>
.recover { display: grid; justify-items: center; gap: 18px; }
.recover p { margin: 0; max-width: 460px; }
.recover a { padding-bottom: 6px; border-bottom: 1px solid var(--line-strong); color: var(--ink-soft); font-size: 12px; text-decoration: none; transition: color var(--t-mid) var(--ease-enter), border-color var(--t-mid) var(--ease-enter); }
.recover a:hover { border-color: var(--accent); color: var(--accent); }
</style>