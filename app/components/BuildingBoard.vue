<script setup lang="ts">
type Building = { id: string; name: string; sortOrder: number };
type Floor = { id: string; buildingId: string; name: string; level: number; sortOrder: number };
type Room = { id: string; floorId: string; name: string; sortOrder: number; deviceIds: string[] };
type DeviceLite = { id: string; name: string; online: boolean; disabled: boolean; orgName: string };
type Kind = "buildings" | "floors" | "rooms";

const props = withDefaults(defineProps<{
  buildings: Building[];
  floors: Floor[];
  rooms: Room[];
  devices: DeviceLite[];
  selectedIds: string[];
  /** 被全校 / 组织 / 标签这类范围盖住的设备：显示成已选，但逐台取消表达不出来。 */
  lockedIds?: Set<string>;
  selectable?: boolean;
}>(), { selectable: true, lockedIds: () => new Set<string>() });
const emit = defineEmits<{ toggle: [ids: string[]]; marquee: [ids: string[], additive: boolean]; openRoom: [id: string]; inspect: [id: string]; changed: [] }>();
/** 当前楼栋由页面持有：工具栏的「全选本楼栋」要知道看的是哪一栋。 */
const activeId = defineModel<string | null>("activeBuilding", { default: null });
const toast = useToast();
const { can } = useSession();
/** 楼栋结构增删改走的是 devices.write，没这条权限的账号点了只会拿到 403。 */
const canEdit = computed(() => can("devices.write"));

const active = computed(() => props.buildings.find((building) => building.id === activeId.value) ?? null);
watch(
  () => props.buildings,
  (list) => {
    if (!list.length) { activeId.value = null; return; }
    if (!list.some((building) => building.id === activeId.value)) activeId.value = list[0]!.id;
  },
  { immediate: true },
);
const deviceById = computed(() => new Map(props.devices.map((device) => [device.id, device])));
const floors = computed(() => props.floors.filter((floor) => floor.buildingId === active.value?.id));
const roomsOf = (floorId: string) => props.rooms.filter((room) => room.floorId === floorId);
const floorDeviceIds = (floorId: string) => roomsOf(floorId).flatMap((room) => room.deviceIds);
const roomDevices = (room: Room) =>
  room.deviceIds.map((id) => deviceById.value.get(id)).filter((device): device is DeviceLite => !!device);
const onlineCount = (ids: string[]) => ids.filter((id) => deviceById.value.get(id)?.online).length;
/** 勾选只管已知且启用的设备：停用设备既不算全选也不算半选。 */
const pickable = (ids: string[]) => ids.filter((id) => deviceById.value.get(id)?.disabled === false);
const allSelected = (ids: string[]) => { const list = pickable(ids); return list.length > 0 && list.every((id) => props.selectedIds.includes(id)); };
const someSelected = (ids: string[]) => { const list = pickable(ids); return !allSelected(list) && list.some((id) => props.selectedIds.includes(id)); };
/** 整组都被范围（全校 / 组织 / 标签）盖住：已经是选中状态，逐台取消在这份目标里表达不出来。 */
const scopeLocked = (ids: string[]) => { const list = pickable(ids); return list.length > 0 && list.every((id) => props.lockedIds.has(id)); };
/** 卡片那一下：能改勾选就改勾选，被范围盖住或本来不可选时退回打开教室，别点成没反应。 */
function onRoomClick(room: Room) {
  if (props.selectable && !scopeLocked(room.deviceIds)) emit("toggle", pickable(room.deviceIds));
  else emit("openRoom", room.id);
}

/** 增删改都直接在看板上就地完成，不再进二级弹窗里找按钮。 */
const creating = ref<{ kind: Kind; parentId: string | null } | null>(null);
const createName = ref("");
const editing = ref<{ kind: Kind; id: string; name: string } | null>(null);
const editName = ref("");
const pendingDelete = ref<{ kind: Kind; id: string; name: string } | null>(null);
const busy = ref(false);

