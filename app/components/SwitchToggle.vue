<script setup lang="ts">
// 贡献者：威廉
const props = defineProps<{ label?: string; hint?: string; disabled?: boolean }>();
const model = defineModel<boolean>({ required: true });
</script>

<template>
  <label class="toggle" :data-disabled="props.disabled ? 'true' : 'false'">
    <span class="text">
      <span class="label"><slot>{{ props.label }}</slot></span>
      <small v-if="props.hint">{{ props.hint }}</small>
    </span>
    <input v-model="model" type="checkbox" :disabled="props.disabled">
    <span class="track" aria-hidden="true"><span class="knob" /></span>
  </label>
</template>

<style scoped>
/* RhineLab 开关：50x24 方形轨道，olive 激活，16px 方形 knob，300ms 过渡。 */
.toggle{position:relative;display:flex;align-items:center;justify-content:space-between;gap:16px;cursor:pointer}
.toggle[data-disabled="true"]{cursor:not-allowed}
.text{display:grid;gap:3px}
.label{font-size:12px;line-height:1.4}
small{color:var(--ink-muted);font-size:10px;line-height:1.4}
input{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}
.track{position:relative;flex:none;width:50px;height:24px;background:var(--surface-3);transition:background 300ms var(--ease-enter)}
.knob{position:absolute;left:4px;top:4px;width:16px;height:16px;background:var(--accent-ink);transition:transform 300ms var(--ease-enter)}
input:checked + .track{background:var(--good)}
input:checked + .track .knob{transform:translateX(26px)}
input:focus-visible + .track{outline:2px solid #a67d48;outline-offset:5px}
input:disabled + .track{opacity:.45}
</style>
