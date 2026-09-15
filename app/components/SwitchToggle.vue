<script setup lang="ts">
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
.toggle{position:relative;display:flex;align-items:center;justify-content:space-between;gap:16px;cursor:pointer}
.toggle[data-disabled="true"]{cursor:not-allowed}
.text{display:grid;gap:3px}
.label{font-size:12px;line-height:1.4}
small{color:var(--ink-muted);font-size:10px;line-height:1.4}
input{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}
.track{position:relative;flex:none;width:46px;height:26px;border-radius:999px;background:var(--surface-3);transition:background 160ms var(--ease-enter)}
.knob{position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:50%;background:var(--surface-1);box-shadow:0 2px 6px rgb(0 0 0/.22);transition:transform 160ms var(--ease-enter)}
input:checked + .track{background:var(--ink)}
input:checked + .track .knob{transform:translateX(20px)}
input:focus-visible + .track{outline:3px solid var(--accent);outline-offset:2px}
input:disabled + .track{opacity:.45}
</style>