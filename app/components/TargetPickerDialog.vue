<script setup lang="ts">
/** 目标选择弹窗：取代原先常驻左侧的设备树，页面按需打开。 */
const emit = defineEmits<{ close: [] }>();
</script>

<template>
  <AppDialog title="选择目标" kicker="勾选要操作的设备" width="620px" @close="emit('close')">
    <TargetTree compact />
    <template #footer>
      <button type="button" class="solid" @click="emit('close')">完成</button>
    </template>
  </AppDialog>
</template>