<script setup lang="ts">
import { settingsLockFields, settingsPageFields, settingsPagePrefix } from "#shared/schemas";

type ConfigRow = { configurationId: string; kind: string; name: string; currentRevision: number | null };
/** 一个作用域当前的处境：卡面上只留展示要用的字段，锁折算成条数。 */
type ScopeCurrent = { revisionId: string; revision: number; name: string; mode: string; priority: number; createdAt: string; sections: string[]; lockCount: number };
type ScopeRow = { scopeType: string; scopeId: string | null; historyCount: number; current: ScopeCurrent | null };
/** 主视图按作用域类型分组，组内是「这一路现在跑第几版」的卡片；历史修订进抽屉。 */
const SCOPE_GROUPS = [
  { type: "school", label: "全校" }, { type: "organization", label: "组织" }, { type: "tag", label: "标签" }, { type: "device", label: "设备" },
] as const;
const { data: scopeStates, refresh: refreshScopes } = await useFetch<ScopeRow[]>("/api/v1/admin/policies/scopes", { default: () => [] });
const { data: configs } = await useFetch<ConfigRow[]>("/api/v1/admin/configurations", { default: () => [] });
const { devices, org, enabledDevices, subtreeIds, targets, summary: targetSummary, count: targetCount } = useTargetSelection();

const showEditor = ref(false);
const showTargets = ref(false);
/** 点开哪一条修订看详情；空串表示没开。 */
const detailId = ref("");
/** 展开哪一路作用域的历史；null 表示抽屉没开。 */
const history = ref<{ scopeType: string; scopeId: string | null; scopeName: string } | null>(null);

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
  dropCarry("settings");
}
/** 设置页逐页管控：keep 不写入；放开/只读/隐藏对应 page.* 的三态取值。 */
type PageKey = (typeof settingsPageFields)[number]["key"];
type PageState = "keep" | "none" | "readonly" | "hidden";
const pageOverrideOptions: { value: PageState; label: string }[] = [
  { value: "keep", label: "不动" }, { value: "none", label: "放开" }, { value: "readonly", label: "只读" }, { value: "hidden", label: "隐藏" },
];
const pageOverride = reactive(
  Object.fromEntries(settingsPageFields.map((field) => [field.key, "keep"])) as Record<PageKey, PageState>,
);
function setPageOverride(key: PageKey, state: PageState) {
  pageOverride[key] = state;
  dropCarry("settings");
}
/** 时间偏移：不调控 / 固定秒数 / 自动对齐集控端时钟 / 每日自动递增。 */
const timeOptions: { value: TimeMode; label: string }[] = [
  { value: "keep", label: "不调控" }, { value: "fixed", label: "固定偏移" }, { value: "auto", label: "自动对齐" }, { value: "daily", label: "每日自动" },
];
type TimeMode = "keep" | "fixed" | "auto" | "daily";
const timeMode = ref<TimeMode>("keep");
const timeOffsetSeconds = ref(0);
const timeSecondsPerDay = ref(5);
function setTimeMode(mode: TimeMode) {
  timeMode.value = mode;
  dropCarry("time");
}
/** 追加覆盖：在该目标已有策略之上只应用本次给出的项，而不是整份替换。 */
const appendMode = ref(false);
const overriddenCount = computed(() => settingsLockFields.filter((field) => settingsOverride[field.key] !== "keep").length
  + settingsPageFields.filter((field) => pageOverride[field.key] !== "keep").length);
const pageOverriddenCount = computed(() => settingsPageFields.filter((field) => pageOverride[field.key] !== "keep").length);

/** 弹窗按动线分五步；「沿用哪一份已有修订」是逐步各选各的，不是一键全量覆盖。 */
const EDITOR_TABS = [
  { key: "targets", label: "目标" },
  { key: "content", label: "内容" },
  { key: "settings", label: "设置管控" },
  { key: "time", label: "时间" },
  { key: "raw", label: "锁定与原文" },
] as const;
type EditorTab = (typeof EDITOR_TABS)[number]["key"];
/** 目标页没有内容可接，沿用只在其余四页。 */
type InheritTab = Exclude<EditorTab, "targets">;
const INHERIT_TABS = ["content", "settings", "time", "raw"] as const;
const activeTab = ref<EditorTab>("targets");
/** 页脚的前后步：五页是有先后的（先发给谁，再发什么），不是并列的入口。 */
const stepIndex = computed(() => EDITOR_TABS.findIndex((tab) => tab.key === activeTab.value));
const prevTab = computed(() => (stepIndex.value > 0 ? EDITOR_TABS[stepIndex.value - 1]!.key : null));
const nextTab = computed(() => (stepIndex.value < EDITOR_TABS.length - 1 ? EDITOR_TABS[stepIndex.value + 1]!.key : null));
/** 每页选定的沿用来源修订；空串表示本页不沿用。 */
const inherit = reactive<Record<InheritTab, string>>({ content: "", settings: "", time: "", raw: "" });
/**
 * 沿用到本页、控件表达不了的原文，按文档顶层键原样带着（例如整节的字面量、settings 的配置引用）。
 * 本页控件一动就作废：手工改动比抄来的原文更靠近管理员当下的意图。
 */