const kindLabel = (kind: Kind) => (kind === "buildings" ? "楼栋" : kind === "floors" ? "楼层" : "教室");
const isEditing = (kind: Kind, id: string) => editing.value?.kind === kind && editing.value.id === id;
const isCreating = (kind: Kind, parentId?: string | null) =>
  creating.value?.kind === kind && (!parentId || creating.value.parentId === parentId);
const deleteHint = computed(() => {
  const target = pendingDelete.value;
  if (!target) return "";
  const label = kindLabel(target.kind);
  if (target.kind === "rooms") return `教室「${target.name}」会被删除，其中的设备回到未分配状态，设备本身不受影响。`;
  return `${label}「${target.name}」及其下所有教室与设备分配会一并移除，设备本身不受影响。`;
});

function setCreateInput(element: unknown) { (element as HTMLInputElement | null)?.focus(); }
function setEditInput(element: unknown) { (element as HTMLInputElement | null)?.focus(); }

/** 动态 URL 无法被 Nuxt 的按路由推断收敛，退回普通签名以免类型实例化过深。 */
const plainFetch = $fetch as unknown as <T>(url: string, options?: Record<string, unknown>) => Promise<T>;

async function call<T>(url: string, method: "POST" | "PATCH" | "DELETE", body?: unknown): Promise<T | null> {
  busy.value = true;
  try {
    const result = await plainFetch<T>(url, { method, headers: { origin: location.origin }, body });
    emit("changed");
    return result;
  } catch (error) {
    toast.err((error as { data?: { message?: string } })?.data?.message ?? "操作失败。");
    return null;
  } finally {
    busy.value = false;
  }
}

function startCreate(kind: Kind, parentId: string | null = null) {
  editing.value = null;
  creating.value = { kind, parentId };
  createName.value = "";
}
function cancelCreate() { creating.value = null; createName.value = ""; }
async function commitCreate() {
  const current = creating.value;
  if (!current) return;
  const name = createName.value.trim();
  cancelCreate();
  if (!name) return;
  const body = current.kind === "buildings" ? { name }
    : current.kind === "floors" ? { buildingId: current.parentId, name }
    : { floorId: current.parentId, name };
  const created = await call<{ id: string }>(`/api/v1/admin/layout/${current.kind}`, "POST", body);
  if (!created) return;
  if (current.kind === "buildings") activeId.value = created.id;
  toast.ok(`已新增${kindLabel(current.kind)}「${name}」。`);
}

function startEdit(kind: Kind, item: { id: string; name: string }) {
  creating.value = null;
  editing.value = { kind, id: item.id, name: item.name };
  editName.value = item.name;
}
function cancelEdit() { editing.value = null; editName.value = ""; }
async function commitEdit() {
  const current = editing.value;
  if (!current) return;
  const name = editName.value.trim();
  cancelEdit();
  if (!name || name === current.name) return;
  if (await call(`/api/v1/admin/layout/${current.kind}/${current.id}`, "PATCH", { name })) {
    toast.ok(`已重命名为「${name}」。`);
  }
}

function askDelete(kind: Kind, item: { id: string; name: string }) {
  pendingDelete.value = { kind, id: item.id, name: item.name };
}

async function confirmDelete() {
  const target = pendingDelete.value;
  if (!target) return;
  if (await call(`/api/v1/admin/layout/${target.kind}/${target.id}`, "DELETE")) {
    toast.ok(`已删除${kindLabel(target.kind)}「${target.name}」。`);
  }
  pendingDelete.value = null;
}

/* —— 框选：空白处拖出选择框，与教室卡片相交即整间选中；拖到视口上下沿时页面跟随滚动 —— */
const BAND_EDGE = 44;
const boardEl = ref<HTMLElement | null>(null);
const band = ref<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
const bandHits = ref<string[]>([]);
const viewScroll = ref({ x: 0, y: 0 });
let bandPointerId: number | null = null;
let bandTimer: ReturnType<typeof setTimeout> | null = null;

