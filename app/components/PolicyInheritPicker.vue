<script setup lang="ts">
// 逐页沿用：选一份历史修订，把它在本页对应的那部分内容接过来，并显式列出接过来的到底是什么。
type Option = { id: string; label: string; hint?: string };
/** 一条已沿用的具体内容：value 是人话，json 是控件表达不了的原文。 */
type Row = { label: string; value: string; json?: string };

const props = withDefaults(
  defineProps<{ modelValue: string; options: Option[]; rows?: Row[]; notice?: string }>(),
  { rows: () => [], notice: "" },
);
const emit = defineEmits<{ "update:modelValue": [string] }>();

function pick(event: Event) { emit("update:modelValue", (event.target as HTMLSelectElement).value); }
/** 接过来的原文最长也就一屏，展开前只留三行，免得一页全是 JSON。 */
function clip(json: string) { return json.length > 420 ? `${json.slice(0, 420)}…` : json; }
</script>

<template>
  <div class="inherit" :data-on="props.modelValue ? 'true' : 'false'">
    <div class="head">
      <label class="pick">
        <span>沿用已有修订</span>
        <select :value="props.modelValue" @change="pick">
          <option value="">不沿用</option>
          <option v-for="option in props.options" :key="option.id" :value="option.id">{{ option.label }}</option>
        </select>
      </label>
      <button v-if="props.modelValue" type="button" class="ghost" @click="emit('update:modelValue', '')">取消沿用</button>
    </div>
    <ul v-if="props.rows.length" class="rows">
      <li v-for="(row, index) in props.rows" :key="`${row.label}-${index}`">
        <span class="label">{{ row.label }}</span><strong>{{ row.value }}</strong>
        <pre v-if="row.json">{{ clip(row.json) }}</pre>
      </li>
    </ul>
    <small v-else-if="props.notice">{{ props.notice }}</small>
    <small v-else-if="props.modelValue" class="none">这一版没有本页要接的内容。</small>
  </div>
</template>

<style scoped>
.inherit { padding: 16px 18px; border: 1px solid var(--line-soft); margin-bottom: 18px; }
.inherit[data-on="true"] { border-color: var(--line); background: var(--surface-1); }
.head { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; }
.pick { display: grid; gap: 8px; flex: 1; color: var(--ink-muted); font-size: 11px; letter-spacing: 0.6px; }
.pick select { width: 100%; }
.head .ghost { flex: none; }
.rows { display: grid; gap: 0; margin: 16px 0 0; padding: 0; list-style: none; }
.rows li { display: grid; grid-template-columns: 150px minmax(0, 1fr); gap: 6px 14px; padding: 12px 0; border-top: 1px solid var(--line-soft); }
.rows li:first-child { border-top: 0; }
.label { color: var(--ink-muted); font-size: 11px; letter-spacing: 0.5px; }
.rows strong { font-size: 13px; font-weight: 500; overflow-wrap: anywhere; }
.rows pre { grid-column: 1 / -1; margin: 4px 0 0; padding: 10px 12px; border: 1px solid var(--line-soft); max-height: 168px; overflow: auto; color: var(--ink-soft); font-family: ui-monospace, monospace; font-size: 11px; line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; }
.none { display: block; margin-top: 12px; color: var(--ink-faint); font-size: 11px; }
.inherit small { color: var(--ink-muted); font-size: 11px; }
</style>
