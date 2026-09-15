<script setup lang="ts">
type TargetResult = { scopeType: string; scopeId: string | null; revision: number; deviceCount: number; replacedSection: boolean };
type DeployResult = { name: string; section: string; deviceCount: number; targets: TargetResult[] };

const props = defineProps<{ configurationId: string; configurationName: string; revision?: number }>();
const emit = defineEmits<{ deployed: [DeployResult]; close: [] }>();

const { devices, org, count, empty, summary, targets } = useTargetSelection();
const toast = useToast();
const busy = ref(false);
const result = ref<DeployResult | null>(null);

const scopeLabels: Record<string, string> = { school: "全校", organization: "组织", tag: "标签", device: "设备" };

function targetLabel(target: TargetResult) {
  if (target.scopeType === "school") return "全校";
  const id = target.scopeId ?? "";
  const name = target.scopeType === "device"
    ? devices.value.find((device) => device.id === id)?.name
    : target.scopeType === "organization"
      ? org.value.nodes.find((node) => node.id === id)?.name
      : org.value.tags.find((tag) => tag.id === id)?.name;
  return `${scopeLabels[target.scopeType] ?? target.scopeType} · ${name ?? id.slice(0, 8)}`;
}

async function deploy() {
  busy.value = true;
  try {
    const response = await $fetch<DeployResult>(`/api/v1/admin/configurations/${props.configurationId}/deploy`, {
      method: "POST",
      headers: { origin: location.origin },
      body: { targets: targets.value },
    });
    result.value = response;
    toast.ok(`已下发「${response.name}」到 ${response.deviceCount} 台设备。`);
    emit("deployed", response);
  } catch (cause) {
    toast.err((cause as { data?: { message?: string } })?.data?.message ?? "下发失败。");
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <AppDialog
    :title="`下发配置：${configurationName}`"
    :kicker="props.revision ? `DEPLOY / 当前修订 R${props.revision}` : 'DEPLOY / 下发配置'"
    width="720px"
    @close="emit('close')"
  >
    <dl class="scope">
      <div><dt>目标</dt><dd>{{ summary }}</dd></div>
      <div><dt>影响</dt><dd>{{ count }} 台设备</dd></div>
    </dl>
    <p class="hint">勾选组织、标签或单台设备；下发会替换这些作用域原有的同名节。</p>
    <TargetTree compact />
    <ul v-if="result" class="result">
      <li v-for="target in result.targets" :key="`${target.scopeType}:${target.scopeId ?? ''}`">
        <span>{{ targetLabel(target) }} · R{{ target.revision }} · {{ target.deviceCount }} 台</span>
        <small v-if="target.replacedSection">已替换该作用域原有的 {{ result.section }} 节</small>
      </li>
    </ul>
    <template #footer>
      <button type="button" class="ghost" @click="emit('close')">取消</button>
      <button type="button" :disabled="busy || empty" @click="deploy">
        {{ busy ? "下发中…" : empty ? "请先选择目标" : `下发到 ${count} 台设备` }}
      </button>
    </template>
  </AppDialog>
</template>

<style scoped>
.scope{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin:0 0 14px}
.scope div{padding:14px;border-radius:14px;background:var(--surface-2)}
.scope dt{color:var(--ink-muted);font-size:9px;letter-spacing:.1em}
.scope dd{margin:8px 0 0;font-size:14px;font-weight:650}
.hint{margin:0 0 10px;color:var(--ink-soft);font-size:11px}
.result{display:grid;gap:6px;margin:14px 0 0;padding:0;list-style:none}
.result li{display:flex;justify-content:space-between;gap:12px;padding:10px 14px;border-radius:var(--radius-row);background:var(--surface-2);font-size:11px}
.result small{color:var(--ink-soft);font-size:9px}
@media (max-width:640px){.scope{grid-template-columns:1fr}}
</style>