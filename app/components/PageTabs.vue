<script setup lang="ts">
// 贡献者：威廉
// RhineLab .detail-tabs：编号 + 标签，配 2px 滑动指示条（180ms 位移）。
const props = defineProps<{ items: readonly { key: string; label: string }[]; modelValue: string }>();
const emit = defineEmits<{ "update:modelValue": [string] }>();

const bar = ref<HTMLElement | null>(null);
const indicator = ref<HTMLElement | null>(null);

function sync() {
  const target = bar.value?.querySelector<HTMLElement>('button[data-active="true"]');
  const line = indicator.value;
  if (!target || !line) return;
  line.style.transform = `translateX(${target.offsetLeft}px) scaleX(${target.offsetWidth})`;
}

function select(key: string) {
  emit("update:modelValue", key);
}

onMounted(() => {
  sync();
  window.addEventListener("resize", sync);
});
onBeforeUnmount(() => window.removeEventListener("resize", sync));
watch(() => props.modelValue, () => nextTick(sync));
</script>

<template>
  <div ref="bar" class="tabs" role="tablist">
    <button
      v-for="(item, index) in props.items"
      :key="item.key"
      type="button"
      role="tab"
      :aria-selected="item.key === props.modelValue"
      :data-active="item.key === props.modelValue ? 'true' : 'false'"
      @click="select(item.key)"
    >
      <i>{{ String(index + 1).padStart(2, "0") }}</i><span>{{ item.label }}</span>
    </button>
    <i ref="indicator" class="tab-indicator" aria-hidden="true" />
  </div>
</template>

<style scoped>
.tabs { margin-bottom: 26px; }
.tabs button > span { font-size: 15px; }
</style>