const carry = reactive<Record<InheritTab, Record<string, unknown>>>({ content: {}, settings: {}, time: {}, raw: {} });
type InheritOption = { id: string; label: string };
type RevisionDetail = {
  id: string; revision: number; name: string; mode: string; createdAt: string;
  document: Record<string, unknown>; locks: string[];
};
/** 已选目标的候选修订，按版本号倒序；内容要等选上某一份才取。 */
const inheritOptions = ref<InheritOption[]>([]);
const revisionDetails = ref<Record<string, RevisionDetail>>({});

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
/** CAS 基线：这一路作用域当前有效的版本号，没有挂过就是 0。 */
function activeRevisionFor(scopeType: string, scopeId: string | null): number {
  const row = (scopeStates.value ?? []).find((scope) => scope.scopeType === scopeType && (scope.scopeId ?? null) === scopeId);
  return row?.current?.revision ?? 0;
}
function scopeName(scopeType: string, scopeId: string | null): string {
  if (scopeType === "school") return "全校";
  const id = scopeId ?? "";
  if (scopeType === "organization") return org.value.nodes.find((node) => node.id === id)?.name ?? "已删除的组织";
  if (scopeType === "tag") return org.value.tags.find((tag) => tag.id === id)?.name ?? "已删除的标签";
  return devices.value.find((device) => device.id === id)?.name ?? "已删除的设备";
}
/** 卡片上的台数按当前设备台账现算：删掉或停用的设备不再计入，即使这一路策略还挂着。 */
function scopeDeviceCount(scopeType: string, scopeId: string | null): number {
  if (scopeType === "school") return enabledDevices.value.length;
  const id = scopeId ?? "";
  if (scopeType === "organization") {
    const ids = subtreeIds([id]);
    return enabledDevices.value.filter((device) => device.orgNodeId && ids.has(device.orgNodeId)).length;
  }
  if (scopeType === "tag") return enabledDevices.value.filter((device) => device.tagIds.includes(id)).length;
  return enabledDevices.value.some((device) => device.id === id) ? 1 : 0;
}
const groups = computed(() => SCOPE_GROUPS.map((group) => ({
  ...group,
  cards: (scopeStates.value ?? [])
    .filter((row) => row.scopeType === group.type)
    .map((row) => ({
      key: `${row.scopeType}:${row.scopeId ?? ""}`,
      scopeType: row.scopeType,
      scopeId: row.scopeId,
      historyCount: row.historyCount,
      current: row.current,
      name: scopeName(row.scopeType, row.scopeId),
      devices: scopeDeviceCount(row.scopeType, row.scopeId),
    }))
    // 有生效策略的排前面、版本号新的排前面，全空时退回按名字，设备一多也能找到。
    .sort((a, b) => (b.current?.revision ?? 0) - (a.current?.revision ?? 0) || a.name.localeCompare(b.name, "zh-CN")),
})).filter((group) => group.cards.length));
/** 可视化勾选哪几节、每节引用哪个配置；结果写入文档 JSON。 */
function rebuildDocument() {
  const document: Record<string, unknown> = {};
  for (const section of SECTION_DEFS) {
    if (sectionEnabled[section.key] && sectionConfigId[section.key]) document[section.key] = { $config: sectionConfigId[section.key] };
    else if (carry.content[section.key] !== undefined) document[section.key] = carry.content[section.key];
  }
  // 内容页沿用到、但不属于这四节的顶层节（例如插件自己写的节）也照原样带走。
  for (const [key, value] of Object.entries(carry.content)) {
    if (!SECTION_DEFS.some((section) => section.key === key)) document[key] = value;
  }
  const settings = carry.settings.settings ?? buildSettingsSection();
  if (settings) document.settings = settings;
  const time = carry.time.time ?? buildTimeSection();
  if (time) document.time = time;
  form.document = JSON.stringify(document, null, 2);
}
/** settings 节：只写动过的项，keep 不落笔。拆出来是给沿用做回环校验用的。 */
function buildSettingsSection(): Record<string, boolean | string> | null {
  const settings: Record<string, boolean | string> = {};
  for (const field of settingsLockFields) {
    const state = settingsOverride[field.key];
    if (state === "keep") continue;
    settings[field.key] = field.invert ? state === "unlock" : state === "lock";
  }
  for (const field of settingsPageFields) {
    const state = pageOverride[field.key];
    if (state !== "keep") settings[`${settingsPagePrefix}${field.key}`] = state;
  }
  return Object.keys(settings).length ? settings : null;
}
/** time 节：auto 由设备对齐集控端时钟，fixed 直接下发偏移秒数，daily 每日自动递增（可带基线秒数）。 */
function buildTimeSection(): Record<string, unknown> | null {
  if (timeMode.value === "auto") return { auto: true };
  if (timeMode.value === "fixed") return { offsetSeconds: Number(timeOffsetSeconds.value) || 0 };
  if (timeMode.value === "daily") {
    const perDay = Number(timeSecondsPerDay.value) || 0;
    const base = Number(timeOffsetSeconds.value) || 0;
    return { ...(base ? { offsetSeconds: base } : {}), daily: { enabled: true, secondsPerDay: perDay } };
  }
  return null;
}
function addLock(value: string) {
  const pointer = value.trim();
  if (!pointer) return;
  if (!pointer.startsWith("/")) { toast.err("锁定路径要以 / 开头，例如 /profile。"); return; }
  if (!lockList.value.includes(pointer)) lockList.value = [...lockList.value, pointer];
  lockInput.value = "";
}
function removeLock(pointer: string) { lockList.value = lockList.value.filter((item) => item !== pointer); }

