<script setup lang="ts">
import { LOCKUP_PATH } from "~/assets/brand/lockup";

/** 标志本体：侧栏方块与登录页都用它，颜色交给 currentColor 跟着主题走。 */
const { label = "ClassIsland Super Control" } = defineProps<{ label?: string }>();
</script>

<template>
  <svg class="lockup" viewBox="0 0 512 512" role="img" :aria-label="label" focusable="false">
    <path fill-rule="evenodd" :d="LOCKUP_PATH" />
  </svg>
</template>

<style scoped>
.lockup { display: block; width: 100%; height: auto; fill: currentColor; }
</style>
