<script setup lang="ts">
import {
  DEFAULT_CLASS_PLAN_GROUP_ID,
  TIME_TYPES,
  WEEKDAYS,
  emptyProfile,
  ensureClassPlan,
  findClassPlan,
  newLayoutItem,
  newSubject,
  periodsOf,
  readProfile,
  standardLayoutItems,
  subjectName,
  uuid,
  writeProfileDocument,
  type CiProfile,
} from "#shared/classisland-profile";
import { resolveSubjectShortcut } from "#shared/subject-shortcut";

useHead({ title: "课表" });

type ConfigRow = { configurationId: string; kind: string; name: string; revision: number; createdAt: string };

const { data: configs, refresh } = await useFetch<ConfigRow[]>("/api/v1/admin/configurations", { default: () => [] });
const profileConfigs = computed(() => configs.value.filter((item) => item.kind === "profile"));

/**
 * SSR 与首帧必须渲染同一份占位档案：emptyProfile() 生成的随机时间表 id
 * 会在服务端与客户端不一致，触发 hydration mismatch。
 */
const PLACEHOLDER_LAYOUT_ID = "00000000-0000-4000-8000-00000000f001";
function placeholderProfile(): CiProfile {
  const value = emptyProfile();
  const layout = value.timeLayouts[0];
  if (layout) layout.id = PLACEHOLDER_LAYOUT_ID;
  return value;
}

const profile = ref<CiProfile>(placeholderProfile());
const activeId = ref<string | null>(null);
const profileName = ref("新档案");
const dirty = ref(false);
const loading = ref(false);
const toast = useToast();
const showDeploy = ref(false);

function onDeployed(result: { name: string; deviceCount: number }) { toast.ok(`已下发「${result.name}」到 ${result.deviceCount} 台设备。`); }
const tab = ref<"timetable" | "subjects" | "layouts">("timetable");
const activeLayoutId = ref("");
const activeGroupId = ref(DEFAULT_CLASS_PLAN_GROUP_ID);
const fileInput = ref<HTMLInputElement>();
const showQuick = ref(false);
/** 选中的格子：常驻科目墙直接往这里写。 */
const activeCell = ref<{ weekDay: number; periodIndex: number } | null>(null);
/** 连续填充：选完一格自动跳下一格，和 ClassIsland 的科目快选手感一致。 */
const autoNext = ref(true);
watch(autoNext, (value) => {
  if (import.meta.client) localStorage.setItem("classisland-control-timetable-auto-next", value ? "1" : "0");
});

const tabs = [
  { key: "timetable", label: "课表" },
  { key: "subjects", label: "科目" },
  { key: "layouts", label: "时间表" },
] as const;

const baseLayoutId = computed({
  get: () => activeLayoutId.value || profile.value.timeLayouts[0]?.id || "",
  set: (value: string) => { activeLayoutId.value = value; },
});
const activeLayout = computed(() => profile.value.timeLayouts.find((layout) => layout.id === baseLayoutId.value));
const periods = computed(() => periodsOf(profile.value, baseLayoutId.value));

function fail(err: unknown, fallback: string) {
  return (err as { data?: { message?: string } })?.data?.message ?? fallback;
}
function markDirty() { dirty.value = true; }
function weekdayLabel(value: number) { return WEEKDAYS.find((day) => day.value === value)?.label ?? "周?"; }

function resetSelection() {
  activeCell.value = null;
  activeGroupId.value = profile.value.classPlanGroups.some((group) => group.id === profile.value.selectedClassPlanGroupId)
    ? profile.value.selectedClassPlanGroupId
    : DEFAULT_CLASS_PLAN_GROUP_ID;
  activeLayoutId.value = profile.value.timeLayouts[0]?.id ?? "";
}

async function loadConfig(id: string) {
  if (!id) return;
  loading.value = true;
  try {
    const history = await $fetch<{ documentJson: string }[]>(`/api/v1/admin/configurations/${id}/history`);
    profile.value = readProfile(JSON.parse(history[0]?.documentJson ?? "{}") as unknown);
    activeId.value = id;
    profileName.value = configs.value.find((item) => item.configurationId === id)?.name ?? profile.value.name;
    resetSelection();
    dirty.value = false;
    toast.ok("已载入该配置的当前修订。");
  } catch (err) { toast.err(fail(err, "载入配置失败。")); }
  finally { loading.value = false; }
}

