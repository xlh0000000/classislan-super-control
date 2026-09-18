<script setup lang="ts">
type Building = { id: string; name: string; sortOrder: number };
type Floor = { id: string; buildingId: string; name: string; level: number; sortOrder: number };
type Room = { id: string; floorId: string; name: string; sortOrder: number; deviceIds: string[] };

const { data: layout, refresh } = await useFetch<{ buildings: Building[]; floors: Floor[]; rooms: Room[] }>(
  "/api/v1/admin/layout",
  { key: "cic-layout", default: () => ({ buildings: [], floors: [], rooms: [] }) },
);
const { devices, selection, count, empty, clear } = useTargetSelection();

const roomId = ref<string | null>(null);
const inspectId = ref<string | null>(null);
const showTargets = ref(false);

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
    <div class="picked">
      <span class="count">{{ empty ? "未选目标" : `已选 ${count} 台` }}</span>
      <button type="button" class="solid" @click="showTargets = true">选择目标</button>
      <template v-if="!empty">
        <NuxtLink class="ghost" to="/policies?new=1">发布策略</NuxtLink>
        <NuxtLink class="ghost" to="/timetable?publish=1">发布课表</NuxtLink>
        <NuxtLink class="ghost" to="/configurations">下发配置</NuxtLink>
        <NuxtLink class="ghost" to="/tasks?new=1">发布任务</NuxtLink>
        <button type="button" class="ghost" @click="clear">清空选择</button>
      </template>
    </div>
  </PageHeading>

  <BuildingBoard
    :buildings="layout.buildings"
    :floors="layout.floors"
    :rooms="layout.rooms"
    :devices="devices"
    :selected-ids="selection.deviceIds"
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