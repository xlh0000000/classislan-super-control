<script setup lang="ts">
import {
  applyQuickSetup,
  previewQuickSetup,
  type QuickSetupMode,
} from "#shared/timetable-quick-setup";
import { WEEKDAYS, type CiProfile } from "#shared/classisland-profile";

const props = defineProps<{ profile: CiProfile; layoutId: string; groupId: string }>();
const emit = defineEmits<{ close: []; applied: [] }>();

const toast = useToast();
const text = ref("");
const mode = ref<QuickSetupMode>("overwrite");
const overrides = ref<Record<number, number | null>>({});
const fileInput = ref<HTMLInputElement>();

/** 解析结果随粘贴内容实时刷新，整份弹窗只有「粘贴 → 确认」两步。 */
const preview = computed(() =>
  previewQuickSetup(props.profile, {
    text: text.value,
    layoutId: props.layoutId,
    groupId: props.groupId,
    mode: mode.value,
    weekDayByColumn: overrides.value,
  }),
);

const canApply = computed(() => preview.value.cells > 0);
const usedColumns = computed(() => preview.value.columns.filter((column) => column.weekDay !== null).length);

function columnValue(column: number): string {
  const weekDay = preview.value.columns.find((item) => item.column === column)?.weekDay;
  return weekDay === undefined || weekDay === null ? "" : String(weekDay);
}

function setColumn(column: number, raw: string) {
  const next = { ...overrides.value };
  if (raw) next[column] = Number(raw);
  else delete next[column];
  overrides.value = next;
}

function cellText(row: number, column: number): string {
  return preview.value.grid[row]?.[column] || "—";
}

async function readFile(file: File | undefined) {
  if (!file) return;
  try {
    text.value = await file.text();
  } catch {
    toast.err("读不出这个文件，可以打开后复制粘贴。");
  }
}

async function pickFile(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  await readFile(file);
}

function apply() {
  if (!canApply.value) return;
  const result = applyQuickSetup(props.profile, {
    text: text.value,
    layoutId: props.layoutId,
    groupId: props.groupId,
    mode: mode.value,
    weekDayByColumn: overrides.value,
  });
  const parts = [`写入 ${result.writtenCells} 格课表`];
  if (result.createdSubjects) parts.unshift(`新增 ${result.createdSubjects} 个科目`);
  if (result.createdPeriods) parts.push(`新增 ${result.createdPeriods} 个时间点`);
  toast.ok(`快装完成：${parts.join("、")}。`);
  emit("applied");
  emit("close");
}
</script>

<template>
  <AppDialog title="快装课表" kicker="从表格粘贴导入" width="880px" @close="emit('close')">
    <textarea
      v-model="text"
      class="paste"
      rows="6"
      spellcheck="false"
      placeholder="从 Excel 框选复制后粘贴到这里，也可以拖进 CSV / TXT…"
      @drop.prevent="readFile($event.dataTransfer?.files?.[0])"
      @dragover.prevent
    />
    <div class="bar">
      <button type="button" class="ghost" @click="fileInput?.click()">上传 CSV / TXT</button>
      <span class="muted">首行星期、首列节次</span>
      <span class="spacer" />
      <div class="seg">
        <button type="button" :data-active="mode === 'overwrite'" @click="mode = 'overwrite'">覆盖</button>
        <button type="button" :data-active="mode === 'fill'" @click="mode = 'fill'">仅填空</button>
      </div>
      <input ref="fileInput" hidden type="file" accept=".csv,.txt,.tsv,text/csv,text/plain" @change="pickFile">
    </div>

    <p v-if="preview.messages.length" class="note">{{ preview.messages.join(" ") }}</p>

    <div v-if="usedColumns" class="preview-shell">
      <table class="preview">
        <thead>
          <tr>
            <th class="corner">节次</th>
            <th v-for="column in preview.columns" :key="column.column">
              <select
                :value="columnValue(column.column)"
                @change="setColumn(column.column, ($event.target as HTMLSelectElement).value)"
              >
                <option value="">忽略</option>
                <option v-for="day in WEEKDAYS" :key="day.value" :value="String(day.value)">{{ day.label }}</option>
              </select>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in preview.rows" :key="row.row">
            <th class="corner">{{ row.label || "—" }}</th>
            <td
              v-for="column in preview.columns"
              :key="column.column"
              :data-off="row.index === null || column.weekDay === null"
            >{{ cellText(row.row, column.column) }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <p class="summary">
      识别 {{ preview.rows.length }} 节 × {{ usedColumns }} 天 · 新增科目 {{ preview.subjects.length }} · 写入 {{ preview.cells }} 格<template v-if="preview.skipped">（跳过 {{ preview.skipped }} 格）</template><template v-if="preview.newPeriods"> · 新增时间点 {{ preview.newPeriods }}</template>
    </p>

    <template #footer>
      <button type="button" class="ghost" @click="emit('close')">取消</button>
      <button type="button" :disabled="!canApply" @click="apply">快装</button>
    </template>
  </AppDialog>
</template>

<style scoped>
.paste{width:100%;min-height:132px;padding:14px 16px;border:1px solid var(--line);background:var(--surface-1);color:var(--ink);font:12px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace;resize:vertical;transition:border-color var(--t-mid) var(--ease-enter)}
.paste:focus{border-color:var(--accent)}
.paste::placeholder{color:var(--ink-muted)}
.bar{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-top:12px}
.bar .muted{font-size:11px}
.spacer{flex:1}
.note{margin:12px 0 0;padding:12px 14px;border-left:2px solid var(--accent);background:var(--surface-2);color:var(--ink-soft);font-size:11px;line-height:1.7}
.preview-shell{margin-top:12px;max-height:304px;overflow:auto;border:1px solid var(--line);background:var(--surface-1)}
.preview{width:100%;border-collapse:collapse}
.preview th,.preview td{padding:0;border:0}
.preview .corner{min-width:76px;padding:9px 10px;border-bottom:1px solid var(--line-soft);color:var(--ink-muted);font-size:10px;font-weight:400;letter-spacing:.8px;text-align:left;white-space:nowrap}
.preview thead .corner{border-bottom-color:var(--line-strong)}
.preview thead select{width:100%;min-height:var(--control-h-sm);padding:0 6px;border:0;border-bottom:1px solid var(--line-soft);background:transparent;color:var(--ink);font-size:11px}
.preview td{padding:9px 10px;border-bottom:1px solid var(--line-soft);font-size:11px;white-space:nowrap}
.preview td[data-off="true"]{color:var(--ink-muted);opacity:.5}
.summary{margin:12px 0 0;color:var(--ink-muted);font-size:11px;letter-spacing:.4px}
</style>