function createBlank() {
  profile.value = emptyProfile("新档案");
  activeId.value = null;
  profileName.value = "新档案";
  resetSelection();
  dirty.value = true;
  toast.ok("已创建空白档案，编辑后保存会写入配置库。");
}

async function importFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;

  try {
    profile.value = readProfile(JSON.parse(await file.text()) as unknown);
    profileName.value = file.name.replace(/\.json$/i, "") || profile.value.name;
    activeId.value = null;
    resetSelection();
    dirty.value = true;
    toast.ok("已导入档案内容，保存后将成为新的配置。");
  } catch (err) { toast.err(fail(err, "无法解析该 JSON 文件。")); }
  finally { if (fileInput.value) fileInput.value.value = ""; }
}

async function save() {
  profile.value.selectedClassPlanGroupId = activeGroupId.value;
  loading.value = true;
  try {
    const result = await $fetch<{ configurationId: string; revision: number }>("/api/v1/admin/configurations", {
      method: "POST",
      headers: { origin: location.origin },
      body: {
        configurationId: activeId.value ?? undefined,
        kind: "profile",
        name: profileName.value.trim() || profile.value.name || "档案",
        document: writeProfileDocument(profile.value),
      },
    });
    activeId.value = result.configurationId;
    await refresh();
    dirty.value = false;
    toast.ok(`已保存为 R${result.revision}。`);
  } catch (err) { toast.err(fail(err, "保存失败。")); }
  finally { loading.value = false; }
}

/** 破坏性操作统一走二次确认弹窗，不用浏览器原生 confirm。 */
const pending = ref<{ title: string; description: string; confirmText: string; danger: boolean; run: () => void | Promise<void> } | null>(null);
const confirmBusy = ref(false);
async function runPending() {
  const task = pending.value;
  if (!task) return;
  confirmBusy.value = true;
  try { await task.run(); }
  finally { confirmBusy.value = false; pending.value = null; }
}
function addSubject() {
  profile.value.subjects.push(newSubject(`科目${profile.value.subjects.length + 1}`));
  markDirty();
}
function removeSubject(id: string) {
  const subject = profile.value.subjects.find((item) => item.id === id);
  pending.value = {
    title: "删除科目",
    description: `删除科目${subject ? `「${subject.name}」` : ""}？引用它的课表单元格会变为空。`,
    confirmText: "删除", danger: true, run: () => dropSubject(id),
  };
}
function dropSubject(id: string) {
  profile.value.subjects = profile.value.subjects.filter((subject) => subject.id !== id);
  markDirty();
}

function addLayout() {
  const layout = { id: uuid(), name: `时间表${profile.value.timeLayouts.length + 1}`, layouts: standardLayoutItems(), extra: {} };
  profile.value.timeLayouts.push(layout);
  activeLayoutId.value = layout.id;
  markDirty();
}
function removeLayout(id: string) {
  if (profile.value.timeLayouts.length <= 1) { toast.err("至少保留一个时间表。"); return; }
  const layout = profile.value.timeLayouts.find((item) => item.id === id);
  pending.value = {
    title: "删除时间表",
    description: `删除时间表${layout ? `「${layout.name}」` : ""}？引用它的课表会失去时间点。`,
    confirmText: "删除", danger: true, run: () => dropLayout(id),
  };
}
function dropLayout(id: string) {
  profile.value.timeLayouts = profile.value.timeLayouts.filter((layout) => layout.id !== id);
  activeLayoutId.value = profile.value.timeLayouts[0]?.id ?? "";
  markDirty();
}
function addLayoutItem() { activeLayout.value?.layouts.push(newLayoutItem(0)); markDirty(); }
function removeLayoutItem(index: number) { activeLayout.value?.layouts.splice(index, 1); markDirty(); }
function applyStandardTemplate() {
  if (!activeLayout.value) return;
  pending.value = {
    title: "套用标准作息",
    description: "用标准作息替换当前时间表的所有时间点？",
    confirmText: "替换", danger: false, run: dropStandardLayout,
  };
}
function dropStandardLayout() {
  if (!activeLayout.value) return;
  activeLayout.value.layouts = standardLayoutItems();
  markDirty();
}

