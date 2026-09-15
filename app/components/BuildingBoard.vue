<script setup lang="ts">
type Building = { id: string; name: string; sortOrder: number };
type Floor = { id: string; buildingId: string; name: string; level: number; sortOrder: number };
type Room = { id: string; floorId: string; name: string; sortOrder: number; deviceIds: string[] };
type DeviceLite = { id: string; name: string; online: boolean; disabled: boolean; orgName: string };
type Kind = "buildings" | "floors" | "rooms";

const props = defineProps<{
  buildings: Building[];
  floors: Floor[];
  rooms: Room[];
  devices: DeviceLite[];
  selectedIds: string[];
}>();
const emit = defineEmits<{ toggle: [ids: string[]]; openRoom: [id: string]; inspect: [id: string]; changed: [] }>();
const toast = useToast();

const activeId = ref<string | null>(null);
watch(
  () => props.buildings,
  (list) => {
    if (!list.length) { activeId.value = null; return; }
    if (!list.some((building) => building.id === activeId.value)) activeId.value = list[0]!.id;
  },
  { immediate: true },
);
const active = computed(() => props.buildings.find((building) => building.id === activeId.value) ?? null);
const deviceById = computed(() => new Map(props.devices.map((device) => [device.id, device])));
const floors = computed(() => props.floors.filter((floor) => floor.buildingId === active.value?.id));
const roomsOf = (floorId: string) => props.rooms.filter((room) => room.floorId === floorId);
const floorDeviceIds = (floorId: string) => roomsOf(floorId).flatMap((room) => room.deviceIds);
const roomDevices = (room: Room) =>
  room.deviceIds.map((id) => deviceById.value.get(id)).filter((device): device is DeviceLite => !!device);
const onlineCount = (ids: string[]) => ids.filter((id) => deviceById.value.get(id)?.online).length;
const allSelected = (ids: string[]) => ids.length > 0 && ids.every((id) => props.selectedIds.includes(id));
const someSelected = (ids: string[]) => !allSelected(ids) && ids.some((id) => props.selectedIds.includes(id));

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
</script>

<template>
  <section class="board">
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
            :title="`${building.name} · 双击改名`"
            @click="activeId = building.id"
            @dblclick="startEdit('buildings', building)"
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
        <button v-else type="button" class="edit" title="新建楼栋" @click="startCreate('buildings')">＋ 楼栋</button>
      </div>
      <div class="board-tools">
        <template v-if="active">
          <button type="button" class="ghost" @click="startEdit('buildings', active)">改名</button>
          <button type="button" class="ghost" @click="askDelete('buildings', active)">删除</button>
        </template>
        <p class="legend"><i class="dot" data-online="true" />在线<i class="dot" />离线</p>
      </div>
    </header>

    <EmptyState v-if="!buildings.length" title="还没有楼栋" description="创建楼栋、楼层与教室，再把设备放进教室。">
      <template #action><button type="button" @click="startCreate('buildings')">新建楼栋</button></template>
    </EmptyState>

    <div v-else class="floors">
      <article v-for="floor in floors" :key="floor.id" class="floor">
        <div class="floor-label">
          <input
            type="checkbox"
            :checked="allSelected(floorDeviceIds(floor.id))"
            :indeterminate="someSelected(floorDeviceIds(floor.id))"
            @click.stop="emit('toggle', floorDeviceIds(floor.id))"
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
          <span class="floor-tools">
            <button type="button" @click="startEdit('floors', floor)">改名</button>
            <button type="button" @click="askDelete('floors', floor)">删除</button>
          </span>
        </div>
        <div class="rooms">
          <div
            v-for="room in roomsOf(floor.id)"
            :key="room.id"
            class="room-wrap"
            :data-selected="allSelected(room.deviceIds)"
            :data-partial="someSelected(room.deviceIds)"
          >
            <label class="pick">
              <input
                type="checkbox"
                :checked="allSelected(room.deviceIds)"
                :indeterminate="someSelected(room.deviceIds)"
                @click.stop="emit('toggle', room.deviceIds)"
              >
            </label>
            <div class="room">
              <button
                v-if="!isEditing('rooms', room.id)"
                type="button"
                class="room-open"
                @click="emit('openRoom', room.id)"
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
                  :title="`${device.name} · ${device.id.slice(0, 8)} · 查看已应用策略`"
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
                  type="button"
                  class="chip add-chip"
                  title="给这间教室添加设备"
                  @click.stop="emit('openRoom', room.id)"
                >＋ 设备</button>
              </span>
              <span class="room-tools">
                <button type="button" @click="startEdit('rooms', room)">改名</button>
                <button type="button" @click="askDelete('rooms', room)">删除</button>
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
          <button v-else type="button" class="add" @click="startCreate('rooms', floor.id)">＋ 教室</button>
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
      <button v-else type="button" class="add floor-add" @click="startCreate('floors', active?.id ?? null)">＋ 楼层</button>
      <p v-if="!floors.length" class="floor-hint">该楼栋还没有楼层，点「＋ 楼层」添加。</p>
    </div>

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
.board { display: grid; gap: 12px; }
.board-head { display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap; }
.tabs button.edit { background: var(--surface-2); color: var(--ink); }
.board-tools { display: flex; align-items: center; gap: 10px; }

