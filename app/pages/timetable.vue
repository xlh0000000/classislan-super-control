<script setup lang="ts">
import {
  DEFAULT_CLASS_PLAN_GROUP_ID,
  TIME_TYPES,
  WEEKDAYS,
  ensureClassPlan,
  findClassPlan,
  newSubject,
  periodsOf,
  readProfile,
  standardLayoutItems,
  starterProfile,
  subjectName,
  uuid,
  writeProfileDocument,
  type CiProfile,
  type CiTimeLayout,
  type CiTimeLayoutItem,
} from "#shared/classisland-profile";
import { resolveSubjectShortcut } from "#shared/subject-shortcut";

useHead({ title: "课表" });

type ConfigRow = { configurationId: string; kind: string; name: string; currentRevision: number | null };

const { data: configs, refresh } = await useFetch<ConfigRow[]>("/api/v1/admin/configurations", { default: () => [] });
const profileConfigs = computed(() => configs.value.filter((item) => item.kind === "profile"));
const route = useRoute();

/** 首帧占位档案：默认时间表用固定 id，服务端与客户端渲染出同一份。 */
const profile = ref<CiProfile>(starterProfile("新档案"));
const activeId = ref<string | null>(null);
const profileName = ref("新档案");
const dirty = ref(false);
const loading = ref(false);
const toast = useToast();
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
  clearPointHistory();
  activeGroupId.value = profile.value.classPlanGroups.some((group) => group.id === profile.value.selectedClassPlanGroupId)
    ? profile.value.selectedClassPlanGroupId
    : DEFAULT_CLASS_PLAN_GROUP_ID;
  activeLayoutId.value = profile.value.timeLayouts[0]?.id ?? "";
}

/** 把某份配置的当前修订套进编辑器：首屏载入和下拉切换共用。 */
function applyHistory(id: string, history: { documentJson: string }[] | null | undefined) {
  profile.value = readProfile(JSON.parse(history?.[0]?.documentJson ?? "{}") as unknown);
  activeId.value = id;
  profileName.value = configs.value.find((item) => item.configurationId === id)?.name ?? profile.value.name;
  resetSelection();
  dirty.value = false;
}

async function loadConfig(id: string) {
  if (!id) return;
  loading.value = true;
  try {
    applyHistory(id, await $fetch<{ documentJson: string }[]>(`/api/v1/admin/configurations/${id}/history`));
    toast.ok("已载入该配置的当前修订。");
  } catch (err) { toast.err(fail(err, "载入配置失败。")); }
  finally { loading.value = false; }
}

/**
 * 课表页只编辑课表列表挑定的那一份：?config=<id> 就在首屏前读好它的当前修订；
 * 没带（或那份已被删）就退回列表自己挑，绝不替用户默认摊开某张课表。
 * 放在 setup 末尾执行：载入会走 resetSelection，碰到的是后面才声明的响应式状态。
 */
async function applyInitialConfig() {
  const initialId = String(route.query.config ?? "");
  if (!profileConfigs.value.some((item) => item.configurationId === initialId)) {
    if (import.meta.client && initialId) toast.err("找不到这份课表，可能已经被删掉了。");
    await navigateTo("/configurations/profile", { replace: true });
    return;
  }
  const { data } = await useFetch<{ documentJson: string }[]>(`/api/v1/admin/configurations/${initialId}/history`, { key: "timetable-initial" });
  applyHistory(initialId, data.value);
}

