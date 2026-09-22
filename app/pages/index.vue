<script setup lang="ts">
type Building = { id: string; name: string; sortOrder: number };
type Floor = { id: string; buildingId: string; name: string; level: number; sortOrder: number };
type Room = { id: string; floorId: string; name: string; sortOrder: number; deviceIds: string[] };

const { data: layout, refresh } = await useFetch<{ buildings: Building[]; floors: Floor[]; rooms: Room[] }>(
  "/api/v1/admin/layout",
  { key: "cic-layout", default: () => ({ buildings: [], floors: [], rooms: [] }) },
);
const { devices, selection, enabledDevices, deviceIds: selectedDeviceIds, scopeCoveredIds, count, empty, clear, toggleSchool } = useTargetSelection();
const { user, can } = useSession();
/** 多选只为发布服务：策略与任务都进不去的账号，不该看见选了目标却无处可用。 */
const canPublish = computed(() => can("policies.write") || can("configurations.write") || can("tasks.write"));
/** 只看得到绑定设备的账号（教师）要的是自己那台机的位置，整棵空楼栋树只是噪音。 */
const boundOnly = computed(() => user.value?.role === "teacher");

const roomId = ref<string | null>(null);
const inspectId = ref<string | null>(null);
const showTargets = ref(false);
const activeBuilding = ref<string | null>(null);

const shown = computed(() => {
  const tree = layout.value;
  if (!boundOnly.value) return tree;
  const rooms = tree.rooms.filter((item) => item.deviceIds.length);
  const floorIds = new Set(rooms.map((item) => item.floorId));
  const floors = tree.floors.filter((item) => floorIds.has(item.id));
  const buildingIds = new Set(floors.map((item) => item.buildingId));
  return { rooms, floors, buildings: tree.buildings.filter((item) => buildingIds.has(item.id)) };
});

const room = computed(() => (roomId.value ? layout.value.rooms.find((item) => item.id === roomId.value) ?? null : null));

/** 楼栋视图里的多选直接写进全局目标选择，供策略与任务复用。 */
function toggleDevices(ids: string[]) {
  if (!ids.length) return;
  const current = selection.value.deviceIds;
  const next = ids.every((id) => current.includes(id))
    ? current.filter((id) => !ids.includes(id))
    : [...new Set([...current, ...ids])];
  selection.value = { ...selection.value, deviceIds: next };
}

/** 框选给的是一组确定的设备：不叠 Shift 就把整份目标换成这批（范围勾着一台不动它的话，框完看着什么都没变，最容易发错）。 */
function marqueeDevices(ids: string[], additive: boolean) {
  if (!additive) {
    selection.value = { school: false, orgNodeIds: [], tagIds: [], deviceIds: ids };
    return;
  }
  const current = selection.value.deviceIds;
  selection.value = { ...selection.value, deviceIds: [...new Set([...current, ...ids])] };
}

function openRoom(id: string) { roomId.value = id; }
const deviceById = computed(() => new Map(devices.value.map((device) => [device.id, device])));
/** 当前楼栋里可勾选的设备（教师只看得到放了设备的那几间；停用设备既不选上也不算半选）。 */
const buildingDeviceIds = computed(() => {
  const tree = shown.value;
  const floorIds = new Set(tree.floors.filter((floor) => floor.buildingId === activeBuilding.value).map((floor) => floor.id));
  const ids = [...new Set(tree.rooms.filter((room) => floorIds.has(room.floorId)).flatMap((room) => room.deviceIds))];
  return ids.filter((id) => deviceById.value.get(id)?.disabled === false);
});
const selectedIdSet = computed(() => new Set(selectedDeviceIds.value));
const buildingAllSelected = computed(() => buildingDeviceIds.value.length > 0 && buildingDeviceIds.value.every((id) => selectedIdSet.value.has(id)));
/** 整栋都被范围盖住时，逐台取消是表达不出来的：全选按钮该让位给旁边那个范围勾选。 */
const buildingScopeLocked = computed(() => buildingDeviceIds.value.length > 0 && buildingDeviceIds.value.every((id) => scopeCoveredIds.value.has(id)));
/** 单击设备看设备详情（内含生效策略明细入口）；先关掉教室弹窗，避免叠层。 */
function inspect(id: string) { roomId.value = null; inspectId.value = id; }
async function changed() { await refresh(); }
</script>

<template>
  <PageHeading kicker="按楼栋管设备" title="楼栋部署">
    <div v-if="canPublish" class="picked">
      <span class="count">{{ empty ? "未选目标" : `已选 ${count} 台` }}</span>
      <button type="button" class="ghost" :disabled="!buildingDeviceIds.length || buildingScopeLocked" @click="toggleDevices(buildingDeviceIds)">{{ buildingAllSelected ? "取消全选本楼栋" : "全选本楼栋" }}</button>
      <label class="all" :data-on="selection.school ? 'true' : 'false'"><input type="checkbox" :checked="selection.school" @change="toggleSchool()"><span>全校</span><small>{{ enabledDevices.length }}</small></label>
      <button type="button" class="solid" @click="showTargets = true">选择目标</button>
      <template v-if="!empty">
        <NuxtLink v-if="can('policies.write')" class="ghost" to="/policies?new=1">发布策略</NuxtLink>
        <NuxtLink v-if="can('tasks.write')" class="ghost" to="/tasks?new=1">发布任务</NuxtLink>
        <NuxtLink v-if="can('configurations.write')" class="ghost" to="/configurations">配置库</NuxtLink>
        <button type="button" class="ghost" @click="clear">清空选择</button>
      </template>
    </div>
  </PageHeading>

  <BuildingBoard
    v-model:active-building="activeBuilding"
    :buildings="shown.buildings"
    :floors="shown.floors"
    :rooms="shown.rooms"
    :devices="devices"
    :selected-ids="selectedDeviceIds"
    :locked-ids="scopeCoveredIds"
    :selectable="canPublish"
    @toggle="toggleDevices"
    @marquee="marqueeDevices"
    @open-room="openRoom"
    @inspect="inspect"
    @changed="changed"
  />
  <RoomDevicesDialog
    v-if="room"
    :room-id="room.id"
    :room-name="room.name"
    :device-ids="room.deviceIds"
    :devices="devices"
    :selectable="canPublish"
    @close="roomId = null"
    @changed="changed"
    @inspect="inspect"
  />
  <TargetPickerDialog v-if="showTargets" @close="showTargets = false" />
  <DeviceDetailDialog v-if="inspectId"
 :device-id="inspectId" @close="inspectId = null" @changed="changed" />
</template>

<style scoped>
.picked { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
.count { color: var(--ink-muted); font-size: 11px; letter-spacing: 0.8px; font-variant-numeric: tabular-nums; }
/* 全校是一路作用域，不是一批设备：勾上后发布的是「全校」那一条策略，所以做成独立控件而不是又一颗按钮。 */
.all { display: inline-flex; align-items: center; gap: 8px; min-height: var(--control-h-sm); padding: 0 11px; border: 1px solid var(--line); color: var(--ink-soft); font-size: 11px; cursor: pointer; }
.all[data-on="true"] { border-color: var(--accent); background: var(--accent-wash); color: var(--ink); }
.all input { width: 15px; height: 15px; }
.all small { color: var(--ink-muted); font-variant-numeric: tabular-nums; }
</style>