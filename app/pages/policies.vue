<script setup lang="ts">
import { settingsLockFields } from "#shared/schemas";

type Policy = { id: string; revision: number; name: string; documentHash: string; baseRevision: number | null; createdAt: string; assignmentId: string | null; scopeType: string | null; scopeId: string | null; priority: number | null; locks: string | null; mode: string | null };
type ConfigRow = { configurationId: string; kind: string; name: string; revision: number };
const { data, refresh } = await useFetch<Policy[]>("/api/v1/admin/policies", { default: () => [] });
const { data: configs } = await useFetch<ConfigRow[]>("/api/v1/admin/configurations", { default: () => [] });
const { devices, org, enabledDevices, subtreeIds, targets, summary: targetSummary, count: targetCount } = useTargetSelection();

const showEditor = ref(false);
const showTargets = ref(false);

const busy = ref(false);
const form = reactive({ name: "", priority: 0, document: "{}" });
const toast = useToast();

const capabilities = [
  ["profile.readwrite.persist.v1", "档案与课表", "持久"], ["components.layout.persist.v1", "组件布局", "持久"],
  ["automation.workflow.persist.v1", "自动化工作流", "持久"], ["notification.own-provider.send.v1", "远程提醒", "瞬时"],
  ["weather.read-refresh.v1", "天气读取与刷新", "读/瞬时"], ["theme.app.transient.v1", "颜色主题", "瞬时"],
  ["app.lifecycle.v1", "应用重启与退出", "高风险"], ["enrollment.lock.v1", "集控接入锁定", "防解除"],
  ["settings.policy.persist.v1", "设备设置锁定", "持久"],
  ["time.offset.persist.v1", "时间偏移", "持久"],
];
const scopeLabels: Record<string, string> = { school: "学校", organization: "组织", tag: "标签", device: "设备" };