function addGroup() {
  const group = { id: uuid(), name: `课表群${profile.value.classPlanGroups.length + 1}`, isGlobal: false, extra: {} };
  profile.value.classPlanGroups.push(group);
  activeGroupId.value = group.id;
  markDirty();
}
function dayPlan(weekDay: number) { return findClassPlan(profile.value, activeGroupId.value, weekDay); }
function dayPlanName(weekDay: number) { return dayPlan(weekDay)?.name ?? ""; }
function renameDay(weekDay: number, name: string) {
  const plan = ensureClassPlan(profile.value, activeGroupId.value, weekDay, baseLayoutId.value, `${weekdayLabel(weekDay)}课表`);
  if (name.trim()) plan.name = name.trim();
  markDirty();
}
function cellValue(weekDay: number, periodIndex: number) {
  return dayPlan(weekDay)?.classes[periodIndex]?.subjectId ?? "";
}
function setCell(weekDay: number, periodIndex: number, subjectId: string) {
  const plan = ensureClassPlan(profile.value, activeGroupId.value, weekDay, baseLayoutId.value, `${weekdayLabel(weekDay)}课表`);
  const info = plan.classes[periodIndex];
  if (info) info.subjectId = subjectId;
  markDirty();
}
function cellName(weekDay: number, periodIndex: number) {
  return subjectName(profile.value, cellValue(weekDay, periodIndex));
}
/** 先往下、列到底再换下一列，键盘连着填一整天不用碰鼠标。 */
function nextCellOf(weekDay: number, periodIndex: number): { weekDay: number; periodIndex: number } | null {
  const column = WEEKDAYS.findIndex((day) => day.value === weekDay);
  if (column < 0) return null;
  let nextColumn = column;
  let nextRow = periodIndex + 1;
  if (nextRow >= periods.value.length) {
    nextRow = 0;
    nextColumn += 1;
  }
  const nextDay = WEEKDAYS[nextColumn];
  return nextDay ? { weekDay: nextDay.value, periodIndex: nextRow } : null;
}
function cellElement(weekDay: number, periodIndex: number) {
  return document.querySelector<HTMLElement>(`.grid .cell[data-cell="${weekDay}-${periodIndex}"]`);
}
function selectCell(weekDay: number, periodIndex: number) {
  activeCell.value = { weekDay, periodIndex };
}
/** 写完后把选中格挪到下一节。focus 留给键盘连打，鼠标点常驻选择器时不动焦点。 */
function advanceSelection(from: { weekDay: number; periodIndex: number }, focus: boolean) {
  if (!autoNext.value) return;
  const next = nextCellOf(from.weekDay, from.periodIndex);
  if (!next) {
    toast.ok("本周课表填完了。");
    return;
  }
  activeCell.value = next;
  const element = cellElement(next.weekDay, next.periodIndex);
  if (!element) return;
  if (focus) element.focus();
  else element.scrollIntoView({ block: "nearest", inline: "nearest" });
}
/** 常驻科目墙落笔：写进选中的格子，然后把选中格挪到下一节。 */
function wallPick(subjectId: string) {
  const cell = activeCell.value;
  if (!cell) return;
  setCell(cell.weekDay, cell.periodIndex, subjectId);
  advanceSelection(cell, false);
}
function wallClear() {
  const cell = activeCell.value;
  if (!cell) return;
  setCell(cell.weekDay, cell.periodIndex, "");
  advanceSelection(cell, false);
}
/** 方向键在格子间走，Delete 清空，数字/首字直接落科目。 */
function onCellKeydown(weekDay: number, periodIndex: number, event: KeyboardEvent) {
  if (event.key === "Delete" || event.key === "Backspace") {
    event.preventDefault();
    setCell(weekDay, periodIndex, "");
    return;
  }
  if (!event.ctrlKey && !event.metaKey && !event.altKey) {
    const shortcut = resolveSubjectShortcut(profile.value.subjects, event.key);
    if (shortcut) {
      event.preventDefault();
      setCell(weekDay, periodIndex, shortcut.clear ? "" : shortcut.id);
      selectCell(weekDay, periodIndex);
      advanceSelection({ weekDay, periodIndex }, true);
      return;
    }
  }
  const steps: Record<string, [number, number]> = {
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
  };
  const step = steps[event.key];
  if (!step) return;
  event.preventDefault();
  const column = WEEKDAYS.findIndex((day) => day.value === weekDay) + step[0];
  const row = periodIndex + step[1];
  const nextDay = WEEKDAYS[column];
  if (!nextDay || row < 0 || row >= periods.value.length) return;
  cellElement(nextDay.value, row)?.focus();
}
function syncGroupLayout() {
  for (const day of WEEKDAYS) {
    const plan = dayPlan(day.value);
    if (plan) ensureClassPlan(profile.value, activeGroupId.value, day.value, baseLayoutId.value, plan.name);
  }
  markDirty();
  toast.ok("已把当前时间表套用到本周课表。");
}