function createBlank() {
  profile.value = starterProfile("新档案");
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
  } catch (err) { toast.err(fail(err, "无法解析这个文件，请确认是导出的课表文件。")); }
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
    toast.ok(`已保存为第 ${result.revision} 版。`);
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
  const layout: CiTimeLayout = { id: uuid(), name: `新时间表${profile.value.timeLayouts.length + 1}`, layouts: [], extra: {} };
  profile.value.timeLayouts.push(layout);
  activeLayoutId.value = layout.id;
  markDirty();
}
/** 对应原生「复制」：整份深拷贝一张当前时间表再改，不用从零编排。 */
function duplicateLayout() {
  const layout = activeLayout.value;
  if (!layout) return;
  const copy = JSON.parse(JSON.stringify({ ...layout, name: `${layout.name} 副本` })) as CiTimeLayout;
  copy.id = uuid();
  profile.value.timeLayouts.push(copy);
  activeLayoutId.value = copy.id;
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
/* —— ClassIsland 式时间点编辑（对齐原生时间表页：先选点，再顺延插入）—— */
/** 多选集合：末位为“主选”，驱动检查器、圆点与浮条；框选/Shift 点选改集合。 */
const selection = ref<number[]>([]);
const selectedPoint = computed<number | null>({
  get: () => (selection.value.length ? selection.value[selection.value.length - 1]! : null),
  set: (value) => { selection.value = value === null ? [] : [value]; },
});
const selectedSet = computed(() => new Set(selection.value));
function toggleSelect(index: number) {
  const at = selection.value.indexOf(index);
  if (at >= 0) selection.value.splice(at, 1);
  else selection.value.push(index);
}
const defaultClassMinutes = ref(40);
const defaultBreakMinutes = ref(10);
type PointSnapshot = { layouts: string; selected: number | null };
const pointUndo = ref<PointSnapshot[]>([]);
const pointRedo = ref<PointSnapshot[]>([]);

const selectedItem = computed<CiTimeLayoutItem | null>(() => {
  const items = activeLayout.value?.layouts ?? [];
  const at = selectedPoint.value;
  return at !== null && at >= 0 && at < items.length ? items[at]! : null;
});
const breakNameOptions = computed(() => {
  const names = new Set<string>();
  for (const layout of profile.value.timeLayouts)
    for (const item of layout.layouts)
      if (item.timeType === 1 && item.breakName.trim()) names.add(item.breakName.trim());
  return [...names];
});

const isMarker = (item: CiTimeLayoutItem) => item.timeType === 2 || item.timeType === 3;
function toMinutes(clock: string): number {
  const [h, m] = clock.split(":");
  return (Number(h) || 0) * 60 + (Number(m) || 0);
}
function fromMinutes(total: number): string {
  const clamped = Math.max(0, Math.min(23 * 60 + 59, Math.round(total)));
  return `${String(Math.floor(clamped / 60)).padStart(2, "0")}:${String(clamped % 60).padStart(2, "0")}`;
}
function typeLabel(value: number): string { return TIME_TYPES.find((type) => type.value === value)?.label ?? String(value); }
/** 该位置是第几节「上课」（0 起），与课表网格的行一一对应。 */
function periodOrdinal(index: number): number {
  const items = activeLayout.value?.layouts ?? [];
  return items.slice(0, index + 1).filter((item) => item.timeType === 0).length - 1;
}

function pushPointHistory() {
  const layout = activeLayout.value;
  if (!layout) return;
  pointUndo.value.push({ layouts: JSON.stringify(layout.layouts), selected: selectedPoint.value });
  if (pointUndo.value.length > 60) pointUndo.value.shift();
  pointRedo.value = [];
}
function restorePointSnapshot(target: "undo" | "redo") {
  const layout = activeLayout.value;
  if (!layout) return;
  const stack = target === "undo" ? pointUndo.value : pointRedo.value;
  const other = target === "undo" ? pointRedo.value : pointUndo.value;
  const snapshot = stack.pop();
  if (!snapshot) return;
  other.push({ layouts: JSON.stringify(layout.layouts), selected: selectedPoint.value });
  layout.layouts = JSON.parse(snapshot.layouts) as CiTimeLayoutItem[];
  selectedPoint.value = snapshot.selected;
  markDirty();
}
function clearPointHistory() {
  selectedPoint.value = null;
  pointUndo.value = [];
  pointRedo.value = [];
}
watch(baseLayoutId, clearPointHistory);

/**
 * 与原生 AddTimeLayoutItem 同规则：新点从选中点的结束时间起笔，长度取默认时长；
 * 有空间但不够则缩短。差别在「完全没缝」：原生直接拒绝，这里把后续时间点整体后移让位。
 */
function addPoint(timeType: number) {
  const layout = activeLayout.value;
  if (!layout) return;
  const items = layout.layouts;
  const selected = selectedItem.value;
  let base = selected ? toMinutes(selected.endTime) : 8 * 60;
  let length = timeType === 0 ? Math.max(1, defaultClassMinutes.value) : timeType === 1 ? Math.max(1, defaultBreakMinutes.value) : 0;
  let shiftTail = 0;
  if (selected) {
    const index = items.indexOf(selected);
    if (timeType !== 2 && timeType !== 3 && index < items.length - 1) {
      const next = items.slice(index + 1).find((item) => item.timeType !== 2);
      if (next) {
        const nextStart = toMinutes(next.startTime);
        if (nextStart <= base) {
          if (index !== 0) {
            const maxEnd = Math.max(...items.map((item) => toMinutes(item.endTime)));
            if (maxEnd + length > DAY_END) { toast.err("后面已经没有时间了。"); return; }
            shiftTail = length;
            toast.ok(`已将后续时间点整体后移 ${length} 分钟。`);
          } else {
            base = toMinutes(selected.startTime) - length;
            if (base < 0) { toast.err("没有合适的位置来插入新的时间点。"); return; }
            toast.ok("已向前插入了新的时间点。");
          }
        }
        if (!shiftTail && nextStart < base + length) {
          toast.ok("没有足够的空间完全插入该时间点，已缩短时间点长度。");
          length = Math.max(0, nextStart - base);
        }
      }
    }
    if (timeType === 2 || timeType === 3) {
      if (items.some((item) => item.timeType === timeType && toMinutes(item.startTime) === base)) {
        toast.err(timeType === 2 ? "这里已经存在一条分割线。" : "这里已经存在一个行动。");
        return;
      }
    }
  }
  if (base > DAY_END) { toast.err("后面已经没有时间了。"); return; }
  pushPointHistory();
  if (shiftTail) {
    for (const it of items) {
      if (toMinutes(it.startTime) >= base) {
        it.startTime = fromMinutes(toMinutes(it.startTime) + shiftTail);
        it.endTime = fromMinutes(toMinutes(it.endTime) + shiftTail);
      }
    }
  }
  const item: CiTimeLayoutItem = { startTime: fromMinutes(base), endTime: fromMinutes(base + length), timeType, breakName: "", isHideDefault: false, defaultClassId: "", extra: {} };
  const insertAt = items.findIndex((existing) => toMinutes(existing.startTime) > base);
  if (insertAt < 0) items.push(item);
  else items.splice(insertAt, 0, item);
  selectedPoint.value = insertAt < 0 ? items.length - 1 : insertAt;
  markDirty();
}

/** 创建副本：等长接到选中点后面，越界则钳到 23:59。 */
function duplicatePoint() {
  const layout = activeLayout.value;
  const selected = selectedItem.value;
  if (!layout || !selected) { toast.err("先选中一个时间点。"); return; }
  const base = toMinutes(selected.endTime);
  const length = Math.max(0, toMinutes(selected.endTime) - toMinutes(selected.startTime));
  if (base > 23 * 60 + 59) { toast.err("后面已经没有时间了。"); return; }
  const copy = JSON.parse(JSON.stringify(selected)) as CiTimeLayoutItem;
  copy.startTime = fromMinutes(base);
  copy.endTime = fromMinutes(Math.min(base + length, 23 * 60 + 59));
  pushPointHistory();
  const items = layout.layouts;
  const insertAt = items.findIndex((existing) => toMinutes(existing.startTime) > base);
  if (insertAt < 0) items.push(copy);
  else items.splice(insertAt, 0, copy);
  selectedPoint.value = insertAt < 0 ? items.length - 1 : insertAt;
  toast.ok("已创建时间点副本。");
  markDirty();
}

function deletePoint() {
  const layout = activeLayout.value;
  if (!layout || !selection.value.length) return;
  pushPointHistory();
  const doomed = new Set(selection.value);
  const first = Math.min(...doomed);
  layout.layouts = layout.layouts.filter((_, i) => !doomed.has(i));
  selectedPoint.value = layout.layouts.length ? Math.max(0, Math.min(first - 1, layout.layouts.length - 1)) : null;
  markDirty();
}

/** 对应原生「刷新」：手改时间后按开始时间重新排序。 */
function sortPoints() {
  const layout = activeLayout.value;
  if (!layout) return;
  pushPointHistory();
  layout.layouts.sort((a, b) => toMinutes(a.startTime) - toMinutes(b.startTime));
  selectedPoint.value = null;
  markDirty();
  toast.ok("已按开始时间重新排序。");
}

function setPointType(value: number) {
  const item = selectedItem.value;
  if (!item || item.timeType === value) return;
  item.timeType = value;
  if (isMarker(item)) item.endTime = item.startTime;
  markDirty();
}

/** 对应原生「覆盖现有课程」：把所有引用这张时间表的课表里该节的科目刷成默认课程。 */
function overwriteAllSubjects() {
  const layout = activeLayout.value;
  const item = selectedItem.value;
  const at = selectedPoint.value;
  if (!layout || !item || at === null) return;
  if (!item.defaultClassId) { toast.err("先选一个默认课程。"); return; }
  const ordinal = periodOrdinal(at);
  const subjectLabelValue = subjectName(profile.value, item.defaultClassId);
  pending.value = {
    title: "覆盖现有课程",
    description: `把所有引用「${layout.name}」的课表中第 ${ordinal + 1} 节的科目改为「${subjectLabelValue}」？`,
    confirmText: "覆盖", danger: true, run: () => runOverwrite(layout.id, ordinal, item.defaultClassId),
  };
}
function runOverwrite(layoutId: string, ordinal: number, subjectId: string) {
  let touched = 0;
  for (const plan of profile.value.classPlans) {
    if (plan.timeLayoutId !== layoutId) continue;
    const info = plan.classes[ordinal];
    if (info) { info.subjectId = subjectId; touched += 1; }
  }
  toast.ok(touched ? `已覆盖 ${touched} 张课表的第 ${ordinal + 1} 节。` : "没有引用这张时间表的课表。");
  markDirty();
}

/** 键盘习惯照搬原生：↑/↓ 换选（首尾环绕）、Delete 删除、Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y 撤销重做。 */
function onPointKeydown(event: KeyboardEvent) {
  if (tab.value !== "layouts" || pending.value) return;
  const target = event.target as HTMLElement | null;
  if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
  const items = activeLayout.value?.layouts ?? [];
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    if (!items.length) return;
    event.preventDefault();
    const at = selectedPoint.value;
    const delta = event.key === "ArrowDown" ? 1 : -1;
    selectedPoint.value = at === null
      ? (event.key === "ArrowDown" ? 0 : items.length - 1)
      : (at + delta + items.length) % items.length;
    return;
  }
  if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "z") {
    event.preventDefault();
    restorePointSnapshot(event.shiftKey ? "redo" : "undo");
    return;
  }
  if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "y") {
    event.preventDefault();
    restorePointSnapshot("redo");
    return;
  }
  if ((event.key === "Delete" || event.key === "Backspace") && selectedPoint.value !== null) {
    event.preventDefault();
    deletePoint();
  }
}
onMounted(() => window.addEventListener("keydown", onPointKeydown));
onBeforeUnmount(() => window.removeEventListener("keydown", onPointKeydown));
watch([defaultClassMinutes, defaultBreakMinutes], () => {
  if (import.meta.client) localStorage.setItem("classisland-control-timetable-point-minutes", `${defaultClassMinutes.value},${defaultBreakMinutes.value}`);
});

