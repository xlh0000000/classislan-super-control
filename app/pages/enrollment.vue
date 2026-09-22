<script setup lang="ts">
type OrgData = { nodes: { id: string; name: string; path: string }[]; tags: { id: string; name: string; color: string }[] };
type PolicyOption = { id: string; revision: number; name: string; assignmentId: string | null };
const { data: org } = await useFetch<OrgData>("/api/v1/admin/organization", { default: () => ({ nodes: [], tags: [] }) });
const { data: policyRevisions } = await useFetch<PolicyOption[]>("/api/v1/admin/policies", { default: () => [] });
const mode = ref<"code" | "bundle">("code");
const expires = ref(60);
const maxUses = ref(20);
const orgNodeId = ref("");
const selectedTags = ref<string[]>([]);
/** 新设备的策略底稿：注册时整份照抄所选修订（连锁一起），之后这台机仍可单独再改。 */
const policyRevisionId = ref("");
const result = ref<{ token?: string; expiresAt?: string } | null>(null);
const toast = useToast();
const pending = ref(false);

async function createCredential() {
  pending.value = true; result.value = null;
  try {
    result.value = await $fetch<{ token: string; expiresAt: string }>("/api/v1/admin/enrollment-tokens", {
      method: "POST" as const,
      headers: import.meta.client ? { origin: window.location.origin } : undefined,
      body: {
        kind: mode.value,
        ttlMinutes: expires.value,
        maxUses: mode.value === "bundle" ? maxUses.value : 1,
        orgNodeId: orgNodeId.value || null,
        tagIds: selectedTags.value,
        policyRevisionId: policyRevisionId.value || null,
      },
    });
    toast.ok("接入码已生成，只显示这一次。");
  } catch (err) { toast.err((err as { data?: { message?: string } })?.data?.message ?? "接入码没生成出来。"); }
  finally { pending.value = false; }
}

async function copyToken() {
  if (!result.value?.token) return;
  try { await navigator.clipboard.writeText(result.value.token); toast.ok("已复制到剪贴板。"); }
  catch { toast.err("复制失败，手动选中再复制。"); }
}
</script>

<template>
  <PageHeading kicker="把新设备加进来" title="接入设备" />
  <section class="enroll-grid">
    <button type="button" :class="{ selected: mode === 'code' }" @click="mode = 'code'">
      <span>01</span><strong>一次性接入码</strong><p>在插件里填服务地址和接入码。</p>
    </button>
    <button type="button" :class="{ selected: mode === 'bundle' }" @click="mode = 'bundle'">
      <span>02</span><strong>批量接入码</strong><p>一个码可注册多台，装机时共用。</p>
    </button>
  </section>
  <section class="creator controls">
    <label>有效时间（分钟）<input v-model="expires" min="5" max="1440" type="number"></label>
    <label v-if="mode === 'bundle'">允许接入设备数<input v-model="maxUses" min="2" max="1000" type="number"></label>
    <label>绑定组织<select v-model="orgNodeId"><option value="">不分组</option><option v-for="node in org.nodes" :key="node.id" :value="node.id">{{ node.name }}</option></select></label>
    <fieldset v-if="org.tags.length" class="tags"><legend>绑定标签</legend><label v-for="tag in org.tags" :key="tag.id" class="tag"><input v-model="selectedTags" type="checkbox" :value="tag.id"><span :style="{ background: tag.color }" />{{ tag.name }}</label></fieldset>
    <div class="presets">
      <span class="presets-title">加入时自动下发</span>
      <label class="wide-field">下发策略<select v-model="policyRevisionId"><option value="">不绑定</option><option v-for="item in policyRevisions" :key="item.id" :value="item.id">{{ item.name }} · 第 {{ item.revision }} 版{{ item.assignmentId ? "" : "（历史修订）" }}</option></select></label>
    </div>
    <button :disabled="pending" type="button" @click="createCredential">{{ pending ? "生成中…" : "生成接入码" }}</button>

  </section>
  <AppDialog v-if="result" title="接入码已生成" kicker="只显示这一次" width="640px" @close="result = null">
    <p class="hint">关闭后看不到第二次，先复制。</p>
    <code class="token">{{ result.token }}</code>
    <small class="muted">到期：{{ result.expiresAt }}</small>
    <template #footer>
      <button type="button" class="ghost" @click="result = null">关闭</button>
      <button type="button" class="solid" @click="copyToken">复制接入码</button>
    </template>
  </AppDialog>
</template>

<style scoped>
/* 两种接入方式就地选：RhineLab 的编号微标签 + 发丝框，选中用主填充。 */
.enroll-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.enroll-grid button {
  display: grid;
  align-content: start;
  min-height: 190px;
  padding: 26px 28px;
  border: 1px solid var(--line);
  background: var(--surface-1);
  color: var(--ink);
  text-align: left;
  transition: background var(--t-base) var(--ease-enter), border-color var(--t-base) var(--ease-enter);
}
.enroll-grid button:hover:not(:disabled) { border-color: var(--accent); background: var(--accent-wash); }
.enroll-grid button.selected, .enroll-grid button.selected:hover { border-color: var(--fill); background: var(--fill); color: var(--fill-ink); }
.enroll-grid span { color: var(--ink-faint); font-size: 10px; letter-spacing: 1.4px; }
.enroll-grid button.selected span { color: var(--fill-muted); }
.enroll-grid strong { margin-top: 26px; font-size: 23px; font-weight: 600; letter-spacing: -0.5px; }
.enroll-grid p { max-width: 380px; margin: 10px 0 0; color: var(--ink-soft); font-size: 12px; line-height: 1.7; }
.enroll-grid button.selected p { color: var(--fill-muted); }
.creator { display: flex; align-items: flex-end; gap: 14px; flex-wrap: wrap; margin-top: 14px; padding: 26px 28px; border: 1px solid var(--line-soft); background: var(--surface-1); }
.creator > label { display: grid; gap: 8px; color: var(--ink-muted); font-size: 11px; letter-spacing: 0.6px; }
.creator input, .creator select { width: 170px; }
.tags { display: flex; flex-wrap: wrap; gap: 14px; margin: 0; padding: 8px 0; border: 0; }
.tags legend { padding: 0 6px 0 0; color: var(--ink-muted); font-size: 11px; letter-spacing: 0.6px; }
.tag { display: inline-flex; align-items: center; gap: 7px; font-size: 12px; color: var(--ink-soft); }
.tag span { width: 10px; height: 10px; }
.presets { display: flex; flex: 1 1 100%; flex-wrap: wrap; align-items: flex-end; gap: 14px; margin-top: 8px; padding-top: 16px; border-top: 1px solid var(--line-soft); }
.presets-title { flex: 1 1 100%; color: var(--ink-faint); font-size: 10px; letter-spacing: 1.4px; }
.presets label { display: grid; gap: 8px; color: var(--ink-muted); font-size: 11px; letter-spacing: 0.6px; }
.presets select { width: 200px; }
/* 策略条目要连名字和修订号一起读出，比配置名长一截。 */
.presets label.wide-field select { width: 268px; }
.creator > button { margin-left: auto; }
.hint { margin: 0 0 14px; color: var(--warning); font-size: 12px; }
.token { display: block; padding: 16px; border: 1px solid var(--line); background: var(--surface-2); overflow-wrap: anywhere; font-family: ui-monospace, monospace; font-size: 13px; line-height: 1.7; }
.muted { display: block; margin-top: 12px; }
@media (max-width: 700px) {
  .enroll-grid { grid-template-columns: 1fr; }
  .creator > button { margin-left: 0; }
}
</style>