/** 候选与展示都用得着的窄类型：列表只回这一路挂过哪几版，内容另有详情接口。 */
type ScopeHistoryRow = { id: string; revision: number; name: string; isCurrent: boolean };
/** 一列已沿用的具体内容：value 是人话，json 是控件装不下的原文。 */
type InheritRow = { label: string; value: string; json?: string };

/** 换目标就得重取候选：沿用来源只从已选目标自己挂过的修订里挑。 */
const scopeSignature = computed(() => scopeRows.value.map((scope) => `${scope.type}:${scope.id ?? ""}`).join("|"));
async function loadInheritOptions() {
  const groups = await Promise.all(scopeRows.value.map(async (scope) => {
    try {
      const rows = await $fetch<ScopeHistoryRow[]>("/api/v1/admin/policies/history",
        { query: { scopeType: scope.type, scopeId: scope.id ?? "" } });
      return rows.map((row) => ({ ...row, scopeLabel: scope.label }));
    } catch { return []; }
  }));
  const rows = groups.flat().sort((a, b) => b.revision - a.revision);
  inheritOptions.value = rows.map((row) => ({
    id: row.id,
    label: `${row.scopeLabel} · ${revisionLabel(row.revision)} ${row.name}${row.isCurrent ? "（生效中）" : ""}`,
  }));
  // 换目标后原来选的那份可能已不在候选里，别让某页挂在一个看不见的来源上。
  const ids = new Set(rows.map((row) => row.id));
  for (const tab of INHERIT_TABS) if (inherit[tab] && !ids.has(inherit[tab])) resetInherit(tab);
}
watch(showEditor, (open) => { if (open) void loadInheritOptions(); });
watch(scopeSignature, () => { if (showEditor.value) void loadInheritOptions(); });