/* —— 时间轴画布：照搬原生 TimeLineListControl 的块拖拽交互 ——
 * 竖轴固定 0–24 时，px/分 = 1.8（原生默认 Scale=3）；
 * 拖动一律落到 5 分钟绝对网格；「吸附」= 原生时间点吸附：改边/平移时相邻点跟着走。 */
const stickyPoints = ref(true);
const showAddFlyout = ref(true);
const tlScroll = ref<HTMLElement>();
watch(selectedPoint, () => { showAddFlyout.value = true; });

const pxPerMin = 0.6 * 3;
const RULER_LABEL_MIN = 30;
const RULER_LINE_MIN = 15;
const rulerLabels = computed(() => {
  const out: number[] = [];
  for (let v = 0; v < 24 * 60; v += RULER_LABEL_MIN) out.push(v);
  return out;
});
const canvasStyle = computed(() => ({
  height: `${1440 * pxPerMin}px`,
  "--tl-grid": `repeating-linear-gradient(to bottom, var(--line-soft) 0 1px, transparent 1px ${RULER_LINE_MIN * pxPerMin}px)`,
}));

const yOf = (clock: string) => toMinutes(clock) * pxPerMin;
function blockHeight(item: CiTimeLayoutItem) {
  return isMarker(item) ? 6 : Math.max((toMinutes(item.endTime) - toMinutes(item.startTime)) * pxPerMin, 1);
}
function blockStyle(item: CiTimeLayoutItem) {
  return { top: `${yOf(item.startTime)}px`, height: `${blockHeight(item)}px` };
}
function durationText(item: CiTimeLayoutItem) {
  const total = toMinutes(item.endTime) - toMinutes(item.startTime);
  return total >= 60 ? `${Math.floor(total / 60)} 时 ${total % 60} 分` : `${total} 分`;
}

