<script setup lang="ts">
import { rollCallSettingFields, type RollCallSettingKey, type RollCallSettingsDraft } from "#shared/schemas";

/**
 * 点名设置的三态编辑器：每一项都可以“不表态”，不表态的字段由上级作用域继续决定，
 * 最终落到设备本机的设置。设备详情与点名页共用这份控件与字段表。
 */
const props = withDefaults(defineProps<{
  /** 该作用域当前真正生效的值；缺省时不显示生效行（例如全校默认值自己就是最外层）。 */
  effective?: RollCallSettingsDraft | null;
  /** 生效值命中的层级，local 表示由设备本机设置决定，服务端并不知道具体值。 */
  sources?: Partial<Record<RollCallSettingKey, string>> | null;
  /** 不表态那一档的叫法：设备上是“跟随上级”，全校上是“交给设备”。 */
  followLabel?: string;
  disabled?: boolean;
}>(), { followLabel: "跟随上级" });
/** 本层正在编辑的值：字段为 null 表示这一项不表态。 */
const model = defineModel<RollCallSettingsDraft>({ required: true });

const rows = computed(() => rollCallSettingFields.map((field) => ({
  key: field.key,
  label: field.label,
  hint: field.hint,
  kind: field.kind,
  min: "min" in field ? field.min : 0,
  max: "max" in field ? field.max : 0,
  options: field.kind === "switch"
    ? [{ state: "follow", label: props.followLabel }, { state: "on", label: field.on }, { state: "off", label: field.off }]
    : [{ state: "follow", label: props.followLabel }, { state: "custom", label: "自定义" }],
})));

function stateOf(key: RollCallSettingKey) {
  const value = model.value[key];
  if (value === null || value === undefined) return "follow";
  return typeof value === "boolean" ? (value ? "on" : "off") : "custom";
}

function numberValue(key: RollCallSettingKey) {
  const value = model.value[key];
  return typeof value === "number" ? value : null;
}

/** 生效值一行：本机那一档服务端看不见具体值，只说清是谁在决定。 */
function effectiveText(key: RollCallSettingKey, kind: "switch" | "number") {
  if (!props.effective) return "";
  const source = props.sources?.[key] ?? "local";
  if (source === "local") return "由设备本机设置决定";
  const value = props.effective[key];
  if (value === null || value === undefined) return "";
  const text = kind === "switch" ? (value ? "开启" : "关闭") : `${value} 秒`;
  return `${text} · ${labelOf(ROLLCALL_SOURCE_LABELS, source)}`;
}

function setValue(key: RollCallSettingKey, value: boolean | number | null) {
  model.value = { ...model.value, [key]: value };
}

function pickOption(key: RollCallSettingKey, kind: "switch" | "number", min: number, state: string) {
  if (state === "follow") return setValue(key, null);
  if (state === "on") return setValue(key, true);
  if (state === "off") return setValue(key, false);
  // 刚切到自定义时先填一个能用的值：优先照当前生效值起步，别让用户从 0 改起。
  const inherited = kind === "number" ? props.effective?.[key] : null;
  setValue(key, typeof inherited === "number" ? inherited : min);
}

function onNumberInput(key: RollCallSettingKey, min: number, max: number, event: Event) {
  const value = (event.target as HTMLInputElement).valueAsNumber;
  if (Number.isNaN(value)) return setValue(key, min);
  setValue(key, Math.min(max, Math.max(min, Math.round(value))));
}
</script>

<template>
  <div class="fields">
    <div v-for="row in rows" :key="row.key" class="row">
      <span class="text">
        <span class="label">{{ row.label }}</span>
        <small>{{ row.hint }}</small>
        <small v-if="effectiveText(row.key, row.kind)" class="state">当前：{{ effectiveText(row.key, row.kind) }}</small>
      </span>
      <span class="control">
        <div class="seg">
          <button
            v-for="option in row.options"
            :key="option.state"
            type="button"
            :data-active="stateOf(row.key) === option.state ? 'true' : 'false'"
            :disabled="props.disabled"
            @click="pickOption(row.key, row.kind, row.min, option.state)"
          >{{ option.label }}</button>
        </div>
        <input
          v-if="row.kind === 'number' && stateOf(row.key) === 'custom'"
          type="number"
          :min="row.min"
          :max="row.max"
          :step="1"
          :value="numberValue(row.key)"
          :disabled="props.disabled"
          @input="onNumberInput(row.key, row.min, row.max, $event)"
        >
      </span>
    </div>
  </div>
</template>

<style scoped>
.fields { display: grid; }
.row { display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 14px 0; border-bottom: 1px solid var(--line-soft); }
.row:last-child { border-bottom: 0; }
.text { display: grid; gap: 3px; min-width: 0; }
.label { font-size: 12px; line-height: 1.4; }
small { color: var(--ink-muted); font-size: 10px; line-height: 1.4; }
.state { color: var(--ink-soft); font-variant-numeric: tabular-nums; }
.control { display: flex; align-items: center; gap: 10px; flex: none; }
.control input { width: 88px; }
@media (max-width: 620px) {
  .row { flex-direction: column; align-items: flex-start; }
}
</style>
