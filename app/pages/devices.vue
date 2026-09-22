<script setup lang="ts">
type DeviceRow = { id: string; name: string; pluginVersion: string; appVersion: string; transport: string; lastSeen: string | null; disabledAt: string | null; orgName: string; online: boolean; disabled: boolean };
const { data: devices, refresh } = await useFetch<DeviceRow[]>("/api/v1/admin/devices", { default: () => [] });
const detailId = ref<string | null>(null);
const { can } = useSession();
/** 教师看的是自己绑定的设备：接入入口对他没有意义。 */
const canManage = computed(() => can("devices.write"));
</script>

<template>
  <PageHeading :kicker="canManage ? '每台终端的状态' : '绑定到你的终端'" title="设备">
    <NuxtLink v-if="can('enrollment.write')" to="/enrollment">接入设备</NuxtLink>
  </PageHeading>
  <div v-if="devices.length" class="table-shell">
    <table><thead><tr><th>设备</th><th>组织</th><th>状态</th><th>连接</th><th>插件 / 宿主</th><th>最后联系</th><th></th></tr></thead>
      <tbody><tr v-for="device in devices" :key="device.id" :class="{ selected: detailId === device.id }"><td><strong>{{ device.name }}</strong><small>{{ device.id }}</small></td><td>{{ device.orgName }}</td><td><span class="state" :data-online="device.online" :data-disabled="device.disabled">{{ device.disabled ? "已禁用" : device.online ? "在线" : "离线" }}</span></td><td>{{ device.transport === "websocket" ? "长连接" : "轮询" }}</td><td>{{ device.pluginVersion }} / {{ device.appVersion }}</td><td>{{ device.lastSeen || "从未" }}</td><td class="row-actions"><button type="button" @click="detailId = device.id">详情</button></td></tr></tbody>
    </table>
  </div>
  <EmptyState v-else :title="canManage ? '还没有设备接入' : '还没有绑定到你的设备'" :action="can('enrollment.write') ? '创建接入凭据' : ''" :to="can('enrollment.write') ? '/enrollment' : ''" />
  <DeviceDetailDialog v-if="detailId" :device-id="detailId" @close="detailId = null" @changed="refresh" />
</template>

<style scoped>
.table-shell { margin-top: 16px; overflow: auto; border-top: 1px solid var(--line-strong); }
.account, td:first-child { display: grid; gap: 4px; }
td:first-child strong { font-size: 14px; font-weight: 600; color: var(--ink); }
td small { color: var(--ink-faint); font-size: 10px; letter-spacing: 0.5px; }
tbody tr.selected { background: var(--accent-wash); }
.state { display: inline-flex; align-items: center; gap: 8px; }
.state::before { content: ""; width: 7px; height: 7px; background: var(--ink-faint); }
.state[data-online="true"]::before { background: var(--good); }
.state[data-disabled="true"]::before { background: var(--bad); }
.row-actions { text-align: right; }
.row-actions button { min-height: 0; padding: 0 0 3px; border: 0; border-bottom: 1px solid transparent; background: none; color: var(--ink-muted); font-size: 11px; letter-spacing: 0.5px; }
.row-actions button:hover:not(:disabled) { border-bottom-color: var(--accent); background: none; color: var(--accent); }
button:disabled { opacity: 0.45; cursor: not-allowed; }
</style>