onMounted(async () => {
  autoNext.value = localStorage.getItem("classisland-control-timetable-auto-next") !== "0";
  const route = useRoute();
  // 配置库的「可视化编辑」用 ?config=<id> 深链进来，优先载入指定修订。
  const requested = String(route.query.config ?? "");
  if (requested && profileConfigs.value.some((item) => item.configurationId === requested)) await loadConfig(requested);
  else if (profileConfigs.value[0]) await loadConfig(profileConfigs.value[0].configurationId);
  // 楼栋页「发布课表」深链：载入档案后直接展开下发面板。
  if (route.query.publish && activeId.value) showDeploy.value = true;
});
</script>

<template>
  <PageHeading kicker="可视化排课" title="课表">
    <button type="button" class="ghost" @click="showQuick = true">快装</button>
    <button type="button" class="ghost" @click="fileInput?.click()">导入档案</button>
    <button type="button" class="ghost" @click="createBlank">新建空档案</button>
    <button type="button" class="ghost" :disabled="!activeId" @click="showDeploy = !showDeploy">下发到已选目标</button>
    <button type="button" class="solid" :disabled="loading" @click="save">保存为新修订</button>
    <input ref="fileInput" hidden type="file" accept="application/json,.json" @change="importFile">
  </PageHeading>

  <DeployTargets
    v-if="showDeploy && activeId"
    :configuration-id="activeId"
    :configuration-name="profileName"
    :revision="profileConfigs.find(item => item.configurationId === activeId)?.revision"
    @deployed="onDeployed"
    @close="showDeploy = false"
  />

  <QuickSetupDialog
    v-if="showQuick"
    :profile="profile"
    :layout-id="baseLayoutId"
    :group-id="activeGroupId"
    @applied="markDirty"
    @close="showQuick = false"
  />

  <section class="toolbar">
    <label>档案配置
      <select :value="activeId ?? ''" @change="loadConfig(($event.target as HTMLSelectElement).value)">
        <option value="">（未保存的新档案）</option>
        <option v-for="item in profileConfigs" :key="item.configurationId" :value="item.configurationId">{{ item.name }} · R{{ item.revision }}</option>
      </select>
    </label>
    <label>档案名称<input v-model="profileName" @input="markDirty"></label>
    <span class="badge" :data-dirty="dirty">{{ dirty ? "有未保存修改" : "已同步" }}</span>
    <span class="micro">{{ profile.subjects.length }} 个科目 · {{ profile.timeLayouts.length }} 张时间表 · {{ profile.classPlans.length }} 张课表</span>
  </section>

  <PageTabs v-model="tab" :items="tabs" />

  <section v-if="tab === 'timetable'">
    <header class="panel-head">
      <label>课表群<select v-model="activeGroupId" @change="markDirty"><option v-for="group in profile.classPlanGroups" :key="group.id" :value="group.id">{{ group.name }}</option></select></label>
      <label>基准时间表<select v-model="baseLayoutId"><option v-for="layout in profile.timeLayouts" :key="layout.id" :value="layout.id">{{ layout.name }}</option></select></label>
      <button type="button" @click="addGroup">新增课表群</button>
      <button type="button" @click="syncGroupLayout">套用时间表到本周</button>
    </header>
    <p v-if="!periods.length" class="muted">这张时间表还没有“上课”时间点。去「时间表」加，或用「快装」粘贴。</p>
    <div v-else class="board">
      <div class="grid-shell">
        <table class="grid">
          <thead>
            <tr>
              <th class="corner">节次</th>
              <th v-for="day in WEEKDAYS" :key="day.value">
                <span class="day">{{ day.label }}</span>
                <input :value="dayPlanName(day.value)" placeholder="未创建" maxlength="40" @change="renameDay(day.value, ($event.target as HTMLInputElement).value)">
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(period, rowIndex) in periods" :key="`${period.item.startTime}-${rowIndex}`">
              <th class="period"><strong>{{ rowIndex + 1 }}</strong><small>{{ period.item.startTime }}–{{ period.item.endTime }}</small></th>
              <td v-for="day in WEEKDAYS" :key="day.value">
                <button
                  type="button"
                  class="cell"
                  :data-cell="`${day.value}-${rowIndex}`"
                  :data-current="activeCell && activeCell.weekDay === day.value && activeCell.periodIndex === rowIndex ? 'true' : 'false'"
                  :data-empty="cellName(day.value, rowIndex) ? 'false' : 'true'"
                  :title="cellName(day.value, rowIndex) || '未排课'"
                  @click="selectCell(day.value, rowIndex)"
                  @focus="selectCell(day.value, rowIndex)"
                  @keydown="onCellKeydown(day.value, rowIndex, $event)"
                >{{ cellName(day.value, rowIndex) || "无" }}</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <SubjectWall
        v-model:auto-next="autoNext"
        :subjects="profile.subjects"
        :current="activeCell ? cellValue(activeCell.weekDay, activeCell.periodIndex) : ''"
        :label="activeCell ? `${weekdayLabel(activeCell.weekDay)} · 第 ${activeCell.periodIndex + 1} 节` : ''"
        :ready="activeCell !== null"
        @pick="wallPick"
        @clear="wallClear"
      />
    </div>
  </section>

  <section v-else-if="tab === 'subjects'">
    <header class="panel-head">
      <h2>科目</h2>
      <button type="button" @click="addSubject">新增科目</button>
    </header>
    <p v-if="!profile.subjects.length" class="muted">还没有科目。</p>
    <div v-else class="rows">
      <div v-for="subject in profile.subjects" :key="subject.id" class="row subject-row">
        <label>名称<input v-model="subject.name" maxlength="40" @input="markDirty"></label>
        <label>简称<input v-model="subject.initial" maxlength="8" @input="markDirty"></label>
        <label>任课教师<input v-model="subject.teacherName" maxlength="40" @input="markDirty"></label>
        <label class="check"><input v-model="subject.isOutDoor" type="checkbox" @change="markDirty">户外</label>
        <button type="button" class="danger" @click="removeSubject(subject.id)">删除</button>
      </div>
    </div>
  </section>

  <section v-else>
    <header class="panel-head">
      <label>编辑时间表<select v-model="baseLayoutId"><option v-for="layout in profile.timeLayouts" :key="layout.id" :value="layout.id">{{ layout.name }}</option></select></label>
      <button type="button" @click="addLayout">新增时间表</button>
      <button type="button" @click="applyStandardTemplate">生成标准作息</button>
      <button type="button" class="danger" @click="activeLayout && removeLayout(activeLayout.id)">删除当前时间表</button>
    </header>
    <template v-if="activeLayout">
      <label class="layout-name">时间表名称<input v-model="activeLayout.name" maxlength="40" @input="markDirty"></label>
      <div class="rows">
        <div v-for="(item, index) in activeLayout.layouts" :key="index" class="row layout-row">
          <label>类型<select v-model.number="item.timeType" @change="markDirty"><option v-for="type in TIME_TYPES" :key="type.value" :value="type.value">{{ type.label }}</option></select></label>
          <label>开始<input v-model="item.startTime" type="time" @change="markDirty"></label>
          <label>结束<input v-model="item.endTime" type="time" :disabled="item.timeType === 2 || item.timeType === 3" @change="markDirty"></label>
          <label>课间名称<input v-model="item.breakName" maxlength="30" :disabled="item.timeType !== 1" @input="markDirty"></label>
          <button type="button" class="danger" @click="removeLayoutItem(index)">删除</button>
        </div>
      </div>
      <button type="button" class="add-item" @click="addLayoutItem">新增时间点</button>
      <p class="hint">共 {{ activeLayout.layouts.length }} 个时间点，其中 {{ periods.length }} 节“上课”。</p>
    </template>
  </section>

  <ConfirmDialog
    v-if="pending"
    :title="pending.title"
    :description="pending.description"
    :confirm-text="pending.confirmText"
    :danger="pending.danger"
    :busy="confirmBusy"
    @close="pending = null"
    @confirm="runPending"
  />