.legend { display: flex; align-items: center; gap: 6px; margin: 0; color: var(--ink-muted); font-size: 10px; }
.legend .dot { margin-left: 6px; }
.inline { min-height: 36px; max-width: 100%; padding: 0 12px; border: 0; border-radius: 12px; background: var(--surface-3); color: var(--ink); font-size: 12px; }
.add { min-height: 44px; padding: 0 14px; border: 1px dashed var(--ink-muted); border-radius: 14px; background: none; color: var(--ink-soft); font-size: 11px; cursor: pointer; transition: background 140ms var(--ease-enter); }
.add:hover { background: var(--surface-2); color: var(--ink); }
.add-input { min-width: 132px; }
.floor-add { justify-self: start; }
.floors { display: grid; gap: 10px; }
.floor { display: grid; grid-template-columns: 168px minmax(0, 1fr); gap: 12px; padding: 14px; border-radius: var(--radius-md); background: var(--surface-1); }
.floor-label { display: flex; align-items: center; gap: 10px; align-self: start; padding-top: 6px; flex-wrap: wrap; }

.floor-label strong { font-size: 13px; }
.floor-label small { color: var(--ink-muted); font-size: 10px; }
.floor-tools { display: flex; gap: 8px; }
.floor-tools button { padding: 0; border: 0; background: none; color: var(--ink-muted); font-size: 10px; cursor: pointer; }
.floor-tools button:hover { color: var(--ink); }
.rooms { display: flex; flex-wrap: wrap; gap: 8px; align-items: flex-start; }
.room-wrap { position: relative; }
.room { display: grid; gap: 6px; align-content: start; min-width: 148px; max-width: 248px; padding: 14px 30px 12px 14px; border-radius: var(--radius-row); background: var(--surface-2); transition: background 160ms var(--ease-enter), transform 160ms var(--ease-enter); }
.room:hover { transform: translateY(-2px); }
.room-open { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; padding: 0; border: 0; background: none; color: inherit; text-align: left; cursor: pointer; }
.room-open:hover .room-name { text-decoration: underline; }
.room-wrap[data-selected="true"] .room { background: var(--ink); }
.room-wrap[data-selected="true"] .room-name, .room-wrap[data-selected="true"] .room small { color: var(--canvas); }
.room-wrap[data-partial="true"] .room { outline: 1px dashed var(--ink-muted); }
.pick { position: absolute; top: 8px; right: 8px; z-index: 1; display: flex; padding: 5px; border-radius: var(--radius-control-sm); background: var(--surface-1); box-shadow: 0 1px 4px rgb(0 0 0/.18); }
.pick:hover { background: var(--surface-3); }
.room-wrap[data-selected="true"] .pick { background: var(--accent); }
.room-wrap[data-partial="true"] .pick { background: var(--warning); }
.room-name { font-size: 13px; font-weight: 650; }
.room-devices { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; min-height: 12px; }
.chip { display: inline-flex; align-items: center; gap: 5px; min-width: 0; padding: 3px 8px; border: 0; border-radius: 8px; background: var(--surface-3); color: var(--ink); font-size: 10px; cursor: pointer; transition: transform 140ms var(--ease-enter); }
.chip:hover { transform: translateY(-1px); }
.chip-name { max-width: 104px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chip.more { color: var(--ink-soft); }
.chip.add-chip { background: none; border: 1px dashed var(--ink-muted); color: var(--ink-muted); }
.chip.add-chip:hover { color: var(--ink); }
.room-wrap[data-selected="true"] .chip.add-chip { border-color: var(--canvas); color: var(--canvas); }
.room-wrap[data-selected="true"] .chip { background: var(--ink-muted); color: var(--canvas); }
.room small { color: var(--ink-muted); font-size: 10px; }
.room-tools { display: flex; gap: 10px; opacity: 0; transition: opacity 140ms var(--ease-enter); }
.room-wrap:hover .room-tools, .room-wrap:focus-within .room-tools { opacity: 1; }
.room-tools button { padding: 0; border: 0; background: none; color: var(--ink-muted); font-size: 10px; cursor: pointer; }
.room-tools button:hover { color: var(--ink); }
.room-wrap[data-selected="true"] .room-tools button { color: var(--canvas); }
.floor-hint { margin: 0; color: var(--ink-muted); font-size: 11px; }
@media (max-width: 700px) { .floor { grid-template-columns: 1fr; } }
</style>