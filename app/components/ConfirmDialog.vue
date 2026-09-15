<script setup lang="ts">
const props = defineProps<{ title: string; description: string; confirmText?: string; danger?: boolean; busy?: boolean }>();
const emit = defineEmits<{ close: []; confirm: [] }>();
</script>

<template>
  <AppDialog :title="props.title" kicker="CONFIRM / 二次确认" width="440px" @close="emit('close')">
    <p class="text">{{ props.description }}</p>
    <template #footer>
      <button type="button" class="ghost" @click="emit('close')">取消</button>
      <button
        type="button"
        :disabled="props.busy"
        :class="{ danger: props.danger }"
        @click="emit('confirm')"
      >{{ props.busy ? "处理中…" : props.confirmText ?? "确认" }}</button>
    </template>
  </AppDialog>
</template>

<style scoped>
.text { margin: 0; color: var(--ink-soft); font-size: 13px; line-height: 1.7; }
</style>