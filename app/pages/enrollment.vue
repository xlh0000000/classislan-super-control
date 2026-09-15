<script setup lang="ts">
type OrgData = { nodes: { id: string; name: string; path: string }[]; tags: { id: string; name: string; color: string }[] };
const { data: org } = await useFetch<OrgData>("/api/v1/admin/organization", { default: () => ({ nodes: [], tags: [] }) });
const mode = ref<"code" | "bundle">("code");
const expires = ref(60);
const maxUses = ref(20);
const orgNodeId = ref("");
const selectedTags = ref<string[]>([]);
const result = ref<{ token?: string; expiresAt?: string } | null>(null);
const toast = useToast();
const pending = ref(false);

async function createCredential() {
  pending.value = true; result.value = null;
  try {
    result.value = await $fetch<{ token: string; expiresAt: string }>("/api/v1/admin/enrollment-tokens", {
      method: "POST" as const,
      headers: import.meta.client ? { origin: window.location.origin } : undefined,
      body: { kind: mode.value, ttlMinutes: expires.value, maxUses: mode.value === "bundle" ? maxUses.value : 1, orgNodeId: orgNodeId.value || null, tagIds: selectedTags.value },
    });
    toast.ok("接入凭据已创建，仅显示一次。");
  } catch (err) { toast.err((err as { data?: { message?: string } })?.data?.message ?? "创建接入凭据失败。"); }
  finally { pending.value = false; }
}

async function copyToken() {
  if (!result.value?.token) return;
  try { await navigator.clipboard.writeText(result.value.token); toast.ok("已复制到剪贴板。"); }
  catch { toast.err("复制失败，请手动选择凭据文本。"); }
}
</script>

<template>
  <PageHeading kicker="ENROLLMENT / 客户端接入" title="接入设备" description="一次性接入码适合手工部署；预配置包适合批量安装。两者都可绑定组织与标签，并在有效凭据注册后自动激活。" />
  <section class="enroll-grid">
    <button type="button" :class="{ selected: mode === 'code' }" @click="mode = 'code'"><span>01 / MANUAL</span><strong>一次性接入码</strong><p>短时、限次；在插件设置页填写服务地址和接入码。</p></button>
    <button type="button" :class="{ selected: mode === 'bundle' }" @click="mode = 'bundle'"><span>02 / BULK</span><strong>预配置批量包</strong><p>生成带限时引导凭据的配置文件，与插件包一起部署。</p></button>
  </section>
  <section class="creator">
    <label>有效时间（分钟）<input v-model="expires" min="5" max="1440" type="number"></label>
    <label v-if="mode === 'bundle'">允许接入设备数<input v-model="maxUses" min="2" max="1000" type="number"></label>
    <label>绑定组织<select v-model="orgNodeId"><option value="">不分组</option><option v-for="node in org.nodes" :key="node.id" :value="node.id">{{ node.name }}</option></select></label>
    <fieldset v-if="org.tags.length" class="tags"><legend>绑定标签</legend><label v-for="tag in org.tags" :key="tag.id" class="tag"><input v-model="selectedTags" type="checkbox" :value="tag.id"><span :style="{ background: tag.color }" />{{ tag.name }}</label></fieldset>
    <button :disabled="pending" type="button" @click="createCredential">{{ pending ? "正在创建…" : "创建接入凭据" }}</button>

  </section>
  <AppDialog v-if="result" title="接入凭据已创建" kicker="ENROLLMENT / 仅显示一次" width="640px" @close="result = null">
    <p class="hint">关闭后无法再次查看，请立即复制。</p>
    <code class="token">{{ result.token }}</code>
    <small class="muted">到期：{{ result.expiresAt }}</small>
    <template #footer>
      <button type="button" class="ghost" @click="result = null">关闭</button>
      <button type="button" @click="copyToken">复制凭据</button>
    </template>
  </AppDialog>
</template>

<style scoped>
.enroll-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-top: 14px; }.enroll-grid button { min-height: 210px; padding: 27px; border: 0; border-radius: var(--radius-md); background: var(--surface-1); color: var(--ink); text-align: left; cursor: pointer; transition: background 180ms var(--ease-enter), transform 180ms var(--ease-enter); }.enroll-grid button:hover { transform: translateY(-3px); }.enroll-grid button.selected { background: var(--surface-3); }.enroll-grid span { color: var(--ink-muted); font-size: 9px; letter-spacing: .12em; }.enroll-grid strong { display: block; margin: 35px 0 10px; font-size: 24px; }.enroll-grid p { max-width: 440px; color: var(--ink-soft); font-size: 12px; line-height: 1.7; }.creator { display: flex; align-items: end; gap: 12px; flex-wrap: wrap; margin-top: 14px; padding: 24px; border-radius: var(--radius-md); background: var(--surface-1); }.creator > label { display: grid; gap: 8px; color: var(--ink-soft); font-size: 11px; }.creator input, .creator select { width: 170px; min-height: var(--control-h); padding: 0 14px; border: 0; border-radius: 14px; background: var(--surface-2); color: var(--ink); }.creator button { min-height: var(--control-h); padding: 0 18px; border: 0; border-radius: 14px; background: var(--ink); color: var(--canvas); cursor: pointer; }.tags { display: flex; flex-wrap: wrap; gap: 10px; margin: 0; padding: 8px 12px; border: 0; border-radius: 14px; background: var(--surface-2); }.tags legend { padding: 0 4px; color: var(--ink-muted); font-size: 9px; letter-spacing: .1em; }.tag { display: inline-flex; align-items: center; gap: 6px; min-height: 30px; font-size: 11px; color: var(--ink-soft); }.tag input { min-height: 0; accent-color: var(--accent); cursor: pointer; }.tag span { width: 10px; height: 10px; border-radius: 50%; }.hint { margin: 0 0 12px; color: var(--warning); font-size: 11px; }.token { display: block; padding: 16px; border-radius: 16px; background: var(--surface-2); overflow-wrap: anywhere; font-size: 14px; }.muted { display: block; margin-top: 10px; }@media (max-width: 700px) { .enroll-grid { grid-template-columns: 1fr; } }
</style>