/** prev/next 取跳过分割线与行动的最近上课/课间点，同原生 Prev/NextTimePoint。 */
function timeNeighbors(index: number) {
  const items = activeLayout.value?.layouts ?? [];
  let prev: CiTimeLayoutItem | null = null;
  let next: CiTimeLayoutItem | null = null;
  for (let i = index - 1; i >= 0; i -= 1) { const it = items[i]; if (it && !isMarker(it)) { prev = it; break; } }
  for (let i = index + 1; i < items.length; i += 1) { const it = items[i]; if (it && !isMarker(it)) { next = it; break; } }
  return { prev, next };
}
/** 钉在原边界上的标记随边界一起挪（原生 DragAdjoiningSeparator）。 */
function dragAdjoiningMarkers(oldClock: string, newClock: string) {
  const layout = activeLayout.value;
  if (!layout || oldClock === newClock) return;
  for (const marker of layout.layouts)
    if (isMarker(marker) && marker.startTime === oldClock) { marker.startTime = newClock; marker.endTime = newClock; }
}

const DAY_END = 23 * 60 + 59;
const snap5 = (min: number) => Math.round(min / 5) * 5;
const clampMin = (min: number) => Math.max(0, Math.min(DAY_END, min));

type DragMode = "move" | "start" | "end" | "marker";
let drag: {
  mode: DragMode;
  /** 参与本次拖动的全部下标（多选整组平移时 >1），anchor 为按下的那块。 */
  indexes: number[];
  anchor: number;
  pointerId: number;
  startY: number;
  orig: Map<CiTimeLayoutItem, [number, number]>;
  historyPushed: boolean;
  moved: boolean;
} | null = null;

/** 组内平移时找“集合外”的相邻点：跳过选中的与分割线/行动。 */
function outerNeighbor(index: number, dir: -1 | 1, skip: Set<number>): CiTimeLayoutItem | null {
  const items = activeLayout.value?.layouts ?? [];
  for (let i = index + dir; i >= 0 && i < items.length; i += dir) {
    if (skip.has(i)) continue;
    const it = items[i]!;
    if (!isMarker(it)) return it;
  }
  return null;
}

function startDrag(event: PointerEvent, index: number, mode: DragMode) {
  const layout = activeLayout.value;
  const item = layout?.layouts[index];
  if (!layout || !item) return;
  if (!selection.value.includes(index)) selection.value = [index];
  const indexes = mode === "move" && selection.value.length > 1 ? [...selection.value] : [index];
  const orig = new Map<CiTimeLayoutItem, [number, number]>();
  for (const i of indexes) {
    const it = layout.layouts[i];
    if (it) orig.set(it, [toMinutes(it.startTime), toMinutes(it.endTime)]);
  }
  drag = { mode, indexes, anchor: index, pointerId: event.pointerId, startY: event.clientY, orig, historyPushed: false, moved: false };
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  event.preventDefault();
}
function onBlockPointerDown(event: PointerEvent, index: number, mode: DragMode) {
  if (event.shiftKey) {
    toggleSelect(index);
    return;
  }
  startDrag(event, index, mode);
}

/** 多选整组平移：每块独立吸附到 5 分钟网格、保时长；任一成员越界或撞集合外邻居则整体不动。 */
function dragGroupMove(deltaMin: number) {
  const layout = activeLayout.value;
  if (!layout || !drag) return;
  const skip = new Set(drag.indexes);
  const moves: { item: CiTimeLayoutItem; start: number; end: number }[] = [];
  for (const i of drag.indexes) {
    const it = layout.layouts[i];
    const o = it ? drag.orig.get(it) : undefined;
    if (!it || !o) return;
    const start = clampMin(snap5(o[0] + deltaMin));
    const end = start + (o[1] - o[0]);
    if (end > DAY_END) return;
    moves.push({ item: it, start, end });
  }
  for (const m of moves) {
    const idx = layout.layouts.indexOf(m.item);
    const prev = outerNeighbor(idx, -1, skip);
    const next = outerNeighbor(idx, 1, skip);
    if (prev && toMinutes(prev.endTime) > m.start) return;
    if (next && toMinutes(next.startTime) < m.end) return;
  }
  for (const m of moves) {
    const oldStart = m.item.startTime;
    const oldEnd = m.item.endTime;
    m.item.startTime = fromMinutes(m.start);
    m.item.endTime = fromMinutes(m.end);
    dragAdjoiningMarkers(oldStart, m.item.startTime);
    dragAdjoiningMarkers(oldEnd, m.item.endTime);
  }
}