/** 策略文档按顶层节组织，每节可以直接引用配置库中的一个配置。 */
const SECTION_DEFS = [
  { key: "profile", label: "档案与课表", kind: "profile" },
  { key: "components", label: "组件布局", kind: "components" },
  { key: "automation", label: "自动化工作流", kind: "automation" },
  { key: "plugin", label: "插件设置", kind: "plugin" },
] as const;
const sectionEnabled = reactive<Record<string, boolean>>({ profile: false, components: false, automation: false, plugin: false });
const sectionConfigId = reactive<Record<string, string>>({ profile: "", components: "", automation: "", plugin: "" });
const lockList = ref<string[]>([]);
const lockInput = ref("");
const lockPresets = ["/profile", "/components", "/automation", "/plugin", "/settings"];
/** 设置覆盖：keep 不写入本次策略，lock/unlock 只覆盖这一项（invert 见 shared/schemas.ts）。 */
type SettingsKey = (typeof settingsLockFields)[number]["key"];
type OverrideState = "keep" | "lock" | "unlock";
const overrideOptions: { value: OverrideState; label: string }[] = [
  { value: "keep", label: "不动" }, { value: "lock", label: "锁定" }, { value: "unlock", label: "解锁" },
];
const settingsOverride = reactive(
  Object.fromEntries(settingsLockFields.map((field) => [field.key, "keep"])) as Record<SettingsKey, OverrideState>,
);
function setOverride(key: SettingsKey, state: OverrideState) {
  settingsOverride[key] = state;
  rebuildDocument();
}
/** 时间偏移：不调控 / 固定秒数 / 自动对齐集控端时钟。 */
const timeOptions: { value: TimeMode; label: string }[] = [
  { value: "keep", label: "不调控" }, { value: "fixed", label: "固定偏移" }, { value: "auto", label: "自动对齐" },
];
type TimeMode = "keep" | "fixed" | "auto";
const timeMode = ref<TimeMode>("keep");
const timeOffsetSeconds = ref(0);
function setTimeMode(mode: TimeMode) {
  timeMode.value = mode;
  rebuildDocument();
}
/** 追加覆盖：在该目标已有策略之上只应用本次给出的项，而不是整份替换。 */
const appendMode = ref(false);
const overriddenCount = computed(() => settingsLockFields.filter((field) => settingsOverride[field.key] !== "keep").length);
/** 每个已选目标 = 一个作用域；逐个作用域发布同名修订。 */
const scopeRows = computed(() => targets.value.map((target) => {
  if (target.type === "school")
    return { key: "school", type: target.type, id: null as string | null, label: "全校", devices: targetCount.value };
  const id = target.id;
  if (target.type === "organization") {
    const ids = subtreeIds([id]);
    return { key: `organization:${id}`, type: target.type, id, label: `组织 · ${org.value.nodes.find((node) => node.id === id)?.name ?? id.slice(0, 8)}`, devices: enabledDevices.value.filter((device) => device.orgNodeId && ids.has(device.orgNodeId)).length };
  }
  if (target.type === "tag")
    return { key: `tag:${id}`, type: target.type, id, label: `标签 · ${org.value.tags.find((tag) => tag.id === id)?.name ?? id.slice(0, 8)}`, devices: enabledDevices.value.filter((device) => device.tagIds.includes(id)).length };
  return { key: `device:${id}`, type: target.type, id, label: `设备 · ${devices.value.find((device) => device.id === id)?.name ?? id.slice(0, 8)}`, devices: 1 };
}));
function configsOfKind(kind: string) { return configs.value.filter((config) => config.kind === kind); }
function activeRevisionFor(scopeType: string, scopeId: string | null): number {
  const current = (data.value ?? []).find((policy) => policy.assignmentId && policy.scopeType === scopeType && (policy.scopeId ?? null) === scopeId);
  return current?.revision ?? 0;
}
function scopeText(policy: Policy): string {
  if (!policy.scopeType) return "历史修订";
  if (policy.scopeType === "school") return "学校";
  const label = policy.scopeType === "organization" ? org.value.nodes.find((node) => node.id === policy.scopeId)?.name
    : policy.scopeType === "tag" ? org.value.tags.find((tag) => tag.id === policy.scopeId)?.name
      : devices.value.find((device) => device.id === policy.scopeId)?.name;
  return `${scopeLabels[policy.scopeType] ?? policy.scopeType} · ${label ?? (policy.scopeId ?? "").slice(0, 8)}`;
}
/** 可视化勾选哪几节、每节引用哪个配置；结果写入文档 JSON。 */
function rebuildDocument() {
  const document: Record<string, unknown> = {};
  for (const section of SECTION_DEFS)
    if (sectionEnabled[section.key] && sectionConfigId[section.key]) document[section.key] = { $config: sectionConfigId[section.key] };
  const settings: Record<string, boolean> = {};
  for (const field of settingsLockFields) {
    const state = settingsOverride[field.key];
    if (state === "keep") continue;
    settings[field.key] = field.invert ? state === "unlock" : state === "lock";
  }
  if (Object.keys(settings).length) document.settings = settings;
  // time 节：auto 由设备对齐集控端时钟，fixed 直接下发偏移秒数。
  if (timeMode.value === "auto") document.time = { auto: true };
  else if (timeMode.value === "fixed") document.time = { offsetSeconds: Number(timeOffsetSeconds.value) || 0 };
  form.document = JSON.stringify(document, null, 2);
}
function addLock(value: string) {
  const pointer = value.trim();
  if (!pointer) return;
  if (!pointer.startsWith("/")) { toast.err("锁定路径必须是 JSON Pointer，例如 /profile。"); return; }
  if (!lockList.value.includes(pointer)) lockList.value = [...lockList.value, pointer];
  lockInput.value = "";
}
function removeLock(pointer: string) { lockList.value = lockList.value.filter((item) => item !== pointer); }
/** 名称留空时按作用域自动命名，避免一批修订全叫「学校基线」。 */
function autoName(): string {
  const list = scopeRows.value;
  if (list.length === 1) return `${list[0]!.label} 策略`;
  const at = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `策略 ${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}
/** 对每个已选作用域发布一次同名修订；逐个报成功/失败，互不阻塞。 */
async function publish() {
  const list = scopeRows.value;
  if (!list.length) { toast.err("请先选择目标。"); return; }
  const name = form.name.trim() || autoName();
  let document: Record<string, unknown>;
  try { document = JSON.parse(form.document) as Record<string, unknown>; }
  catch { toast.err("策略内容不是有效的 JSON。"); return; }
  if (!Object.keys(document).length) { toast.err("策略内容为空：勾选至少一个节，或在「更多」里填写内容。"); return; }
  if (timeMode.value === "fixed" && (!Number.isFinite(timeOffsetSeconds.value) || Math.abs(timeOffsetSeconds.value) > 86400)) {
    toast.err("时间偏移必须是 -86400 到 86400 之间的秒数。");
    return;
  }
  busy.value = true;
  const done: string[] = []; const failed: string[] = [];
  for (const scope of list) {
    try {
      await $fetch("/api/v1/admin/policies", { method: "POST", headers: { origin: location.origin }, body: { name, baseRevision: activeRevisionFor(scope.type, scope.id), scopeType: scope.type, scopeId: scope.id, priority: form.priority, locks: lockList.value, mode: appendMode.value ? "append" : "replace", document } });
      done.push(scope.label);
    } catch (err) {
      failed.push(`${scope.label}：${(err as { data?: { message?: string } })?.data?.message ?? "发布失败"}`);
    }
  }
  busy.value = false;
  if (done.length) toast.ok(`已发布到 ${done.length} 个作用域：${done.join("、")}。`);
  if (failed.length) toast.err(`失败 ${failed.length} 个作用域：${failed.join("；")}`);
  else showEditor.value = false;
  await refresh();
}
/** 楼栋页「发布策略」深链进来时直接展开编辑器。 */
onMounted(() => { if (useRoute().query.new) showEditor.value = true; });
</script>

<template>
  <PageHeading kicker="让设备按规则执行" title="策略">
    <button type="button" class="ghost" @click="showTargets = true">选择目标</button>
    <button type="button" class="solid" @click="showEditor = true">新建策略</button>
  </PageHeading>
  <TargetPickerDialog v-if="showTargets" @close="showTargets = false" />

  <AppDialog v-if="showEditor" title="新建策略" kicker="发布策略" width="860px" @close="showEditor = false">
    <form id="policy-editor" class="editor" @submit.prevent="publish">
      <label>名称<input v-model="form.name" maxlength="60" placeholder="留空自动命名"></label>
      <label>优先级<input v-model.number="form.priority" type="number"></label>

      <div class="wide targets">
        <div class="target-head">
          <span>已选目标：<strong>{{ targetSummary }}</strong> · {{ targetCount }} 台</span>
          <button type="button" class="ghost" @click="showTargets = true">选择目标</button>
        </div>
        <ul v-if="scopeRows.length" class="scope-rows"><li v-for="scope in scopeRows" :key="scope.key">{{ scope.label }}<small>{{ scope.devices }} 台</small></li></ul>
        <small v-else class="warn">还没选目标，先点「选择目标」。</small>
      </div>

      <fieldset class="wide sections">
        <legend>这次要改什么</legend>
        <div class="mode-row">
          <SwitchToggle v-model="appendMode" label="追加到已有策略" hint="保留设备原有内容，只加上这次的改动" />
        </div>
        <div v-for="section in SECTION_DEFS" :key="section.key" class="section-row">
          <label class="toggle"><input v-model="sectionEnabled[section.key]" type="checkbox" @change="rebuildDocument"><span>{{ section.label }}</span></label>
          <select v-model="sectionConfigId[section.key]" :disabled="!sectionEnabled[section.key]" @change="rebuildDocument">
            <option value="">选择要引用的配置…</option>
            <option v-for="config in configsOfKind(section.kind)" :key="config.configurationId" :value="config.configurationId">{{ config.name }} · R{{ config.revision }}</option>
          </select>
          <small v-if="sectionEnabled[section.key] && !configsOfKind(section.kind).length">配置库里还没有这类配置。</small>
        </div>
        <p class="static">没勾的项保持设备原样。</p>
      </fieldset>

      <fieldset class="wide settings-override">
        <legend>设置覆盖<template v-if="overriddenCount"> · 已覆盖 {{ overriddenCount }} 项</template></legend>
        <div v-for="field in settingsLockFields" :key="field.key" class="override-row">
          <span class="text"><span>{{ field.label }}</span><small>{{ field.hint }}</small></span>
          <div class="seg">
            <button v-for="option in overrideOptions" :key="option.value" type="button" :data-state="option.value" :data-active="settingsOverride[field.key] === option.value ? 'true' : 'false'" @click="setOverride(field.key, option.value)">{{ option.label }}</button>
          </div>
        </div>
        <p class="static">没动的项不写入，只覆盖选了锁定或解锁的项。</p>
      </fieldset>

      <fieldset class="wide settings-override">
        <legend>时间偏移<template v-if="timeMode !== 'keep'"> · 已设置</template></legend>
        <div class="override-row">
          <span class="text"><span>设备时间</span><small>用集控端时间校正设备时间</small></span>
          <div class="seg">
            <button v-for="option in timeOptions" :key="option.value" type="button" :data-state="option.value" :data-active="timeMode === option.value ? 'true' : 'false'" @click="setTimeMode(option.value)">{{ option.label }}</button>
          </div>
        </div>
        <div v-if="timeMode === 'fixed'" class="override-row">
          <span class="text"><span>偏移秒数</span><small>正数提前、负数延后</small></span>
          <input v-model.number="timeOffsetSeconds" type="number" step="0.1" min="-86400" max="86400" @input="rebuildDocument">
        </div>
      </fieldset>

      <details class="wide advanced">
        <summary>更多：锁定路径与手工 JSON</summary>
        <fieldset class="locks">
          <legend>锁定路径</legend>
          <div class="lock-add">
            <input v-model="lockInput" placeholder="/profile 或 /profile/classPlans" @keydown.enter.prevent="addLock(lockInput)">
            <button type="button" @click="addLock(lockInput)">添加</button>
          </div>
          <div v-if="lockList.length" class="chips"><span v-for="pointer in lockList" :key="pointer">{{ pointer }}<button type="button" @click="removeLock(pointer)">×</button></span></div>
          <div class="quick"><button v-for="preset in lockPresets" :key="preset" type="button" @click="addLock(preset)">{{ preset }}</button></div>
        </fieldset>
        <textarea v-model="form.document" rows="12"></textarea>
        <p class="static">可视化改动会覆盖这里的手工编辑。</p>
      </details>
    </form>
    <template #footer>
      <button type="button" class="ghost" @click="showEditor = false">取消</button>
      <button type="submit" form="policy-editor" :disabled="busy || !scopeRows.length">{{ busy ? "发布中…" : targetCount ? `发布到 ${targetCount} 台设备` : scopeRows.length ? `发布到 ${scopeRows.length} 个目标` : "发布" }}</button>
    </template>
  </AppDialog>

  <section class="policy-layout">
    <article class="panel catalog">
      <header class="panel-head"><h2>能做哪些事</h2><span class="micro">公开能力目录</span></header>
      <ul class="list">
        <li v-for="item in capabilities" :key="item[0]">
          <div class="row-main"><strong>{{ item[1] }}</strong><small>{{ item[0] }}</small></div>
          <span class="tag">{{ item[2] }}</span>
        </li>
      </ul>
    </article>
    <article class="panel policies">
      <header class="panel-head"><h2>策略集</h2><span class="micro">{{ data.length }} 个修订</span></header>
      <ul v-if="data.length" class="list">
        <li v-for="policy in data" :key="policy.id">
          <div class="row-main">
            <strong>R{{ policy.revision }} · {{ policy.name }}</strong>
            <small>{{ scopeText(policy) }} · {{ policy.createdAt }}<em v-if="policy.mode === 'append'"> · 追加覆盖</em></small>
          </div>
          <span class="tag">{{ policy.assignmentId ? "生效中" : "历史" }}</span>
        </li>
      </ul>
      <EmptyState v-else title="还没有策略" />
    </article>
  </section>
</template><style scoped>
.editor { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
.editor > label { display: grid; gap: 8px; color: var(--ink-muted); font-size: 11px; letter-spacing: 0.6px; }
.editor input, .editor select, .editor textarea { width: 100%; }
.editor textarea { padding: 12px 14px; line-height: 1.7; resize: vertical; font-family: ui-monospace, monospace; font-size: 12px; }
.wide { grid-column: 1 / -1; }
fieldset { margin: 0; padding: 22px 24px; border: 1px solid var(--line-soft); }
legend { padding: 0 10px; color: var(--ink-muted); font-size: 10px; letter-spacing: 1.2px; }
/* 目标摘要：RhineLab 的 chip 列表。 */
.target-head { display: flex; align-items: center; justify-content: space-between; gap: 14px; }
.target-head span { color: var(--ink-soft); font-size: 12px; }
.target-head strong { color: var(--ink); font-weight: 600; }
.scope-rows { display: flex; flex-wrap: wrap; gap: 8px; margin: 14px 0 0; padding: 0; list-style: none; }
.scope-rows li { display: inline-flex; align-items: center; gap: 10px; padding: 8px 12px; border: 1px solid var(--line); color: var(--ink-soft); font-size: 11px; }
.scope-rows small { color: var(--ink-muted); }
.warn { display: block; margin-top: 12px; color: var(--warning); font-size: 11px; }
.mode-row { margin-bottom: 8px; padding-bottom: 14px; border-bottom: 1px solid var(--line-soft); }
.section-row { display: grid; grid-template-columns: 190px minmax(0, 1fr); align-items: center; gap: 16px; padding: 14px 0; border-bottom: 1px solid var(--line-soft); }
.section-row small { grid-column: 2; color: var(--warning); font-size: 11px; }
.toggle { display: flex; align-items: center; gap: 10px; cursor: pointer; }
.toggle span { font-size: 13px; }
.toggle input { width: 18px; height: 18px; }
.override-row { display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 16px 0; border-bottom: 1px solid var(--line-soft); }
.override-row:last-of-type { border-bottom: 0; }
.text { display: grid; gap: 5px; }
.text > span { font-size: 13px; }
.text small { color: var(--ink-muted); font-size: 11px; }
.override-row input { width: 160px; }
.static { margin: 14px 0 0; color: var(--ink-faint); font-size: 11px; }
.advanced summary { cursor: pointer; color: var(--ink-soft); font-size: 12px; letter-spacing: 0.5px; }
.advanced[open] summary { margin-bottom: 16px; }
.locks { margin-bottom: 14px; }
.lock-add { display: flex; gap: 10px; }
.lock-add input { flex: 1; }
.quick { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.quick button { min-height: 26px; padding: 0 9px; border: 1px solid var(--line); color: var(--ink-muted); font-size: 10px; font-family: ui-monospace, monospace; }
.chips span button { min-height: 0; padding: 0 0 0 4px; border: 0; background: none; color: var(--ink-muted); }
.chips span button:hover { background: none; border: 0; color: var(--bad); }
.policy-layout { display: grid; grid-template-columns: 1fr 1.2fr; gap: 14px; }
.policy-layout .list { margin-top: 18px; }
.catalog li strong { font-size: 14px; }
.tag { flex: none; padding: 5px 10px; border: 1px solid var(--line); color: var(--ink-muted); font-size: 10px; letter-spacing: 0.6px; }
@media (max-width: 900px) {
  .editor { grid-template-columns: 1fr; }
  .section-row { grid-template-columns: 1fr; }
  .section-row small { grid-column: 1; }
  .policy-layout { grid-template-columns: 1fr; }
  .override-row { flex-direction: column; align-items: flex-start; }
}
</style>