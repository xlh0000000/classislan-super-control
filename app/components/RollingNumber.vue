<script setup lang="ts">
// 贡献者：威廉
// RhineLab 式滚动数字：每位一列、0-9 纵向排布，460ms 平移到目标位。
const props = withDefaults(defineProps<{ value: string | number; duration?: number }>(), { duration: 460 });
const display = computed(() => String(props.value));
</script>

<template>
  <span class="roll" :aria-label="display">
    <span v-for="(ch, i) in display" :key="i" class="col">
      <span v-if="/\d/.test(ch)" class="strip" :style="{ transform: `translateY(calc(${Number(ch) * -10}% ))`, transitionDuration: `${duration}ms` }">
        <i v-for="d in 10" :key="d">{{ d - 1 }}</i>
      </span>
      <template v-else>{{ ch }}</template>
    </span>
  </span>
</template>

<style scoped>
.roll { display: inline-flex; font-variant-numeric: tabular-nums; line-height: 1; }
.col { display: inline-block; height: 1em; overflow: hidden; vertical-align: bottom; }
.strip { display: grid; transition-property: transform; transition-timing-function: cubic-bezier(0.22, 1, 0.36, 1); will-change: transform; }
.strip i { display: block; height: 1em; font-style: normal; text-align: center; }
</style>