function onDragMove(event: PointerEvent) {
  if (!drag || event.pointerId !== drag.pointerId) return;
  const layout = activeLayout.value;
  const item = layout?.layouts[drag.anchor];
  if (!layout || !item) return;
  const deltaMin = (event.clientY - drag.startY) / pxPerMin;
  if (!drag.moved && Math.abs(deltaMin) < 1) return;
  // 一次拖动 = 一条撤销记录，且快照必须在首次改动前压入。
  if (!drag.historyPushed) { pushPointHistory(); drag.historyPushed = true; }
  drag.moved = true;

  if (drag.mode === "marker") {
    const at = fromMinutes(clampMin(snap5(drag.orig.get(item)![0] + deltaMin)));
    item.startTime = at;
    item.endTime = at;
    return;
  }
  if (drag.mode === "move" && drag.indexes.length > 1) {
    dragGroupMove(deltaMin);
    return;
  }
  const [origStart, origEnd] = drag.orig.get(item)!;
  let newStart: number;
  let newEnd: number;
  if (drag.mode === "move") {
    const duration = origEnd - origStart;
    newStart = clampMin(snap5(origStart + deltaMin));
    newEnd = newStart + duration;
    if (newEnd > DAY_END) return;
  } else if (drag.mode === "start") {
    newStart = clampMin(snap5(origStart + deltaMin));
    newEnd = toMinutes(item.endTime);
    if (newStart >= newEnd) return;
  } else {
    newStart = toMinutes(item.startTime);
    newEnd = clampMin(snap5(origEnd + deltaMin));
    if (newEnd <= newStart) return;
  }
  const { prev, next } = timeNeighbors(drag.anchor);
  const sticky = stickyPoints.value;
  if (prev && newStart < toMinutes(prev.endTime)) {
    if (!sticky || toMinutes(prev.startTime) >= newStart) return;
    prev.endTime = fromMinutes(newStart);
  }
  if (next && newEnd > toMinutes(next.startTime)) {
    if (!sticky || toMinutes(next.endTime) <= newEnd) return;
    next.startTime = fromMinutes(newEnd);
  }
  const oldStart = item.startTime;
  const oldEnd = item.endTime;
  item.startTime = fromMinutes(newStart);
  item.endTime = fromMinutes(newEnd);
  dragAdjoiningMarkers(oldStart, item.startTime);
  dragAdjoiningMarkers(oldEnd, item.endTime);
}
function endDrag(event: PointerEvent) {
  if (!drag || event.pointerId !== drag.pointerId) return;
  const layout = activeLayout.value;
  // 原生在分割线/行动落位后自动归位排序。
  if (layout && drag.mode === "marker" && drag.moved) {
    const items = layout.layouts;
    const movedItem = items.splice(drag.anchor, 1)[0];
    if (movedItem) {
      const at = items.findIndex((existing) => toMinutes(existing.startTime) > toMinutes(movedItem.startTime));
      if (at < 0) { items.push(movedItem); selectedPoint.value = items.length - 1; }
      else { items.splice(at, 0, movedItem); selectedPoint.value = at; }
    }
  }
  if (drag.moved) markDirty();
  drag = null;
}

/* —— 空白处拖框选：与块的时间范围纵向相交即选中；拖到上下边缘时自动滚动 —— */
const marquee = ref<{ x0: number, y0: number, x1: number, y1: number } | null>(null);
let marqueePointerId: number | null = null;
let marqueeCanvas: HTMLElement | null = null;
let marqueeClientY = 0;
let marqueeTimer: ReturnType<typeof setTimeout> | null = null;
const MARQUEE_EDGE = 36;
function canvasPoint(event: PointerEvent) {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}
function stopMarqueeLoop() {
  if (marqueeTimer) clearTimeout(marqueeTimer);
  marqueeTimer = null;
  marqueeCanvas = null;
}
onUnmounted(stopMarqueeLoop);
function marqueeTick() {
  marqueeTimer = null;
  const scroller = tlScroll.value;
  if (!marquee.value || !scroller || !marqueeCanvas) return;
  const box = scroller.getBoundingClientRect();
  let delta = 0;
  if (marqueeClientY < box.top + MARQUEE_EDGE) delta = -Math.min(16, (box.top + MARQUEE_EDGE - marqueeClientY) / 2);
  else if (marqueeClientY > box.bottom - MARQUEE_EDGE) delta = Math.min(16, (marqueeClientY - (box.bottom - MARQUEE_EDGE)) / 2);
  if (delta) {
    const max = scroller.scrollHeight - scroller.clientHeight;
    const next = Math.max(0, Math.min(max, scroller.scrollTop + delta));
    if (next !== scroller.scrollTop) {
      scroller.scrollTop = next;
      // 指针没动但画布在动：按保存的屏幕坐标重算框选终点。
      const rect = marqueeCanvas.getBoundingClientRect();
      marquee.value = { ...marquee.value, y1: marqueeClientY - rect.top };
    }
  }
  marqueeTimer = setTimeout(marqueeTick, 16);
}
function onCanvasPointerDown(event: PointerEvent) {
  const at = canvasPoint(event);
  marquee.value = { x0: at.x, y0: at.y, x1: at.x, y1: at.y };
  marqueePointerId = event.pointerId;
  marqueeCanvas = event.currentTarget as HTMLElement;
  marqueeClientY = event.clientY;
  // 先挂循环再抓指针：setPointerCapture 对失效指针会抛错，不能让滚动因此失联。
  marqueeTimer = setTimeout(marqueeTick, 16);
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}
function onCanvasPointerMove(event: PointerEvent) {
  if (!marquee.value || event.pointerId !== marqueePointerId) return;
  const at = canvasPoint(event);
  marqueeClientY = event.clientY;
  marquee.value = { ...marquee.value, x1: at.x, y1: at.y };
}
function onCanvasPointerUp(event: PointerEvent) {
  if (!marquee.value || event.pointerId !== marqueePointerId) return;
  const m = marquee.value;
  marquee.value = null;
  marqueePointerId = null;
  stopMarqueeLoop();
  if (Math.abs(m.x1 - m.x0) < 4 && Math.abs(m.y1 - m.y0) < 4) {
    selectedPoint.value = null;
    return;
  }
  const canvas = event.currentTarget as HTMLElement;
  const rect = canvas.getBoundingClientRect();
  const top = Math.min(m.y0, m.y1);
  const bottom = Math.max(m.y0, m.y1);
  const hits: number[] = [];
  for (const el of canvas.querySelectorAll<HTMLElement>(".tl-block[data-index]")) {
    const box = el.getBoundingClientRect();
    if (box.bottom - rect.top > top && box.top - rect.top < bottom) {
      const idx = Number(el.dataset.index);
      if (Number.isInteger(idx)) hits.push(idx);
    }
  }
  // 反序写入让最早的时间块成为主选。
  selection.value = hits.reverse();
}
const marqueeStyle = computed(() => {
  const m = marquee.value;
  if (!m) return {};
  return {
    left: `${Math.min(m.x0, m.x1)}px`,
    top: `${Math.min(m.y0, m.y1)}px`,
    width: `${Math.abs(m.x1 - m.x0)}px`,
    height: `${Math.abs(m.y1 - m.y0)}px`,
  };
});

