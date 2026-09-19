<script setup lang="ts">
type Building = { id: string; name: string; sortOrder: number };
type Floor = { id: string; buildingId: string; name: string; level: number; sortOrder: number };
type Room = { id: string; floorId: string; name: string; sortOrder: number; deviceIds: string[] };

const { data: layout, refresh } = await useFetch<{ buildings: Building[]; floors: Floor[]; rooms: Room[] }>(
  "/api/v1/admin/layout",
  { key: "cic-layout", default: () => ({ buildings: [], floors: [], rooms: [] }) },
);
const { devices, selection, count, empty, clear } = useTargetSelection();
const { user, can } = useSession();
/** 多选只为下发服务：三个下发页都进不去的账号，不该看见选了目标却无处可用。 */
const canPublish = computed(() => can("policies.write") || can("configurations.write") || can("tasks.write"));
/** 只看得到绑定设备的账号（教师）要的是自己那台机的位置，整棵空楼栋树只是噪音。 */
const boundOnly = computed(() => user.value?.role === "teacher");

const roomId = ref<string | null>(null);
const inspectId = ref<string | null>(null);
const showTargets = ref(false);

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

/** 楼栋视图里的多选直接写进全局目标选择，供策略与配置下发复用。 */
function toggleDevices(ids: string[]) {
  if (!ids.length) return;
  const current = selection.value.deviceIds;
  const next = ids.every((id) => current.includes(id))
    ? current.filter((id) => !ids.includes(id))
    : [...new Set([...current, ...ids])];
  selection.value = { ...selection.value, deviceIds: next };
}

function openRoom(id: string) { roomId.value = id; }
/** 单击设备看设备详情（内含生效策略明细入口）；先关掉教室弹窗，避免叠层。 */
function inspect(id: string) { roomId.value = null; inspectId.value = id; }
async function changed() { await refresh(); }
</script>

<template>
  <PageHeading kicker="按楼栋管设备" title="楼栋部署">
    <div v-if="canPublish" class="picked">
      <span class="count">{{ empty ? "未选目标" : `已选 ${count} 台` }}</span>
      <button type="button" class="solid" @click="showTargets = true">选择目标</button>
      <template v-if="!empty">
        <NuxtLink v-if="can('policies.write')" class="ghost" to="/policies?new=1">发布策略</NuxtLink>
        <NuxtLink v-if="can('configurations.write')" class="ghost" to="/timetable?publish=1">发布课表</NuxtLink>
        <NuxtLink v-if="can('configurations.write')" class="ghost" to="/configurations">下发配置</NuxtLink>
        <NuxtLink v-if="can('tasks.write')" class="ghost" to="/tasks?new=1">发布任务</NuxtLink>
        <button type="button" class="ghost" @click="clear">清空选择</button>
      </template>
    </div>
  </PageHeading>

  <BuildingBoard
    :buildings="shown.buildings"
    :floors="shown.floors"
    :rooms="shown.rooms"
    :devices="devices"
    :selected-ids="selection.deviceIds"
    :selectable="canPublish"
    @toggle="toggleDevices"
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
.picked { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.count { margin-right: 8px; color: var(--ink-muted); font-size: 11px; letter-spacing: 0.8px; font-variant-numeric: tabular-nums; }
</style>