function syncScroll() { viewScroll.value = { x: window.scrollX, y: window.scrollY }; }
function stopBandLoop() {
  if (bandTimer) clearTimeout(bandTimer);
  bandTimer = null;
}
/** 框的角点存文档坐标，滚动时起点跟着内容走，绘制再折算回视口。 */
function bandBox() {
  const b = band.value;
  if (!b) return null;
  const left = Math.min(b.x0, b.x1) - viewScroll.value.x;
  const top = Math.min(b.y0, b.y1) - viewScroll.value.y;
  return { left, top, right: left + Math.abs(b.x1 - b.x0), bottom: top + Math.abs(b.y1 - b.y0) };
}
const bandStyle = computed(() => {
  const box = bandBox();
  if (!box) return {};
  return { left: `${box.left}px`, top: `${box.top}px`, width: `${box.right - box.left}px`, height: `${box.bottom - box.top}px` };
});

function updateBandHits() {
  const box = bandBox();
  if (!box) { bandHits.value = []; return; }
  const hits: string[] = [];
  const cards = boardEl.value?.querySelectorAll<HTMLElement>(".room-wrap[data-room]") ?? [];
  for (const el of Array.from(cards)) {
    const rect = el.getBoundingClientRect();
    if (rect.right > box.left && rect.left < box.right && rect.bottom > box.top && rect.top < box.bottom)
      hits.push(el.dataset.room!);
  }
  bandHits.value = hits;
}

function bandTick() {
  bandTimer = null;
  const b = band.value;
  if (!b) return;
  const y = b.y1 - viewScroll.value.y;
  let delta = 0;
  if (y < BAND_EDGE) delta = -Math.min(16, (BAND_EDGE - y) / 2);
  else if (y > window.innerHeight - BAND_EDGE) delta = Math.min(16, (y - (window.innerHeight - BAND_EDGE)) / 2);
  if (delta) {
    window.scrollBy(0, delta);
    syncScroll();
    // 指针没动但页面在动：命中要照新位置重算。
    updateBandHits();
  }
  bandTimer = setTimeout(bandTick, 16);
}

function onBandDown(event: PointerEvent) {
  if (!props.selectable || event.button !== 0 || event.pointerType !== "mouse") return;
  // 卡片与控件上的那一下归单击和结构编辑管，框选只从空白处起手。
  if ((event.target as HTMLElement).closest("button, a, input, label, select, textarea, .room")) return;
  syncScroll();
  const x = event.clientX + viewScroll.value.x;
  const y = event.clientY + viewScroll.value.y;
  band.value = { x0: x, y0: y, x1: x, y1: y };
  bandPointerId = event.pointerId;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  event.preventDefault();
  updateBandHits();
  bandTimer = setTimeout(bandTick, 16);
}
function onBandMove(event: PointerEvent) {
  if (!band.value || event.pointerId !== bandPointerId) return;
  syncScroll();
  band.value = { ...band.value, x1: event.clientX + viewScroll.value.x, y1: event.clientY + viewScroll.value.y };
  updateBandHits();
}
function onBandUp(event: PointerEvent) {
  if (!band.value || event.pointerId !== bandPointerId) return;
  const b = band.value;
  const hits = bandHits.value;
  stopBandLoop();
  band.value = null;
  bandPointerId = null;
  bandHits.value = [];
  // 起终点几乎重合的那一下还是单击，别把已有选择清掉。
  if (Math.abs(b.x1 - b.x0) < 4 && Math.abs(b.y1 - b.y0) < 4) return;
  const rooms = new Set(hits);
  const ids = pickable([...new Set(props.rooms.filter((room) => rooms.has(room.id)).flatMap((room) => room.deviceIds))]);
  // 一圈空白什么也没框到：这不是一次选择，别把已经选好的目标清掉。
  if (!ids.length) return;
  emit("marquee", ids, event.shiftKey);
}
function onBandCancel(event: PointerEvent) {
  if (event.pointerId !== bandPointerId) return;
  stopBandLoop();
  band.value = null;
  bandPointerId = null;
  bandHits.value = [];
}
onBeforeUnmount(stopBandLoop);
</script>