function resetInherit(tab: InheritTab) {
  inherit[tab] = "";
  carry[tab] = {};
  rebuildDocument();
}
/** 手工改动优先于抄来的原文：本页控件一动，从沿用带来的原文就让位。 */
function dropCarry(tab: InheritTab, key?: string) {
  if (key) delete carry[tab][key];
  else carry[tab] = {};
  rebuildDocument();
}
async function revisionDetail(id: string): Promise<RevisionDetail | null> {
  const cached = revisionDetails.value[id];
  if (cached) return cached;
  try {
    const detail = await $fetch<RevisionDetail>(`/api/v1/admin/policies/${id}`);
    revisionDetails.value = { ...revisionDetails.value, [id]: detail };
    return detail;
  } catch {
    toast.err("读不到这份修订的内容，请重试。");
    return null;
  }
}
/** 选定本页的沿用来源：把那一版属于本页的部分接进来。 */
async function pickInherit(tab: InheritTab, id: string) {
  resetInherit(tab);
  if (!id) return;
  inherit[tab] = id;
  const detail = await revisionDetail(id);
  if (!detail || inherit[tab] !== id) return;
  if (tab === "content") applyContentInherit(detail);
  else if (tab === "settings") applySettingsInherit(detail);
  else if (tab === "time") applyTimeInherit(detail);
  else applyRawInherit(detail);
}
/** 「锁定与原文」页上的整份照搬：四页各自接一遍，接不上的自然落到原文带走。 */
function applyWholeInherit(id: string) {
  const detail = revisionDetails.value[id];
  if (!detail) return;
  for (const tab of INHERIT_TABS) { inherit[tab] = id; carry[tab] = {}; }
  applyContentInherit(detail);
  applySettingsInherit(detail);
  applyTimeInherit(detail);
  applyRawInherit(detail);
}
function applyContentInherit(detail: RevisionDetail) {
  carry.content = {};
  for (const section of SECTION_DEFS) {
    sectionEnabled[section.key] = false;
    sectionConfigId[section.key] = "";
    const value = detail.document[section.key];
    if (value === undefined) continue;
    // 只有还指得上号（配置在库里、类型对得上这一节）才接成可视化引用，否则整节原样带着。
    const referenced = configReference(value);
    const config = referenced ? configs.value.find((item) => item.configurationId === referenced && item.kind === section.kind) : undefined;
    if (referenced && config) {
      sectionEnabled[section.key] = true;
      sectionConfigId[section.key] = referenced;
    } else carry.content[section.key] = value;
  }
  rebuildDocument();
}
function applySettingsInherit(detail: RevisionDetail) {
  carry.settings = {};
  const record = asRecord(detail.document.settings);
  for (const field of settingsLockFields) {
    const value = record?.[field.key];
    settingsOverride[field.key] = typeof value === "boolean" ? ((field.invert ? !value : value) ? "lock" : "unlock") : "keep";
  }
  for (const field of settingsPageFields) {
    const value = record?.[`${settingsPagePrefix}${field.key}`];
    pageOverride[field.key] = typeof value === "string" && pageOverrideOptions.some((option) => option.value === value)
      ? value as PageState : "keep";
  }
  // 回环对不上（整节引用、没见过的键）就说明控件装不下这一版：退回原文带走，不假装接上了。
  if (detail.document.settings !== undefined && !sameRecord(buildSettingsSection(), record)) {
    for (const field of settingsLockFields) settingsOverride[field.key] = "keep";
    for (const field of settingsPageFields) pageOverride[field.key] = "keep";
    carry.settings.settings = detail.document.settings;
  }
  rebuildDocument();
}
function applyTimeInherit(detail: RevisionDetail) {
  carry.time = {};
  const record = asRecord(detail.document.time);
  const daily = asRecord(record?.daily);
  timeMode.value = "keep";
  timeOffsetSeconds.value = 0;
  timeSecondsPerDay.value = 5;
  if (record?.auto === true) timeMode.value = "auto";
  else if (daily?.enabled === true) {
    timeMode.value = "daily";
    timeSecondsPerDay.value = Number(daily.secondsPerDay) || 0;
    timeOffsetSeconds.value = Number(record?.offsetSeconds) || 0;
  } else if (typeof record?.offsetSeconds === "number") {
    timeMode.value = "fixed";
    timeOffsetSeconds.value = record.offsetSeconds;
  }
  if (detail.document.time !== undefined && !sameRecord(buildTimeSection(), record)) {
    timeMode.value = "keep";
    timeOffsetSeconds.value = 0;
    timeSecondsPerDay.value = 5;
    carry.time.time = detail.document.time;
  }
  rebuildDocument();
}
function applyRawInherit(detail: RevisionDetail) {
  lockList.value = [...detail.locks];
  rebuildDocument();
}