/** 进画布先滚到第一节附近，不用手动往上找。 */
watch([tab, baseLayoutId], async () => {
  if (tab.value !== "layouts") return;
  await nextTick();
  const first = activeLayout.value?.layouts[0];
  if (tlScroll.value) tlScroll.value.scrollTop = Math.max(0, yOf(first?.startTime ?? "07:00") - 60);
});

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
  pushPointHistory();
  activeLayout.value.layouts = standardLayoutItems();
  clearPointHistoryAfterStandard();
  markDirty();
}
/** 标准作息整份替换后旧序号没意义，但保留一次撤销入口。 */
function clearPointHistoryAfterStandard() {
  selectedPoint.value = null;
  pointRedo.value = [];
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

onMounted(() => {
  autoNext.value = localStorage.getItem("classisland-control-timetable-auto-next") !== "0";
  const [savedClass, savedBreak] = (localStorage.getItem("classisland-control-timetable-point-minutes") ?? "").split(",").map(Number);
  if (savedClass && Number.isFinite(savedClass) && savedBreak && Number.isFinite(savedBreak)) {
    defaultClassMinutes.value = savedClass;
    defaultBreakMinutes.value = savedBreak;
  }
});

await applyInitialConfig();
</script>

<template>
  <PageHeading kicker="可视化排课" title="课表">
    <button type="button" class="ghost" @click="showQuick = true">快装</button>
    <button type="button" class="ghost" @click="fileInput?.click()">导入档案</button>
    <button type="button" class="ghost" @click="createBlank">新建空档案</button>
    <button type="button" class="solid" :disabled="loading" @click="save">保存为新修订</button>
    <input ref="fileInput" hidden type="file" accept="application/json,.json" @change="importFile">
  </PageHeading>

  <QuickSetupDialog
    v-if="showQuick"
    :profile="profile"
    :layout-id="baseLayoutId"
    :group-id="activeGroupId"
    @applied="markDirty"
    @close="showQuick = false"
  />

  <section class="toolbar profile-bar">
    <label>档案配置
      <select :value="activeId ?? ''" @change="loadConfig(($event.target as HTMLSelectElement).value)">
        <option value="">（未保存的新档案）</option>
        <option v-for="item in profileConfigs" :key="item.configurationId" :value="item.configurationId">{{ item.name }} · {{ revisionLabel(item.currentRevision) }}</option>
      </select>
    </label>
    <label>档案名称<input v-model="profileName" @input="markDirty"></label>
    <span class="badge" :data-dirty="dirty">{{ dirty ? "有未保存修改" : "已同步" }}</span>
    <span class="micro">{{ profile.subjects.length }} 个科目 · {{ profile.timeLayouts.length }} 张时间表 · {{ profile.classPlans.length }} 张课表</span>
  </section>

  <PageTabs v-model="tab" :items="tabs" />

  <section v-if="tab === 'timetable'">
    <header class="panel-head toolbar">
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
    <header class="panel-head toolbar">
      <label>编辑时间表<select v-model="baseLayoutId"><option v-for="layout in profile.timeLayouts" :key="layout.id" :value="layout.id">{{ layout.name }}</option></select></label>
      <button type="button" @click="addLayout">新增时间表</button>
      <button type="button" @click="duplicateLayout">复制时间表</button>
      <button type="button" @click="applyStandardTemplate">生成标准作息</button>
      <button type="button" class="danger" @click="activeLayout && removeLayout(activeLayout.id)">删除当前时间表</button>
    </header>
    <template v-if="activeLayout">
      <label class="layout-name">时间表名称<input v-model="activeLayout.name" maxlength="40" @input="markDirty"></label>
      <div class="point-tools toolbar">
        <div class="seg" aria-label="添加时间点">
          <button type="button" title="在选中时间点之后接一节课" @click="addPoint(0)">上课</button>
          <button type="button" title="在选中时间点之后接一段课间" @click="addPoint(1)">课间</button>
          <button type="button" title="零长度标记，用来分隔上午/下午" @click="addPoint(2)">分割线</button>
          <button type="button" title="零长度标记，到点触发一组行动" @click="addPoint(3)">行动</button>
        </div>
        <div class="seg" aria-label="时间点操作">
          <button type="button" :disabled="!selectedItem" @click="duplicatePoint">创建副本</button>
          <button type="button" :disabled="!pointUndo.length" @click="restorePointSnapshot('undo')">撤销</button>
          <button type="button" :disabled="!pointRedo.length" @click="restorePointSnapshot('redo')">重做</button>
          <button type="button" :disabled="!selectedItem" class="danger" @click="deletePoint">删除</button>
          <button type="button" title="按开始时间重新排序" @click="sortPoints">刷新排序</button>
        </div>
        <div class="point-length">
          <label>默认上课（分）<input v-model.number="defaultClassMinutes" type="number" min="1" max="600"></label>
          <label>默认课间（分）<input v-model.number="defaultBreakMinutes" type="number" min="1" max="600"></label>
          <label class="check"><input v-model="stickyPoints" type="checkbox">时间点吸附</label>
        </div>
      </div>
      <div class="point-body">
        <div ref="tlScroll" class="tl-scroll">
          <div class="tl-canvas" :style="canvasStyle" @pointerdown.self="onCanvasPointerDown" @pointermove.self="onCanvasPointerMove" @pointerup.self="onCanvasPointerUp" @pointercancel.self="onCanvasPointerUp">
            <span v-for="label in rulerLabels" :key="label" class="tl-label" :style="{ top: `${label * pxPerMin}px` }">{{ fromMinutes(label) }}</span>
            <div
              v-for="(item, index) in activeLayout.layouts"
              :key="index"
              class="tl-block"
              :data-index="index"
              :data-type="item.timeType"
              :data-active="selectedSet.has(index)"
              :style="blockStyle(item)"
              :title="`${typeLabel(item.timeType)} ${item.startTime}–${item.endTime}`"
              @pointerdown="onBlockPointerDown($event, index, isMarker(item) ? 'marker' : 'move')"
              @pointermove="onDragMove"
              @pointerup="endDrag"
              @pointercancel="endDrag"
            >
              <span v-if="blockHeight(item) >= 18" class="tl-text">
                <strong>{{ item.timeType === 0 ? `第 ${periodOrdinal(index) + 1} 节 · ` : "" }}{{ item.startTime }} – {{ item.endTime }}</strong>
                <small>{{ item.timeType === 1 ? (item.breakName || "课间休息") : durationText(item) }}</small>
              </span>
              <template v-if="index === selectedPoint">
                <template v-if="!isMarker(item)">
                  <span class="tl-thumb" data-edge="top" @pointerdown.stop="startDrag($event, index, 'start')" @pointermove="onDragMove" @pointerup="endDrag" @pointercancel="endDrag"></span>
                  <span class="tl-thumb" data-edge="bottom" @pointerdown.stop="startDrag($event, index, 'end')" @pointermove="onDragMove" @pointerup="endDrag" @pointercancel="endDrag"></span>
                </template>
                <button type="button" class="tl-del" @pointerdown.stop @click.stop="deletePoint">删除</button>
              </template>
            </div>
            <div v-if="selection.length === 1 && selectedItem && !isMarker(selectedItem) && showAddFlyout" class="tl-flyout" :style="{ top: `${yOf(selectedItem.endTime) + 10}px` }">
              <span class="tl-flyout-label">添加</span>
              <button type="button" :data-suggest="selectedItem.timeType === 1 ? 'true' : 'false'" @click="addPoint(0)">上课</button>
              <button type="button" :data-suggest="selectedItem.timeType === 0 ? 'true' : 'false'" @click="addPoint(1)">课间</button>
              <button type="button" class="ghost" title="收起" @click="showAddFlyout = false">×</button>
            </div>
            <div v-if="marquee" class="tl-marquee" :style="marqueeStyle"></div>
            <p v-if="!activeLayout.layouts.length" class="tl-empty">还没有时间点。</p>
          </div>
        </div>
        <aside class="inspector">
          <h3>编辑时间点</h3>
          <template v-if="selectedItem">
            <label>开始时间<input v-model="selectedItem.startTime" type="time" @change="markDirty"></label>
            <label v-if="selectedItem.timeType !== 2 && selectedItem.timeType !== 3">结束时间<input v-model="selectedItem.endTime" type="time" @change="markDirty"></label>
            <div class="seg chips-type">
              <button v-for="type in TIME_TYPES.slice(0, 2)" :key="type.value" type="button" :data-active="selectedItem.timeType === type.value" @click="setPointType(type.value)">{{ type.label }}</button>
            </div>
            <template v-if="selectedItem.timeType === 0">
              <label class="check"><input v-model="selectedItem.isHideDefault" type="checkbox" @change="markDirty">默认隐藏</label>
              <p class="tip">默认隐藏后，只有正处在这个时间点时它才会显示。</p>
              <label>默认课程
                <select v-model="selectedItem.defaultClassId" @change="markDirty">
                  <option value="">（不设置）</option>
                  <option v-for="subject in profile.subjects" :key="subject.id" :value="subject.id">{{ subject.name }}</option>
                </select>
              </label>
              <button type="button" :disabled="!selectedItem.defaultClassId" @click="overwriteAllSubjects">覆盖现有课程</button>
            </template>
            <label v-else-if="selectedItem.timeType === 1">课间名称<input v-model="selectedItem.breakName" list="break-name-options" maxlength="30" @input="markDirty"></label>
          </template>
          <p v-else class="muted">未选中时间点。</p>
          <datalist id="break-name-options"><option v-for="name in breakNameOptions" :key="name" :value="name"></option></datalist>
        </aside>
      </div>
      <p class="stat">共 {{ activeLayout.layouts.length }} 个时间点 · {{ periods.length }} 节“上课”</p>
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
.profile-bar select { min-width: 220px; }
.profile-bar input { min-width: 200px; }
.badge { border: 1px solid var(--line); color: var(--ink-muted); font-size: 10px; letter-spacing: 0.8px; }
.badge[data-dirty="true"] { border-color: var(--accent); color: var(--accent); }
.panel-head { padding-bottom: 18px; border-bottom: 1px solid var(--line-strong); }
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
.hint, .muted { color: var(--ink-muted); font-size: 12px; line-height: 1.8; }
.hint { margin-top: 16px; }
.stat { margin: 14px 0 0; color: var(--ink-muted); font-size: 11px; letter-spacing: 0.6px; }

/* 时间点编辑工具条：分组按钮（.seg 全局样式）+ 默认时长。 */
.point-tools { margin-top: 20px; margin-bottom: 0; }
.point-length { display: flex; gap: 14px; margin-left: auto; }
.point-length label { display: grid; gap: 8px; width: 132px; color: var(--ink-muted); font-size: 11px; letter-spacing: 0.6px; }
.point-length input { width: 100%; }

/* 左侧时间轴画布 + 右侧检查器。 */
.point-body { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: 22px; align-items: start; margin-top: 20px; }
.point-length label.check { display: flex; align-items: center; gap: 8px; width: auto; padding-bottom: 8px; font-size: 12px; color: var(--ink-soft); }

/* 时间轴画布：固定 24 小时竖轴，时间点是可拖的块（照搬原生 TimeLineListControl）。 */
.tl-scroll { position: relative; max-height: 68vh; overflow: auto; border-top: 1px solid var(--line-strong); }
.tl-canvas { position: relative; }
.tl-canvas::before { content: ""; position: absolute; inset: 0 0 0 52px; background-image: var(--tl-grid); }
.tl-label { position: absolute; left: 0; width: 44px; padding-right: 8px; transform: translateY(-50%); color: var(--ink-faint); font-size: 10px; font-variant-numeric: tabular-nums; text-align: right; pointer-events: none; }
.tl-block {
  position: absolute;
  left: 56px;
  right: 16px;
  padding: 2px 10px;
  text-align: left;
  cursor: grab;
  user-select: none;
}
.tl-block:active { cursor: grabbing; }
.tl-block[data-type="0"] { background: var(--accent-wash-strong); border-left: 4px solid var(--accent); }
.tl-block[data-type="1"] { background: var(--surface-2); border-left: 4px solid var(--line-strong); color: var(--ink-soft); }
.tl-block[data-type="2"], .tl-block[data-type="3"] { padding: 0; background: repeating-linear-gradient(45deg, #8a857a 0 5px, #b8b2a4 5px 10px); cursor: move; }
.tl-block[data-type="3"] { background: repeating-linear-gradient(45deg, #56604a 0 5px, #8fa07e 5px 10px); }
.tl-block[data-active="true"] { box-shadow: inset 0 0 0 2px var(--focus); z-index: 4; }
.tl-marquee { position: absolute; z-index: 7; border: 1px solid var(--accent); background: var(--accent-wash); opacity: 0.55; pointer-events: none; }
.tl-text { display: block; overflow: hidden; white-space: nowrap; }
.tl-text strong { display: block; font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums; }
.tl-text small { display: block; color: var(--ink-muted); font-size: 10px; }
.tl-thumb { position: absolute; left: 50%; width: 14px; height: 14px; transform: translate(-50%, -50%); border: 2px solid var(--accent); border-radius: 50%; background: var(--accent-ink); cursor: ns-resize; z-index: 5; }
.tl-thumb[data-edge="top"] { top: 0; }
.tl-thumb[data-edge="bottom"] { top: 100%; }
.tl-del { position: absolute; right: 10px; top: 50%; transform: translateY(-50%); min-height: 26px; padding: 0 10px; border: 0; background: var(--serious); color: var(--accent-ink); font-size: 11px; z-index: 5; }
.tl-del:hover { border: 0; background: var(--critical); color: var(--accent-ink); }
.tl-flyout { position: absolute; left: 56px; right: 16px; display: flex; justify-content: center; align-items: center; gap: 6px; padding: 5px 8px; border: 1px solid var(--line); background: var(--surface-glass); box-shadow: var(--shadow-pop); z-index: 6; }
.tl-flyout-label { margin-right: 4px; color: var(--ink-muted); font-size: 11px; }
.tl-flyout button { min-height: 26px; padding: 0 10px; font-size: 11px; }
.tl-flyout button[data-suggest="true"] { border-color: var(--accent); color: var(--accent-strong); }
.tl-empty { position: absolute; top: 90px; left: 0; right: 0; text-align: center; color: var(--ink-muted); font-size: 12px; }

.inspector { display: grid; gap: 16px; padding: 22px; border: 1px solid var(--line-soft); background: var(--surface-1); position: sticky; top: 22px; }
.inspector h3 { margin: 0; color: var(--ink-muted); font-size: 10px; font-weight: 400; letter-spacing: 1.2px; }
.inspector label { display: grid; gap: 7px; color: var(--ink-muted); font-size: 11px; letter-spacing: 0.6px; }
.inspector input, .inspector select { width: 100%; }
.inspector label.check { display: flex; align-items: center; gap: 9px; font-size: 12px; }
.inspector label.check input { width: 18px; height: 18px; }
.tip { margin: 0; color: var(--ink-faint); font-size: 11px; line-height: 1.7; }
@media (max-width: 1080px) {
  .board { grid-template-columns: 1fr; }
  .point-body { grid-template-columns: 1fr; }
  .inspector { position: static; }
  .point-length { margin-left: 0; }
  .row { flex-wrap: wrap; }
  .row label { flex: 1 1 160px; }
}
</style>