<template>
  <section ref="boardEl" class="board" @pointerdown="onBandDown" @pointermove="onBandMove" @pointerup="onBandUp" @pointercancel="onBandCancel">
    <header class="board-head">
      <div class="tabs">
        <template v-for="building in buildings" :key="building.id">
          <input
            v-if="isEditing('buildings', building.id)"
            :ref="setEditInput"
            v-model="editName"
            class="inline"
            maxlength="60"
            @keydown.enter="commitEdit"
            @keydown.esc="cancelEdit"
            @blur="commitEdit"
          >
          <button
            v-else
            type="button"
            :data-active="building.id === active?.id"
            :title="canEdit ? `${building.name} · 双击改名` : building.name"
            @click="activeId = building.id"
            @dblclick="canEdit && startEdit('buildings', building)"
          >{{ building.name }}</button>
        </template>
        <input
          v-if="isCreating('buildings')"
          :ref="setCreateInput"
          v-model="createName"
          class="inline"
          maxlength="60"
          placeholder="楼栋名称"
          @keydown.enter="commitCreate"
          @keydown.esc="cancelCreate"
          @blur="commitCreate"
        >
        <button v-else-if="canEdit" type="button" class="add" title="新建楼栋" @click="startCreate('buildings')">＋ 楼栋</button>
      </div>
      <div class="board-tools">
        <template v-if="active && canEdit">
          <button type="button" class="ghost" @click="startEdit('buildings', active)">改名</button>
          <button type="button" class="ghost" @click="askDelete('buildings', active)">删除</button>
        </template>
        <p class="legend"><i class="dot" data-online="true" />在线<i class="dot" />离线</p>
      </div>
    </header>

    <EmptyState v-if="!buildings.length" title="还没有楼栋">
      <template #action><button v-if="canEdit" type="button" @click="startCreate('buildings')">新建楼栋</button></template>
    </EmptyState>

    <div v-else class="floors">
      <article v-for="floor in floors" :key="floor.id" class="floor">
        <div class="floor-label">
          <input
            v-if="selectable"
            type="checkbox"
            :checked="allSelected(floorDeviceIds(floor.id))"
            :indeterminate="someSelected(floorDeviceIds(floor.id))"
            :disabled="scopeLocked(floorDeviceIds(floor.id))"
            @click.stop="emit('toggle', pickable(floorDeviceIds(floor.id)))"
          >
          <input
            v-if="isEditing('floors', floor.id)"
            :ref="setEditInput"
            v-model="editName"
            class="inline"
            maxlength="60"
            @keydown.enter="commitEdit"
            @keydown.esc="cancelEdit"
            @blur="commitEdit"
          >
          <strong v-else>{{ floor.name }}</strong>
          <small>{{ floorDeviceIds(floor.id).length }}</small>
          <span v-if="canEdit" class="floor-tools">
            <button type="button" @click="startEdit('floors', floor)">改名</button>
            <button type="button" @click="askDelete('floors', floor)">删除</button>
          </span>
        </div>
        <div class="rooms">
          <div
            v-for="room in roomsOf(floor.id)"
            :key="room.id"
            class="room-wrap"
            :data-room="room.id"
            :data-hit="bandHits.includes(room.id)"
            :data-selected="allSelected(room.deviceIds)"
            :data-partial="someSelected(room.deviceIds)"
          >
            <label v-if="selectable" class="pick">
              <input
                type="checkbox"
                :checked="allSelected(room.deviceIds)"
                :indeterminate="someSelected(room.deviceIds)"
                :disabled="scopeLocked(room.deviceIds)"
                @click.stop="emit('toggle', pickable(room.deviceIds))"
              >
            </label>
            <div class="room" @click="onRoomClick(room)">
              <button
                v-if="!isEditing('rooms', room.id)"
                type="button"
                class="room-open"
                @click.stop="emit('openRoom', room.id)"
              >
                <span class="room-name">{{ room.name }}</span>
                <small>{{ room.deviceIds.length ? `${onlineCount(room.deviceIds)}/${room.deviceIds.length}` : "空" }}</small>
              </button>
              <input
                v-else
                :ref="setEditInput"
                v-model="editName"
                class="inline"
                maxlength="60"
                @click.stop
                @keydown.enter="commitEdit"
                @keydown.esc="cancelEdit"
                @blur="commitEdit"
              >
              <span class="room-devices">
                <button
                  v-for="device in roomDevices(room).slice(0, 4)"
                  :key="device.id"
                  type="button"
                  class="chip"
                  :title="`${device.name} · ${device.id.slice(0, 8)} · 查看设备详情`"
                  @click.stop="emit('inspect', device.id)"
                >
                  <i class="dot" :data-online="device.online" /><span class="chip-name">{{ device.name }}</span>
                </button>
                <button
                  v-if="roomDevices(room).length > 4"
                  type="button"
                  class="chip more"
                  title="查看全部设备"
                  @click.stop="emit('openRoom', room.id)"
                >+{{ roomDevices(room).length - 4 }}</button>
                <button
                  v-if="canEdit"
                  type="button"
                  class="chip add-chip"
                  title="给这间教室添加设备"
                  @click.stop="emit('openRoom', room.id)"
                >＋ 设备</button>
              </span>
              <span v-if="canEdit" class="room-tools">
                <button type="button" @click.stop="startEdit('rooms', room)">改名</button>
                <button type="button" @click.stop="askDelete('rooms', room)">删除</button>
              </span>
            </div>
          </div>
          <input
            v-if="isCreating('rooms', floor.id)"
            :ref="setCreateInput"
            v-model="createName"
            class="inline add-input"
            maxlength="60"
            placeholder="教室名称"
            @keydown.enter="commitCreate"
            @keydown.esc="cancelCreate"
            @blur="commitCreate"
          >
          <button v-else-if="canEdit" type="button" class="add" @click="startCreate('rooms', floor.id)">＋ 教室</button>
        </div>
      </article>
      <input
        v-if="isCreating('floors')"
        :ref="setCreateInput"
        v-model="createName"
        class="inline"
        maxlength="60"
        placeholder="楼层名称，例如：四层"
        @keydown.enter="commitCreate"
        @keydown.esc="cancelCreate"
        @blur="commitCreate"
      >
      <button v-else-if="canEdit" type="button" class="add floor-add" @click="startCreate('floors', active?.id ?? null)">＋ 楼层</button>
      <p v-if="!floors.length" class="floor-hint">{{ canEdit ? "该楼栋还没有楼层，点「＋ 楼层」添加。" : "该楼栋还没有楼层。" }}</p>
    </div>

    <Teleport to="body">
      <div v-if="band" class="board-band" :style="bandStyle" />
    </Teleport>

    <ConfirmDialog
      v-if="pendingDelete"
      :title="`删除${kindLabel(pendingDelete.kind)}`"
      :description="deleteHint"
      confirm-text="删除"
      danger
      :busy="busy"
      @close="pendingDelete = null"
      @confirm="confirmDelete"
    />
  </section>