/** 内容页接过来的到底是什么：逐节说清引用了哪份配置，或者带的是原文。 */
const contentRows = computed<InheritRow[]>(() => {
  const detail = inherit.content ? revisionDetails.value[inherit.content] : undefined;
  if (!detail) return [];
  const rows: InheritRow[] = [];
  for (const section of SECTION_DEFS) {
    const value = detail.document[section.key];
    if (value === undefined) continue;
    const referenced = configReference(value);
    const config = referenced ? configs.value.find((item) => item.configurationId === referenced && item.kind === section.kind) : undefined;
    rows.push(config
      ? { label: section.label, value: `引用配置「${config.name}」· ${revisionLabel(config.currentRevision)}` }
      : { label: section.label, value: "整节原文照搬", json: JSON.stringify(value, null, 2) });
  }
  for (const [key, value] of Object.entries(detail.document)) {
    if (SECTION_DEFS.some((section) => section.key === key) || key === "settings" || key === "time") continue;
    rows.push({ label: labelOf(POLICY_SECTION_LABELS, key), value: "整节原文照搬", json: JSON.stringify(value, null, 2) });
  }
  return rows;
});
const settingsRows = computed<InheritRow[]>(() => {
  const detail = inherit.settings ? revisionDetails.value[inherit.settings] : undefined;
  if (!detail || detail.document.settings === undefined) return [];
  if (carry.settings.settings !== undefined)
    return [{ label: labelOf(POLICY_SECTION_LABELS, "settings"), value: "控件装不下这一版，按原文带走", json: JSON.stringify(carry.settings.settings, null, 2) }];
  const record = asRecord(detail.document.settings);
  if (!record) return [];
  const rows: InheritRow[] = [];
  for (const field of settingsLockFields) {
    const value = record[field.key];
    if (typeof value === "boolean")
      rows.push({ label: field.label, value: optionLabel(overrideOptions, (field.invert ? !value : value) ? "lock" : "unlock") });
  }
  for (const field of settingsPageFields) {
    const value = record[`${settingsPagePrefix}${field.key}`];
    if (typeof value === "string" && pageOverrideOptions.some((option) => option.value === value))
      rows.push({ label: field.label, value: optionLabel(pageOverrideOptions, value as PageState) });
  }
  return rows;
});
const timeRows = computed<InheritRow[]>(() => {
  const detail = inherit.time ? revisionDetails.value[inherit.time] : undefined;
  if (!detail || detail.document.time === undefined) return [];
  if (carry.time.time !== undefined)
    return [{ label: labelOf(POLICY_SECTION_LABELS, "time"), value: "控件装不下这一版，按原文带走", json: JSON.stringify(carry.time.time, null, 2) }];
  const record = asRecord(detail.document.time);
  if (!record) return [];
  const daily = asRecord(record.daily);
  if (record.auto === true) return [{ label: "设备时间", value: "自动对齐集控端时钟" }];
  if (daily?.enabled === true) {
    const base = Number(record.offsetSeconds) ? `，基线 ${signedSeconds(Number(record.offsetSeconds))}` : "";
    return [{ label: "设备时间", value: `每日递增 ${signedSeconds(Number(daily.secondsPerDay) || 0)}${base}` }];
  }
  return [{ label: "设备时间", value: `固定偏移 ${signedSeconds(Number(record.offsetSeconds) || 0)}` }];
});
/** 锁定与原文页：锁逐条列出，整份内容给原文，管理员要抄的是这一版的本来面目。 */
const rawRows = computed<InheritRow[]>(() => {
  const detail = inherit.raw ? revisionDetails.value[inherit.raw] : undefined;
  if (!detail) return [];
  const sections = Object.keys(detail.document);
  return [
    { label: "锁定路径", value: detail.locks.length ? detail.locks.join("、") : "无" },
    {
      label: "整份内容",
      value: sections.length ? sections.map((key) => labelOf(POLICY_SECTION_LABELS, key)).join("、") : "空文档",
      json: JSON.stringify(detail.document, null, 2),
    },
  ];
});
const inheritNotice = computed(() => (inheritOptions.value.length ? "" : "已选目标还没挂过策略。"));

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
/** 只带一个 $config 键的对象 = 整节引用配置库条目，与 service 侧 isConfigReference 同形。 */
function configReference(value: unknown): string | null {
  const record = asRecord(value);
  if (!record || Object.keys(record).length !== 1) return null;
  return typeof record.$config === "string" ? record.$config : null;
}
/** 逐键比内容、不比键序：库里存的键序跟着当年的界面走，比顺序会把等价的两份判成不同。 */
function sameRecord(left: Record<string, unknown> | null, right: Record<string, unknown> | null): boolean {
  const a = left ?? {};
  const b = right ?? {};
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)]))
    if (JSON.stringify(a[key] ?? null) !== JSON.stringify(b[key] ?? null)) return false;
  return true;
}
function optionLabel<T extends string>(options: { value: T; label: string }[], value: T): string {
  return options.find((option) => option.value === value)?.label ?? value;
}
function signedSeconds(value: number): string {
  return `${value > 0 ? "+" : ""}${value} 秒`;
}

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
  catch { toast.err("策略内容格式有误，请检查后再试。"); return; }
  if (!Object.keys(document).length) { toast.err("策略内容为空：勾选至少一个节，或在「更多」里填写内容。"); return; }
  if ((timeMode.value === "fixed" || timeMode.value === "daily") && (!Number.isFinite(timeOffsetSeconds.value) || Math.abs(timeOffsetSeconds.value) > 86400)) {
    toast.err("偏移秒数必须是 -86400 到 86400 之间的数。");
    return;
  }
  if (timeMode.value === "daily" && (!Number.isFinite(timeSecondsPerDay.value) || Math.abs(timeSecondsPerDay.value) > 86400)) {
    toast.err("每日递增秒数必须是 -86400 到 86400 之间的数。");
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
  await refreshScopes();
  // 有目标失败时弹窗还开着：刚发布的那一版要立刻能当沿用来源，不然候选列表是旧的。
  if (failed.length) await loadInheritOptions();
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
  <PolicyDetailDialog v-if="detailId" :revision-id="detailId" @close="detailId = ''" />

  <AppDialog v-if="showEditor" title="新建策略" kicker="发布策略" width="1080px" @close="showEditor = false">
    <form id="policy-editor" class="editor" @submit.prevent="publish">
      <PageTabs v-model="activeTab" :items="EDITOR_TABS" />

      <section v-if="activeTab === 'targets'" class="tab-body">
        <div class="pair">
          <label>名称<input v-model="form.name" maxlength="60" placeholder="留空自动命名"></label>
          <label>优先级<input v-model.number="form.priority" type="number"></label>
        </div>
        <fieldset class="targets">
          <legend>发到哪一路</legend>
          <div class="target-head">
            <span>已选目标：<strong>{{ targetSummary }}</strong> · {{ targetCount }} 台</span>
            <button type="button" class="ghost" @click="showTargets = true">选择目标</button>
          </div>
          <ul v-if="scopeRows.length" class="scope-rows"><li v-for="scope in scopeRows" :key="scope.key">{{ scope.label }}<small>{{ scope.devices }} 台</small></li></ul>
          <small v-else class="warn">还没选目标。</small>
        </fieldset>
        <fieldset>
          <legend>怎么落到已有策略上</legend>
          <SwitchToggle v-model="appendMode" label="追加到已有策略" hint="保留设备原有内容，只加上这次的改动" />
        </fieldset>
      </section>

      <section v-else-if="activeTab === 'content'" class="tab-body">
        <PolicyInheritPicker
          :model-value="inherit.content"
          :options="inheritOptions"
          :rows="contentRows"
          :notice="inheritNotice"
          @update:model-value="pickInherit('content', $event)"
        />
        <fieldset>
          <legend>这次要改什么</legend>
          <div v-for="section in SECTION_DEFS" :key="section.key" class="section-row">
            <label class="toggle"><input v-model="sectionEnabled[section.key]" type="checkbox" @change="dropCarry('content', section.key)"><span>{{ section.label }}</span></label>
            <select v-model="sectionConfigId[section.key]" :disabled="!sectionEnabled[section.key]" @change="dropCarry('content', section.key)">
              <option value="">选择要引用的配置…</option>
              <option v-for="config in configsOfKind(section.kind)" :key="config.configurationId" :value="config.configurationId">{{ config.name }} · {{ revisionLabel(config.currentRevision) }}</option>
            </select>
            <small v-if="carry.content[section.key] !== undefined" class="lit">已沿用整节原文</small>
            <small v-else-if="sectionEnabled[section.key] && !configsOfKind(section.kind).length">配置库里还没有这类配置。</small>
          </div>
          <p class="static">没勾的项保持设备原样。</p>
        </fieldset>
      </section>

      <section v-else-if="activeTab === 'settings'" class="tab-body">
        <PolicyInheritPicker
          :model-value="inherit.settings"
          :options="inheritOptions"
          :rows="settingsRows"
          :notice="inheritNotice"
          @update:model-value="pickInherit('settings', $event)"
        />
        <fieldset>
          <legend>设置覆盖<template v-if="overriddenCount"> · 已覆盖 {{ overriddenCount }} 项</template></legend>
          <div v-for="field in settingsLockFields" :key="field.key" class="override-row">
            <span class="text"><span>{{ field.label }}</span><small>{{ field.hint }}</small></span>
            <div class="seg">
              <button v-for="option in overrideOptions" :key="option.value" type="button" :data-state="option.value" :data-active="settingsOverride[field.key] === option.value ? 'true' : 'false'" @click="setOverride(field.key, option.value)">{{ option.label }}</button>
            </div>
          </div>
          <p class="static">没动的项不写入，只覆盖选了锁定或解锁的项。</p>
        </fieldset>
        <fieldset>
          <legend>设置页管控<template v-if="pageOverriddenCount"> · 已设置 {{ pageOverriddenCount }} 页</template></legend>
          <div v-for="field in settingsPageFields" :key="field.key" class="override-row">
            <span class="text"><span>{{ field.label }}</span><small>只读 = 可见不可改；隐藏 = 从设置导航与深链中移除</small></span>
            <div class="seg">
              <button v-for="option in pageOverrideOptions" :key="option.value" type="button" :data-state="option.value" :data-active="pageOverride[field.key] === option.value ? 'true' : 'false'" @click="setPageOverride(field.key, option.value)">{{ option.label }}</button>
            </div>
          </div>
          <p class="static">逐页管控精确到设置页的每个大项；「放开」会显式解除该页此前的限制。</p>
        </fieldset>
      </section>

      <section v-else-if="activeTab === 'time'" class="tab-body">
        <PolicyInheritPicker
          :model-value="inherit.time"
          :options="inheritOptions"
          :rows="timeRows"
          :notice="inheritNotice"
          @update:model-value="pickInherit('time', $event)"
        />
        <fieldset>
          <legend>时间偏移<template v-if="timeMode !== 'keep'"> · 已设置</template></legend>
          <div class="override-row">
            <span class="text"><span>设备时间</span><small>用集控端时间校正设备时间</small></span>
            <div class="seg">
              <button v-for="option in timeOptions" :key="option.value" type="button" :data-state="option.value" :data-active="timeMode === option.value ? 'true' : 'false'" @click="setTimeMode(option.value)">{{ option.label }}</button>
            </div>
          </div>
          <div v-if="timeMode === 'fixed'" class="override-row">
            <span class="text"><span>偏移秒数</span><small>正数提前、负数延后</small></span>
            <input v-model.number="timeOffsetSeconds" type="number" step="0.1" min="-86400" max="86400" @input="dropCarry('time')">
          </div>
          <template v-else-if="timeMode === 'daily'">
            <div class="override-row">
              <span class="text"><span>每日递增秒数</span><small>每天零点偏移自动累加该秒数（负数则递减）</small></span>
              <input v-model.number="timeSecondsPerDay" type="number" step="0.1" min="-86400" max="86400" @input="dropCarry('time')">
            </div>
            <div class="override-row">
              <span class="text"><span>基线秒数（可选）</span><small>留空以设备接管前的本机偏移为基线</small></span>
              <input v-model.number="timeOffsetSeconds" type="number" step="0.1" min="-86400" max="86400" @input="dropCarry('time')">
            </div>
          </template>
        </fieldset>
      </section>

      <section v-else class="tab-body">
        <PolicyInheritPicker
          :model-value="inherit.raw"
          :options="inheritOptions"
          :rows="rawRows"
          :notice="inheritNotice"
          @update:model-value="pickInherit('raw', $event)"
        />
        <button v-if="inherit.raw" type="button" class="ghost copy-whole" @click="applyWholeInherit(inherit.raw)">四页一起照搬这一版</button>
        <fieldset class="locks">
          <legend>锁定路径</legend>
          <div class="lock-add">
            <input v-model="lockInput" placeholder="/profile 或 /profile/classPlans" @keydown.enter.prevent="addLock(lockInput)">
            <button type="button" @click="addLock(lockInput)">添加</button>
          </div>
          <div v-if="lockList.length" class="chips"><span v-for="pointer in lockList" :key="pointer">{{ pointer }}<button type="button" @click="removeLock(pointer)">×</button></span></div>
          <div class="quick"><button v-for="preset in lockPresets" :key="preset" type="button" @click="addLock(preset)">{{ preset }}</button></div>
        </fieldset>
        <fieldset>
          <legend>本次内容</legend>
          <textarea v-model="form.document" rows="14"></textarea>
          <p class="static">前面几页的改动都会重写这里；直接改这里以最后一次改动为准。</p>
        </fieldset>
      </section>
    </form>
    <template #footer>
      <button type="button" class="ghost" @click="showEditor = false">取消</button>
      <button v-if="prevTab" type="button" class="ghost" @click="activeTab = prevTab">上一步</button>
      <button v-if="nextTab" type="button" @click="activeTab = nextTab">下一步</button>
      <button type="submit" form="policy-editor" :disabled="busy || !scopeRows.length">{{ busy ? "发布中…" : targetCount ? `发布到 ${targetCount} 台设备` : scopeRows.length ? `发布到 ${scopeRows.length} 个目标` : "发布" }}</button>
    </template>
  </AppDialog>

  <section class="scope-board">
    <template v-if="groups.length">
      <section v-for="group in groups" :key="group.type" class="group">
        <header class="panel-head"><h2>{{ group.label }}</h2><span class="micro">{{ group.cards.length }} 路</span></header>
        <div class="cards">
          <article v-for="card in group.cards" :key="card.key" class="card" :data-empty="!card.current" :data-clickable="!!card.current" @click="card.current && (detailId = card.current.revisionId)">
            <header class="card-head">
              <strong>{{ card.name }}</strong>
              <span class="micro">{{ card.devices }} 台</span>
            </header>
            <p v-if="card.current" class="rev">生效中 · 第 {{ card.current.revision }} 版 {{ card.current.name }}<em v-if="card.current.mode === 'append'">（追加覆盖）</em></p>
            <p v-else class="rev none">当前没有生效策略</p>
            <span v-if="card.current" class="chips">
              <code v-for="section in card.current.sections" :key="section">{{ labelOf(POLICY_SECTION_LABELS, section) }}</code>
              <code v-if="!card.current.sections.length" class="none">空文档</code>
              <code v-if="card.current.lockCount" class="lock">锁 {{ card.current.lockCount }} 处</code>
            </span>
            <footer class="card-foot">
              <small v-if="card.current">{{ timeLabel(card.current.createdAt) }} · 优先级 {{ card.current.priority }}</small>
              <button type="button" class="history" @click.stop="history = { scopeType: card.scopeType, scopeId: card.scopeId, scopeName: card.name }">历史 {{ card.historyCount }} 版</button>
            </footer>
          </article>
        </div>
      </section>
    </template>
    <EmptyState v-else title="还没有挂过策略">
      <template #action><button type="button" @click="showEditor = true">新建策略</button></template>
    </EmptyState>
  </section>
  <PolicyHistoryDrawer v-if="history" :scope-type="history.scopeType" :scope-id="history.scopeId" :scope-name="history.scopeName" @close="history = null" @inspect="detailId = $event" />

  <article class="panel catalog">
    <header class="panel-head"><h2>能做哪些事</h2><span class="micro">公开能力目录</span></header>
    <ul class="list">
      <li v-for="item in capabilities" :key="item[0]">
        <div class="row-main"><strong>{{ item[1] }}</strong><small>{{ item[0] }}</small></div>
        <span class="tag">{{ item[2] }}</span>
      </li>
    </ul>
  </article>
</template><style scoped>
.editor { display: grid; gap: 4px; }
.editor input, .editor select, .editor textarea { width: 100%; }
.editor textarea { padding: 12px 14px; line-height: 1.7; resize: vertical; font-family: ui-monospace, monospace; font-size: 12px; }
.tab-body { display: grid; gap: 18px; }
.pair { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
.pair label { display: grid; gap: 8px; color: var(--ink-muted); font-size: 11px; letter-spacing: 0.6px; }
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
.section-row { display: grid; grid-template-columns: 190px minmax(0, 1fr); align-items: center; gap: 16px; padding: 14px 0; border-bottom: 1px solid var(--line-soft); }
.section-row small { grid-column: 2; color: var(--warning); font-size: 11px; }
.section-row small.lit { color: var(--ink-muted); }
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
.copy-whole { justify-self: start; }
.lock-add { display: flex; gap: 10px; }
.lock-add input { flex: 1; }
.quick { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.quick button { min-height: 26px; padding: 0 9px; border: 1px solid var(--line); color: var(--ink-muted); font-size: 10px; font-family: ui-monospace, monospace; }
.chips span button { min-height: 0; padding: 0 0 0 4px; border: 0; background: none; color: var(--ink-muted); }
.chips span button:hover { background: none; border: 0; color: var(--bad); }
.catalog li strong { font-size: 14px; }
.tag { flex: none; padding: 5px 10px; border: 1px solid var(--line); color: var(--ink-muted); font-size: 10px; letter-spacing: 0.6px; }
/* 作用域卡片墙：一路作用域一张卡，卡面上只有当前生效那一版要看的字段。 */
.scope-board { display: grid; gap: 28px; }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(236px, 1fr)); gap: 12px; margin-top: 16px; }
.card {
  display: grid;
  gap: 10px;
  align-content: start;
  padding: 16px 18px;
  border: 1px solid var(--line);
  background: var(--surface-1);
  transition: border-color var(--t-base) var(--ease-enter), background var(--t-base) var(--ease-enter);
}
.card[data-clickable="true"] { cursor: pointer; }
.card[data-clickable="true"]:hover { border-color: var(--accent); background: var(--accent-wash); }
.card[data-empty="true"] { border-style: dashed; }
.card-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.card-head strong { font-size: 15px; font-weight: 600; overflow-wrap: anywhere; }
.rev { margin: 0; color: var(--ink-soft); font-size: 12px; }
.rev em { color: var(--ink-muted); font-style: normal; }
.rev.none { color: var(--ink-faint); }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chips code { padding: 3px 8px; border: 1px solid var(--line); color: var(--ink-soft); font-size: 10px; }
.chips code.none, .chips code.lock { color: var(--ink-muted); border-style: dashed; }
.card-foot { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding-top: 12px; border-top: 1px solid var(--line-soft); }
.card-foot small { color: var(--ink-muted); font-size: 10px; }
.card-foot .history { min-height: 0; padding: 0; border: 0; background: none; color: var(--ink-soft); font-size: 10px; letter-spacing: 0.5px; }
.card-foot .history:hover:not(:disabled) { border: 0; background: none; color: var(--accent); }
.catalog { margin-top: 28px; }
.catalog .list { margin-top: 18px; }
@media (max-width: 900px) {
  .pair { grid-template-columns: 1fr; }
  .section-row { grid-template-columns: 1fr; }
  .section-row small { grid-column: 1; }
  .override-row { flex-direction: column; align-items: flex-start; }
}
</style>