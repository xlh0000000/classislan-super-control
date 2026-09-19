<script setup lang="ts">
type DeviceLite = { id: string; name: string; online: boolean; disabled: boolean; orgName: string };

const props = withDefaults(defineProps<{
  roomId: string; roomName: string; deviceIds: string[]; devices: DeviceLite[]; selectable?: boolean;
}>(), { selectable: true });
const emit = defineEmits<{ close: []; changed: []; inspect: [id: string] }>();
const toast = useToast();
const { selection, toggleDevice } = useTargetSelection();
const { can } = useSession();
/** 教室与设备的归属关系由 devices.write 管，只读账号进来是看设备，不是调座位。 */
const canEdit = computed(() => can("devices.write"));
const query = ref("");
const busy = ref(false);

const matched = computed(() => {
  const keyword = query.value.trim().toLowerCase();
  const enabled = props.devices.filter((device) => !device.disabled);
  if (!keyword) return enabled;
  return enabled.filter((device) => device.name.toLowerCase().includes(keyword) || device.orgName.toLowerCase().includes(keyword));
});
const assigned = computed(() =>
  props.deviceIds.map((id) => props.devices.find((device) => device.id === id)).filter((device): device is DeviceLite => !!device),
);
const assignedList = computed(() => {
  const keyword = query.value.trim().toLowerCase();
  if (!keyword) return assigned.value;
  return assigned.value.filter((device) => device.name.toLowerCase().includes(keyword));
});
const candidates = computed(() => matched.value.filter((device) => !props.deviceIds.includes(device.id)));

async function move(deviceIds: string[], add: boolean) {
  busy.value = true;
  try {
    await $fetch(`/api/v1/admin/layout/rooms/${props.roomId}/devices`, {
      method: "POST",
      headers: { origin: location.origin },
      body: add ? { add: deviceIds } : { remove: deviceIds },
    });
    toast.ok(add ? `已加入 ${deviceIds.length} 台设备。` : `已移出 ${deviceIds.length} 台设备。`);
    emit("changed");
  } catch (error) {
    toast.err((error as { data?: { message?: string } })?.data?.message ?? "设备分配失败。");
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <AppDialog :title="`教室：${roomName}`" kicker="教室里的设备" width="720px" @close="emit('close')">
    <input v-model="query" class="search" type="search" placeholder="搜索设备">
    <article class="block">
      <h3>本教室设备 <small>{{ assigned.length }}</small></h3>
      <ul>
        <li v-for="device in assignedList" :key="device.id" :data-on="selection.deviceIds.includes(device.id)">
          <label class="pick" :aria-hidden="!selectable"><input v-if="selectable" type="checkbox" :checked="selection.deviceIds.includes(device.id)" @change="toggleDevice(device.id)"></label>
          <i class="dot" :data-online="device.online" />
          <button type="button" class="name" @click="emit('inspect', device.id)">{{ device.name }}</button>
          <small>{{ device.orgName }} · {{ device.id.slice(0, 8) }}</small>
          <button v-if="canEdit" type="button" class="ghost" :disabled="busy" @click="move([device.id], false)">移出</button>
        </li>
        <li v-if="!assignedList.length" class="muted">这间教室还没有设备。</li>
      </ul>
    </article>
    <article v-if="canEdit" class="block">
      <h3>可加入的设备 <small>{{ candidates.length }}</small></h3>
      <ul>
        <li v-for="device in candidates" :key="device.id" :data-on="selection.deviceIds.includes(device.id)">
          <label class="pick" :aria-hidden="!selectable"><input v-if="selectable" type="checkbox" :checked="selection.deviceIds.includes(device.id)" @change="toggleDevice(device.id)"></label>
          <i class="dot" :data-online="device.online" />
          <button type="button" class="name" @click="emit('inspect', device.id)">{{ device.name }}</button>
          <small>{{ device.orgName }} · {{ device.id.slice(0, 8) }}</small>
          <button type="button" :disabled="busy" @click="move([device.id], true)">加入</button>
        </li>
        <li v-if="!candidates.length" class="muted">没有可以加入的设备。</li>
      </ul>
    </article>
    <p v-if="selectable && canEdit" class="tip">点设备名看它生效中的策略，勾选加入多选。</p>
    <template #footer>
      <button type="button" class="ghost" @click="emit('close')">关闭</button>
    </template>
  </AppDialog>
</template>

<style scoped>
.search { width: 100%; min-height: var(--control-h); margin-bottom: 18px; }
.block { padding: 0; border: 1px solid var(--line-soft); background: var(--surface-1); }
.block + .block { margin-top: 16px; }
h3 { display: flex; align-items: baseline; gap: 10px; margin: 0; padding: 16px 18px; border-bottom: 1px solid var(--line-strong); font-size: 14px; font-weight: 600; }
h3 small { color: var(--ink-muted); font-size: 10px; font-weight: 400; letter-spacing: 1px; }
ul { margin: 0; padding: 0; list-style: none; }
li { display: grid; grid-template-columns: auto auto minmax(0, 1fr) auto auto; align-items: center; gap: 12px; min-height: 62px; padding: 10px 18px; border-bottom: 1px solid var(--line-soft); font-size: 12px; transition: background var(--t-base) var(--ease-enter); }
li:last-child { border-bottom: 0; }
li:hover { background: var(--accent-wash); }
li small { color: var(--ink-muted); font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pick { display: flex; }
li[data-on="true"] { box-shadow: inset 2px 0 0 var(--accent); }
.name { min-height: 0; padding: 0; border: 0; background: none; color: var(--ink); font-size: 13px; text-align: left; cursor: pointer; }
.name:hover { border: 0; background: none; color: var(--accent); text-decoration: underline; text-underline-offset: 4px; }
li button:not(.name) { min-height: var(--control-h-sm); }
li button:disabled { opacity: .45; cursor: not-allowed; }

.tip { margin: 16px 0 0; color: var(--ink-muted); font-size: 10px; letter-spacing: .6px; }
</style>