</template>

<style scoped>
.board { display: grid; gap: 24px; }
.board-head { display: flex; align-items: center; justify-content: space-between; gap: 18px; flex-wrap: wrap; }
/* 楼栋切换沿用 RhineLab 标签栏：34px 间距 + 发丝底线。 */
.tabs { flex: 1; min-width: 260px; gap: 26px; }
.tabs button { min-height: 0; font-size: 15px; }
.tabs button.add { color: var(--ink-muted); font-size: 12px; letter-spacing: 0.6px; }
.tabs button.add:hover:not(:disabled) { color: var(--accent); }
.board-tools { display: flex; align-items: center; gap: 14px; }
.legend { display: flex; align-items: center; gap: 7px; margin: 0; color: var(--ink-muted); font-size: 10px; letter-spacing: 0.6px; }
.legend .dot { margin-left: 9px; }
.inline {
  min-height: var(--control-h-sm);
  max-width: 100%;
  padding: 0 11px;
  border: 1px solid var(--accent);
  background: var(--surface-1);
  color: var(--ink);
  font-size: 13px;
}
.floors { display: grid; gap: 12px; }
/* 楼层：一条发丝框，左侧楼层信息、右侧教室矩阵。 */
.floor {
  display: grid;
  grid-template-columns: 190px minmax(0, 1fr);
  gap: 20px;
  padding: 18px 22px;
  border: 1px solid var(--line-soft);
  background: var(--surface-1);
}
.floor-label { display: flex; align-items: center; gap: 10px; align-self: start; flex-wrap: wrap; }
.floor-label strong { font-size: 15px; font-weight: 600; }
.floor-label small { color: var(--ink-muted); font-size: 10px; font-variant-numeric: tabular-nums; }
.floor-tools { display: flex; gap: 12px; width: calc(100% - 30px); }
.rooms { display: flex; flex-wrap: wrap; gap: 10px; align-items: flex-start; }
.room-wrap { position: relative; }
.room {
  display: grid;
  gap: 9px;
  align-content: start;
  min-width: 158px;
  max-width: 252px;
  padding: 14px 36px 14px 14px;
  border: 1px solid var(--line);
  background: transparent;
  cursor: pointer;
  user-select: none;
  transition: background var(--t-base) var(--ease-enter), border-color var(--t-base) var(--ease-enter);
}
.room:hover { border-color: var(--accent); background: var(--accent-wash); }
.room .inline { cursor: text; user-select: text; }
.room-open { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; min-height: 0; padding: 0; border: 0; background: none; color: inherit; text-align: left; }
.room-open:hover { border: 0; background: none; }
.room-open:hover .room-name { color: var(--accent); }
.room-name { font-size: 14px; font-weight: 600; letter-spacing: 0.2px; }
.room-wrap[data-selected="true"] .room { border-color: var(--fill); background: var(--fill); }
.room-wrap[data-selected="true"] .room-name,
.room-wrap[data-selected="true"] .room small { color: var(--fill-ink); }
.room-wrap[data-selected="true"] .room-open:hover .room-name { color: var(--fill-ink); }
.room-wrap[data-partial="true"] .room { border-color: var(--warning); }
/* 框选中的教室先亮一下，松手后才换成选中的深橄榄底。 */
.room-wrap[data-hit="true"] .room { border-color: var(--accent); background: var(--accent-wash); }
.board-band {
  position: fixed;
  z-index: 30;
  border: 1px solid var(--accent);
  background: var(--accent-wash);
  opacity: 0.55;
  pointer-events: none;
}
.pick { position: absolute; top: 12px; right: 12px; z-index: 1; display: flex; padding: 0; background: transparent; }
.pick input { width: 18px; height: 18px; }
.room-devices { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; min-height: 12px; }
.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  min-height: 0;
  padding: 4px 8px;
  border: 1px solid var(--line);
  background: transparent;
  color: var(--ink-soft);
  font-size: 10px;
  letter-spacing: 0.3px;
  transition: border-color var(--t-mid) var(--ease-enter), background var(--t-mid) var(--ease-enter), color var(--t-mid) var(--ease-enter);
}
.chip:hover { border-color: var(--accent); background: var(--accent-wash); color: var(--ink); }
.chip-name { max-width: 104px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chip.more { color: var(--ink-muted); }
.chip.add-chip { border-style: dashed; color: var(--ink-muted); }
.room-wrap[data-selected="true"] .chip { border-color: #5c6152; color: var(--fill-ink); }
.room-wrap[data-selected="true"] .chip:hover { border-color: var(--fill-ink); background: #4b4a3b; color: var(--fill-ink); }
.room small { color: var(--ink-muted); font-size: 10px; font-variant-numeric: tabular-nums; }
.room-tools { display: flex; gap: 12px; opacity: 0; transition: opacity var(--t-mid) var(--ease-enter); }
.room-wrap:hover .room-tools, .room-wrap:focus-within .room-tools { opacity: 1; }
.floor-tools button,
.room-tools button {
  min-height: 0;
  padding: 0;
  border: 0;
  background: none;
  color: var(--ink-muted);
  font-size: 10px;
  letter-spacing: 0.5px;
}
.floor-tools button:hover:not(:disabled),
.room-tools button:hover:not(:disabled) { border: 0; background: none; color: var(--accent); }
.room-wrap[data-selected="true"] .room-tools button { color: var(--fill-muted); }
.room-wrap[data-selected="true"] .room-tools button:hover { color: var(--fill-ink); }
@media (max-width: 760px) {
  .floor { grid-template-columns: 1fr; gap: 14px; padding: 16px; }
  .floor-tools { width: auto; }
}
</style>