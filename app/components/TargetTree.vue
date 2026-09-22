<script setup lang="ts">
const {
  selection, org, enabledDevices, count, empty, summary, subtreeIds,
  toggleSchool, toggleOrg, toggleTag, toggleDevice, clear,
} = useTargetSelection();

// compact：嵌入目标选择对话框时使用，去掉标题与外层说明，只保留可选择的目标列表。
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
      <div><span class="micro">{{ compact ? "选择目标" : "操作目标" }}</span><strong>{{ empty ? "未选择目标" : summary }}</strong></div>
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
      <p v-if="!org.nodes.length" class="hint">还没有组织节点。</p>
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

    <p v-if="ungrouped.length" class="hint">{{ ungrouped.length }} 台设备没分组，在下面的设备列表里选。</p>
    
  </section>
</template>

<style scoped>
.tree { display: grid; gap: 12px; align-content: start; }
.tree header { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; }
.tree header div { display: grid; gap: 6px; min-width: 0; }
.tree header .micro { color: var(--ink-muted); font-size: 10px; letter-spacing: 1.2px; }
.tree header strong { font-size: 14px; font-weight: 600; }
.scope-line { display: flex; align-items: center; gap: 10px; margin: 0; color: var(--ink-soft); font-size: 11px; }
.count { color: var(--ink); font-size: 20px; font-weight: 600; font-variant-numeric: tabular-nums; }
.pill { padding: 4px 9px; border: 1px solid var(--line); color: var(--ink-soft); font-size: 10px; }
/* 目标行：RhineLab 的发丝行 + hover 洗色。 */
.row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  min-height: 44px;
  padding: 0 10px;
  border-bottom: 1px solid var(--line-soft);
  font-size: 13px;
  cursor: pointer;
  transition: background var(--t-base) var(--ease-enter);
}
.row:hover { background: var(--accent-wash); }
.row[data-on="true"] { background: var(--accent-wash); box-shadow: inset 2px 0 0 var(--accent); }
.row.root { border-bottom-color: var(--line-strong); }
.row small { display: inline-flex; align-items: center; gap: 6px; color: var(--ink-muted); font-size: 10px; letter-spacing: 0.5px; }
.row i:not(.dot) { width: 10px; height: 10px; justify-self: start; }
.row.device small { max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
details { display: grid; gap: 2px; }
.rows { display: grid; gap: 0; }
.tree.compact { gap: 10px; }
.tree.compact .rows { max-height: 240px; overflow: auto; }
summary { display: flex; align-items: center; gap: 8px; padding: 4px 0; color: var(--ink-muted); font-size: 10px; letter-spacing: 1.2px; cursor: pointer; }
.search { min-height: var(--control-h-sm); padding: 0 11px; border: 1px solid var(--line); background: var(--surface-1); color: var(--ink); font-size: 13px; }
.hint { margin: 0; color: var(--ink-muted); font-size: 11px; line-height: 1.7; }
</style>