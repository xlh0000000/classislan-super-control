<script setup lang="ts">
type Layer = {
  revisionId: string; revision: number; name: string; scopeType: string; scopeId: string | null;
  priority: number; lockedPointers: number; sections: string[]; mode?: string;
};
type Payload = {
  device: { id: string; name: string; online: boolean; disabled: boolean; lastSeenAt: string | null };
  layers: Layer[];
  resolved: { revision: number; epoch: number; hash: string; sections: string[]; locks: Record<string, { scopeType: string; scopeId: string | null }> };
  applied: { revision: number; epoch: number; hash: string; driftCount: number };
  inSync: boolean;
};

const props = defineProps<{ deviceId: string }>();
const emit = defineEmits<{ close: [] }>();
const { org } = useTargetSelection();
const toast = useToast();
const data = ref<Payload | null>(null);
const loading = ref(true);

function scopeName(layer: Layer) {
  if (layer.scopeType === "school") return "全校";
  if (layer.scopeType === "organization") return org.value.nodes.find((node) => node.id === layer.scopeId)?.name ?? "已删除组织";
  if (layer.scopeType === "tag") return org.value.tags.find((tag) => tag.id === layer.scopeId)?.name ?? "已删除标签";
  return "本机";
}

/** 同名设备（重复接入产生的记录）靠短 ID 区分，避免把幽灵设备当成在用的那台。 */
const shortId = computed(() => props.deviceId.slice(0, 8));
const seenText = computed(() => {
  const device = data.value?.device;
  if (!device) return "—";
  if (!device.lastSeenAt) return "从未上报";
  const at = new Date(device.lastSeenAt);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${device.online ? "在线" : "离线"} · ${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
});
const statusText = computed(() => {
  const payload = data.value;
  if (!payload) return "—";
  if (payload.inSync) return "已同步";
  if (payload.device.disabled) return "已禁用";
  return payload.device.online ? "待重同步" : "离线未上报";
});

onMounted(async () => {
  try {
    data.value = await $fetch<Payload>(`/api/v1/admin/devices/${props.deviceId}/policies`);
  } catch (error) {
    toast.err((error as { data?: { message?: string } })?.data?.message ?? "加载策略失败。");
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <AppDialog :title="`已应用策略：${data?.device.name ?? deviceId.slice(0, 8)}`" kicker="APPLIED POLICY / 已应用策略" width="720px" @close="emit('close')">
    <p v-if="loading" class="muted">加载中…</p>
    <template v-else-if="data">
      <dl class="summary">
        <div><dt>生效修订</dt><dd>R{{ data.resolved.revision }}</dd></div>
        <div><dt>已应用修订</dt><dd>{{ data.applied.revision ? `R${data.applied.revision}` : "无" }}</dd></div>
        <div><dt>同步状态</dt><dd :data-ok="data.inSync">{{ statusText }}</dd></div>
        <div><dt>最后上报</dt><dd>{{ seenText }}</dd></div>
        <div><dt>漂移计数</dt><dd>{{ data.applied.driftCount }}</dd></div>
      </dl>
      <p class="muted">设备 ID {{ shortId }} · 同名设备按 ID 区分。</p>
      <article class="block">
        <h3>策略层 <small>{{ data.layers.length }}</small></h3>
        <ul>
          <li v-for="layer in data.layers" :key="layer.revisionId">
            <span class="rev">R{{ layer.revision }}</span>
            <span class="name">{{ layer.name }}<em v-if="layer.mode === 'append'">追加覆盖</em></span>
            <small>{{ scopeName(layer) }} · {{ layer.sections.length }} 节 · 锁定 {{ layer.lockedPointers }}</small>
          </li>
          <li v-if="!data.layers.length" class="muted">该设备没有命中任何策略。</li>
        </ul>
      </article>
      <p class="muted">合并后节：{{ data.resolved.sections.join("、") || "无" }}</p>
    </template>
    <p v-else class="muted">未能加载该设备的策略。</p>
  </AppDialog>
</template>

<style scoped>
.summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(118px, 1fr)); gap: 10px; margin: 0 0 14px; }
.summary div { padding: 13px; border-radius: 14px; background: var(--surface-2); }
.summary dt { color: var(--ink-muted); font-size: 9px; letter-spacing: .1em; }
.summary dd { margin: 7px 0 0; font-size: 13px; font-weight: 650; }
.summary dd[data-ok="false"] { color: var(--warning); }
.block { padding: 16px; border-radius: var(--radius-row); background: var(--surface-2); }
h3 { display: flex; gap: 8px; margin: 0 0 10px; font-size: 13px; }
h3 small { color: var(--ink-muted); font-size: 10px; font-weight: 400; }
ul { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }
li { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 10px; padding: 10px 12px; border-radius: var(--radius-row); background: var(--surface-1); font-size: 12px; }
.rev { color: var(--ink-muted); font-size: 10px; }
li small { color: var(--ink-muted); font-size: 10px; }
.name em { margin-left: 6px; padding: 2px 7px; border-radius: 8px; background: var(--surface-2); color: var(--ink-soft); font-size: 9px; font-style: normal; }
.muted { margin: 12px 0 0; }
@media (max-width: 640px) { .summary { grid-template-columns: repeat(2, 1fr); } }
</style>