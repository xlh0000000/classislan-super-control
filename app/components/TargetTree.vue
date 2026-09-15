<script setup lang="ts">
const {
  selection, devices, org, enabledDevices, deviceIds, count, empty, summary, subtreeIds,
  toggleSchool, toggleOrg, toggleTag, toggleDevice, clear,
} = useTargetSelection();

// compact：嵌入下发面板时使用，去掉标题与外层说明，只保留可选择的目标列表。
const { compact = false } = defineProps<{ compact?: boolean }>();

const query = ref("");
const ungrouped = computed(() => enabledDevices.value.filter((device) => !device.orgNodeId));
const visibleDevices = computed(() => {
  const keyword = query.value.trim().toLowerCase();
  if (!keyword) return enabledDevices.value;
  return enabledDevices.value.filter((device) => device.name.toLowerCase().includes(keyword) || device.orgName.toLowerCase().includes(keyword));
});
const nodeDepth = (path: string) => Math.max(0, path.split("/").filter(Boolean).length - 1);
const countInSubtree = (nodeId: string) => {
  const ids = subtreeIds([nodeId]);
  return enabledDevices.value.filter((device) => device.orgNodeId && ids.has(device.orgNodeId)).length;
};
const countInTag = (tagId: string) => enabledDevices.value.filter((device) => device.tagIds.includes(tagId)).length;
</script>

<template>
  <section class="tree" :class="{ compact }">
    <header>
      <div><span>{{ compact ? "PICK TARGETS / 选择目标" : "OPERATION TARGETS / 操作目标" }}</span><strong>{{ empty ? "未选择目标" : summary }}</strong></div>
      <button type="button" class="ghost" :disabled="empty" @click="clear">清空</button>
    </header>
    <p v-if="!compact" class="scope-line">
      <span class="count">{{ count }}</span> 台设备将受影响
      <span v-if="selection.school" class="pill">全校</span>
    </p>

    <label class="row root" :data-on="selection.school">
      <input type="checkbox" :checked="selection.school" @change="toggleSchool()">
      <span>全校设备</span>
      <small>{{ enabledDevices.length }}</small>
    </label>

    <details open>
      <summary>组织 <small>{{ org.nodes.length }}</small></summary>
      <label v-for="node in org.nodes" :key="node.id" class="row" :data-on="selection.orgNodeIds.includes(node.id)" :style="{ paddingLeft: `${8 + nodeDepth(node.path) * 14}px` }">
        <input type="checkbox" :checked="selection.orgNodeIds.includes(node.id)" @change="toggleOrg(node.id)">
        <span>{{ node.name }}</span>
        <small>{{ countInSubtree(node.id) }}</small>
      </label>
      <p v-if="!org.nodes.length" class="hint">尚无组织节点。</p>
    </details>

    <details v-if="org.tags.length" open>
      <summary>标签 <small>{{ org.tags.length }}</small></summary>
      <label v-for="tag in org.tags" :key="tag.id" class="row" :data-on="selection.tagIds.includes(tag.id)">
        <input type="checkbox" :checked="selection.tagIds.includes(tag.id)" @change="toggleTag(tag.id)">
        <i :style="{ background: tag.color }" />
        <span>{{ tag.name }}</span>
        <small>{{ countInTag(tag.id) }}</small>
      </label>
    </details>

    <details open>
      <summary>设备 <small>{{ enabledDevices.length }}</small></summary>
      <input v-model="query" class="search" type="search" placeholder="搜索设备或组织">
      <div class="rows">
        <label v-for="device in visibleDevices" :key="device.id" class="row device" :data-on="selection.deviceIds.includes(device.id)">
          <input type="checkbox" :checked="selection.deviceIds.includes(device.id)" @change="toggleDevice(device.id)">
          <span>{{ device.name }}</span>
          <small><i class="dot" :data-online="device.online" />{{ device.orgName }}</small>
        </label>
      </div>
      <p v-if="!visibleDevices.length" class="hint">没有匹配的设备。</p>
    </details>

    <p v-if="ungrouped.length" class="hint">{{ ungrouped.length }} 台设备未分组，请在上方设备列表中选择。</p>
    <p v-if="!compact" class="hint">已选目标会作用于中间面板的所有操作；设备总数 {{ deviceIds.length }}。</p>
  </section>
</template>

<style scoped>
.tree{display:grid;gap:10px;align-content:start}.tree header{display:flex;justify-content:space-between;align-items:start;gap:8px}.tree header div{display:grid;gap:4px;min-width:0}.tree header span{color:var(--ink-muted);font-size:8px;letter-spacing:.12em}.tree header strong{font-size:13px}.scope-line{display:flex;align-items:center;gap:8px;margin:0;color:var(--ink-soft);font-size:11px}.count{font-size:20px;font-weight:700;color:var(--ink)}.pill{padding:3px 8px;border-radius:9px;background:var(--surface-2);color:var(--ink);font-size:9px}.row{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:10px;min-height:44px;padding:0 10px;border-radius:var(--radius-control-sm);background:var(--surface-2);font-size:12px;cursor:pointer}.row:hover{background:var(--surface-3, var(--surface-2))}.row.root{background:transparent;padding-left:0}.row small{color:var(--ink-muted);font-size:9px;display:inline-flex;align-items:center;gap:5px}.row i:not(.dot){width:9px;height:9px;border-radius:3px;justify-self:start}.row.device small{max-width:112px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}details{display:grid;gap:5px}.rows{display:grid;gap:5px}.tree.compact{gap:8px}.tree.compact .rows{max-height:220px;overflow:auto}.tree.compact .row{min-height:var(--control-h-sm);font-size:11px}summary{display:flex;align-items:center;gap:6px;padding:4px 0;color:var(--ink-muted);font-size:9px;letter-spacing:.1em;cursor:pointer}summary small{font-size:9px}.search{min-height:var(--control-h-sm);padding:0 10px;border:0;border-radius:var(--radius-control-sm);background:var(--surface-2);color:var(--ink);font-size:12px}.hint{margin:0;color:var(--ink-muted);font-size:10px;line-height:1.5}

.row[data-on="true"]{background:var(--surface-3, var(--surface-2));box-shadow:inset 0 0 0 2px var(--accent)}
.tree.compact .row{min-height:var(--control-h-sm);font-size:11px}
</style>