</template>
<style scoped>
section { margin-top: 22px; }
.toolbar { display: flex; align-items: flex-end; flex-wrap: wrap; gap: 18px; margin-bottom: 22px; }
.toolbar label { display: grid; gap: 8px; color: var(--ink-muted); font-size: 11px; letter-spacing: 0.6px; }
.toolbar select { min-width: 220px; }
.toolbar input { min-width: 200px; }
.badge { padding: 6px 11px; border: 1px solid var(--line); color: var(--ink-muted); font-size: 10px; letter-spacing: 0.8px; }
.badge[data-dirty="true"] { border-color: var(--accent); color: var(--accent); }
.panel-head { flex-wrap: wrap; padding-bottom: 18px; border-bottom: 1px solid var(--line-strong); margin-bottom: 22px; }
.panel-head label { display: grid; gap: 8px; color: var(--ink-muted); font-size: 11px; letter-spacing: 0.6px; }
.panel-head h2 { margin: 0; }

/* 课表网格：RhineLab 的发丝格线，节次表头用微标签。 */
.board { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 22px; align-items: start; }
.grid-shell { overflow: auto; }
.grid { width: 100%; border-collapse: collapse; table-layout: fixed; }
.grid th, .grid td { border: 1px solid var(--line-soft); padding: 6px; text-align: center; }
.grid thead th { border-top: 0; padding: 12px 6px; }
.grid thead th.corner { border-left: 0; color: var(--ink-muted); font-size: 10px; letter-spacing: 1.2px; font-weight: 400; }
.grid .day { display: block; font-size: 13px; font-weight: 600; }
.grid thead input { width: 100%; margin-top: 8px; min-height: 28px; padding: 0 8px; border: 1px solid var(--line-soft); background: transparent; font-size: 11px; text-align: center; }
.grid tbody th.period { border-left: 0; width: 76px; }
.grid tbody th.period strong { display: block; font-size: 15px; font-weight: 600; }
.grid tbody th.period small { display: block; margin-top: 4px; color: var(--ink-faint); font-size: 9px; font-variant-numeric: tabular-nums; }
.cell {
  width: 100%;
  min-height: 56px;
  padding: 6px;
  border: 0;
  background: transparent;
  color: var(--ink);
  font-size: 13px;
  letter-spacing: 0.2px;
  text-align: center;
  transition: background var(--t-base) var(--ease-enter), color var(--t-base) var(--ease-enter);
}
.cell:hover { border: 0; background: var(--accent-wash); color: var(--ink); }
.cell[data-empty="true"] { color: var(--ink-faint); }
.cell[data-current="true"], .cell[data-current="true"]:hover { border: 0; background: var(--fill); color: var(--fill-ink); }

/* 科目 / 时间点：一行一个字段组。 */
.rows { display: grid; border-top: 1px solid var(--line-strong); }
.row {
  display: flex;
  align-items: flex-end;
  gap: 16px;
  padding: 16px 2px;
  border-bottom: 1px solid var(--line-soft);
}
.row label { display: grid; gap: 7px; flex: 1; min-width: 0; color: var(--ink-muted); font-size: 11px; letter-spacing: 0.6px; }
.row input, .row select { width: 100%; }
.row label.check { display: flex; align-items: center; gap: 9px; flex: 0 0 auto; padding-bottom: 8px; font-size: 12px; }
.layout-name { display: grid; gap: 8px; margin-bottom: 20px; max-width: 360px; color: var(--ink-muted); font-size: 11px; letter-spacing: 0.6px; }
.layout-name input { width: 100%; }
.add-item { margin-top: 18px; }
.hint, .muted { color: var(--ink-muted); font-size: 12px; line-height: 1.8; }
.hint { margin-top: 16px; }
@media (max-width: 1080px) {
  .board { grid-template-columns: 1fr; }
  .row { flex-wrap: wrap; }
  .row label { flex: 1 1 160px; }
}
</style>