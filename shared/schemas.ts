import { z } from "zod";

// 贡献者：威廉（课表上传 timetableDigest/timetable 字段）

export const initializeSchema = z.object({
  schoolName: z.string().trim().min(2).max(80),
  username: z.string().trim().min(3).max(32).regex(/^[A-Za-z0-9_.-]+$/),
  password: z.string().min(12).max(128),
});

export const enrollmentTokenSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("code"),
    ttlMinutes: z.number().int().min(5).max(1440),
    orgNodeId: z.string().uuid().nullable().optional(),
    tagIds: z.array(z.string().uuid()).max(32).default([]),
    maxUses: z.literal(1).default(1),
  }),
  z.object({
    kind: z.literal("bundle"),
    ttlMinutes: z.number().int().min(5).max(1440),
    orgNodeId: z.string().uuid().nullable().optional(),
    tagIds: z.array(z.string().uuid()).max(32).default([]),
    maxUses: z.number().int().min(2).max(1000),
  }),
]);

export const enrollSchema = z.object({
  token: z.string().min(20).max(512),
  name: z.string().trim().min(1).max(100),
  publicKeyJwk: z.object({
    kty: z.literal("EC"),
    crv: z.literal("P-256"),
    x: z.string().min(42).max(44),
    y: z.string().min(42).max(44),
  }).strict(),
  keyThumbprint: z.string().min(32).max(256).optional(),
  pluginVersion: z.string().max(32),
  appVersion: z.string().max(32),
  platform: z.string().max(80),
});

/**
 * 设备端可被集控锁定的设置项。key 与设备端 SettingsPolicyService.SettableLocks 一一对应，
 * 由 tests/settings-lock-parity.test.ts 保证两侧不会漂移。
 * 语义：disable* 为 true 表示禁止本机修改；allowExitManagement 为 false 表示禁止本机退出集控。
 */
export const settingsLockFields = [
  { key: "disableProfileEditing", label: "档案编辑", hint: "课表、时间表、科目等档案整体只读", invert: false },
  { key: "disableProfileClassPlanEditing", label: "课表编辑", hint: "禁止修改课表", invert: false },
  { key: "disableProfileTimeLayoutEditing", label: "时间表编辑", hint: "禁止修改时间表", invert: false },
  { key: "disableProfileSubjectsEditing", label: "科目编辑", hint: "禁止修改科目", invert: false },
  { key: "disableSettingsEditing", label: "应用设置", hint: "禁止进入应用设置页（集控页保持可达）", invert: false },
  { key: "disableSplashCustomize", label: "启动画面自定义", hint: "禁止自定义启动画面", invert: false },
  { key: "disableDebugMenu", label: "调试菜单", hint: "隐藏调试设置页", invert: false },
  { key: "disableEasterEggs", label: "隐藏彩蛋", hint: "关闭彩蛋入口", invert: false },
  // invert：开关表示“锁定”，写入时取反（allowExitManagement=false 才是锁死）。
  { key: "allowExitManagement", label: "禁止本机退出集控", hint: "开启后本机无法自行退出，仅集控端可解除", invert: true },
] as const;

export const settingsLockKeys = settingsLockFields.map((field) => field.key) as string[];

/** 设置页管控的顶层键前缀：`page.<宿主页面 Id>` 与布尔锁键共用 settings 节，靠前缀区分。 */
export const settingsPagePrefix = "page.";

/**
 * 可逐页管控的大设置项（宿主设置页导航里的一项）。key 是宿主 SettingsPageInfo.Id，
 * 与设备端 SettingsPolicyService.ManagedPages 一一对应，由 parity 测试守住。
 * management 系列页面不在列：锁掉集控页会把设备自己锁死。
 */
export const settingsPageFields = [
  { key: "general", label: "基本" },
  { key: "clock", label: "时钟" },
  { key: "storage", label: "存储" },
  { key: "privacy", label: "隐私" },
  { key: "refreshing", label: "翻新与迎新" },
  { key: "advanced", label: "高级" },
  { key: "components", label: "组件" },
  { key: "appearance", label: "外观" },
  { key: "notification", label: "提醒" },
  { key: "window", label: "窗口" },
  { key: "weather", label: "天气" },
  { key: "automation", label: "自动化" },
  { key: "update", label: "更新" },
  { key: "classisland.plugins", label: "插件" },
  { key: "classisland.themes", label: "主题" },
] as const;

export const settingsPageKeys = settingsPageFields.map((field) => field.key) as string[];

/** 逐页管控强度：none 不限制、readonly 可见不可改、hidden 从导航与深链中隐藏。 */
export const settingsPageControls = ["none", "readonly", "hidden"] as const;
export type SettingsPageControl = (typeof settingsPageControls)[number];

/** 从 settings 节原始对象解析出「页面 Id → 管控强度」（none 视为未管控，不出现在结果里）。 */
export function resolveSettingsPageControls(settings: Record<string, unknown>): Record<string, SettingsPageControl> {
  const result: Record<string, SettingsPageControl> = {};
  for (const [key, value] of Object.entries(settings)) {
    if (!key.startsWith(settingsPagePrefix) || typeof value !== "string" || value === "none") continue;
    if ((settingsPageControls as readonly string[]).includes(value))
      result[key.slice(settingsPagePrefix.length)] = value as SettingsPageControl;
  }
  return result;
}

/**
 * settings 节取值校验：
 * - `page.*` 键必须是已知页面 Id，取值三态字符串；
 * - 其余键必须是非 page.* 的已知布尔锁键，取值布尔。
 */
export function validateSettingsSection(settings: Record<string, unknown>): string | null {
  for (const [key, value] of Object.entries(settings)) {
    if (key === "$config") continue;
    if (key.startsWith(settingsPagePrefix)) {
      const pageKey = key.slice(settingsPagePrefix.length);
      if (!settingsPageKeys.includes(pageKey)) return `未知的设置页管控键 ${key}。`;
      if (!(settingsPageControls as readonly string[]).includes(value as string))
        return `${key} 的取值必须是 ${settingsPageControls.join(" / ")}。`;
      continue;
    }
    if (!settingsLockKeys.includes(key)) return `未知的设置锁定键 ${key}。`;
    if (typeof value !== "boolean") return `${key} 的取值必须是布尔开关。`;
  }
  return null;
}

/** settings 节：布尔锁 + `page.*` 三态管控；未给出的项回落到不锁定。 */
export const settingsLockSchema = z.record(z.string().min(1).max(60), z.unknown()).superRefine((settings, ctx) => {
  const error = validateSettingsSection(settings);
  if (error) ctx.addIssue({ code: z.ZodIssueCode.custom, message: error });
});

/** settings 节允许写作配置库引用 `{ "$config": id }`，两种形态之外一律拒绝。 */
export function isSettingsReference(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && typeof (value as Record<string, unknown>).$config === "string";
}

function refineSettingsSection(document: unknown, ctx: z.RefinementCtx) {
  if (typeof document !== "object" || document === null || Array.isArray(document)) return;
  const settings = (document as Record<string, unknown>).settings;
  if (settings === undefined) return;
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["document", "settings"], message: "settings 节必须是对象。" });
    return;
  }
  if (isSettingsReference(settings)) return;
  const error = validateSettingsSection(settings as Record<string, unknown>);
  if (error)
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["document", "settings"], message: error });
}

/**
 * time 节：云端按作用域（分组）调控的自动时间偏移。
 * - offsetSeconds：固定偏移秒数（正数把本机时间提前、负数延后）；
 * - auto：设备以集控端时钟为准持续自动校准偏移，优先于 offsetSeconds；
 * - daily：每日自动偏移（对齐宿主「自动时间偏移」语义）——设备生效偏移为
 *   offsetSeconds（缺省取接管前本机值）+ secondsPerDay ×（今天 − anchorDate 的整天数），
 *   每天零点自动跨档；与 auto 互斥。
 * 本节被撤下时，设备恢复本机原有偏移。
 */
export const timeDailyAdjustSchema = z.object({
  enabled: z.boolean(),
  secondsPerDay: z.number().min(-86400).max(86400),
  anchorDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
}).strict();

export const timeSectionSchema = z.object({
  offsetSeconds: z.number().min(-86400).max(86400).optional(),
  auto: z.boolean().optional(),
  daily: timeDailyAdjustSchema.optional(),
}).strict().refine(
  (section) => !(section.auto === true && section.daily?.enabled === true),
  { message: "auto（随集控校准）与 daily.enabled（每日自动偏移）互斥。" },
);

function refineTimeSection(document: unknown, ctx: z.RefinementCtx) {
  if (typeof document !== "object" || document === null || Array.isArray(document)) return;
  const section = (document as Record<string, unknown>).time;
  if (section === undefined) return;
  if (typeof section !== "object" || section === null || Array.isArray(section)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["document", "time"], message: "time 节必须是对象。" });
    return;
  }
  if (!timeSectionSchema.safeParse(section).success)
    ctx.addIssue({
      code: z.ZodIssueCode.custom, path: ["document", "time"],
      message: "time 节只接受 offsetSeconds（-86400..86400 秒）、auto（布尔）与 daily（enabled/secondsPerDay/anchorDate）。",
    });
}

const policyFields = {
  name: z.string().trim().min(1).max(100),
  document: z.record(z.string(), z.unknown()),
  priority: z.number().int().min(-1000).max(1000).default(0),
  locks: z.array(z.string().startsWith("/")).max(256).default([]),
  // 追加覆盖：append 表示在该目标当前策略之上只应用本次给出的项，不整份替换。
  mode: z.enum(["replace", "append"]).default("replace"),
  // 乐观并发：发布者声明其所基于的当前有效修订号（0 表示“该作用域尚无策略”）。
  baseRevision: z.number().int().nonnegative().nullable().optional(),
};

/**
 * 策略发布作用域采用 discriminated union：
 * school 强制无目标（scopeId 只能是 null/缺省），其余作用域强制携带 UUID 目标。
 * 这样“非学校作用域但缺 scopeId”在入口即被拒绝，不会发布成永不生效的孤儿策略。
 */
export const policyPublishSchema = z.discriminatedUnion("scopeType", [
  z.object({ ...policyFields, scopeType: z.literal("school"), scopeId: z.null().optional() }),
  z.object({ ...policyFields, scopeType: z.literal("organization"), scopeId: z.string().uuid() }),
  z.object({ ...policyFields, scopeType: z.literal("tag"), scopeId: z.string().uuid() }),
  z.object({ ...policyFields, scopeType: z.literal("device"), scopeId: z.string().uuid() }),
]).superRefine((value, ctx) => {
  refineSettingsSection(value.document, ctx);
  refineTimeSection(value.document, ctx);
});

/**
 * 设备端崩溃上报：插件捕获未处理异常后随轮询上报，服务端按指纹归组统计。
 * 指纹由服务端统一计算（异常类型 + 规范化栈帧），保证跨插件版本的归组一致。
 */
export const crashKinds = ["unhandled-exception", "unobserved-task", "ui-thread", "host-exit"] as const;
export type CrashKind = (typeof crashKinds)[number];

export const crashReportSchema = z.object({
  /** 客户端生成的一次性 ID：同一份报告重传时按主键去重。 */
  id: z.string().trim().min(8).max(64),
  occurredAtUtc: z.string().trim().min(8).max(40),
  // 崩溃数据一律“降级容忍”：字段异常时取兜底值，绝不让整轮轮询因上报而失败，
  // 否则一台设备会因为一条坏报告永久卡在 400 上。
  kind: z.enum(crashKinds).catch("unhandled-exception"),
  exceptionType: z.string().trim().min(1).max(200).catch("UnknownException"),
  message: z.string().max(1000).default(""),
  stackTrace: z.string().max(8000).default(""),
  threadName: z.string().max(60).default(""),
  appVersion: z.string().max(32).default(""),
  pluginVersion: z.string().max(32).default(""),
  platform: z.string().max(80).default(""),
});
const sectionStateSchema = z.record(z.string(), z.enum(["applied", "skipped", "failed"]));

/**
 * 设备上报的课表档案快照（与 ClassIsland Profile 同构，camelCase）：
 * 根对象 + 四个字典（键为 guid）+ 当前选中课表群。深层内容不做强校验，
 * 由服务端 digest（JCS + SHA-256）保证完整性，形状仅做入口把关。
 */
export const ciTimetableSchema = z.object({
  name: z.string().max(200).optional(),
  timeLayouts: z.record(z.string().uuid(), z.unknown()).optional(),
  classPlans: z.record(z.string().uuid(), z.unknown()).optional(),
  subjects: z.record(z.string().uuid(), z.unknown()).optional(),
  classPlanGroups: z.record(z.string().uuid(), z.unknown()).optional(),
  selectedClassPlanGroupId: z.string().max(64).optional(),
}).passthrough();

export const pollSchema = z.object({
  deviceId: z.string().uuid(),
  sequence: z.number().int().nonnegative(),
  timestampUtc: z.string().datetime(),
  pluginVersion: z.string().max(32),
  appVersion: z.string().max(32),
  platform: z.string().max(80),
  capabilityDigest: z.string().max(128),
  capabilities: z.array(z.object({
    id: z.string().min(3).max(100),
    mode: z.enum(["read", "apply", "persist", "volatile", "reconcile-lock"]),
    schemaVersion: z.number().int().positive(),
  })).max(256).optional(),
  policyRevision: z.number().int().nonnegative(),
  // 客户端实际应用过的期望状态 epoch；与 policyHash 一起构成 applied 状态回执。
  policyEpoch: z.number().int().nonnegative().default(0),
  policyHash: z.string().max(128).default(""),
  // 逐节应用结果，用于区分“收到/尝试/真正生效”。
  appliedSections: sectionStateSchema.optional(),
  driftCount: z.number().int().nonnegative(),
  // 设备已应用的点名名单修订；与集控端当前名单一致时响应里不再回带名单本体。
  rollCallRevision: z.number().int().nonnegative().default(0),
  // 崩溃上报：设备端未送达的报告会一直留在本地 outbox，直到某次轮询被服务端接收。
  crashes: z.array(crashReportSchema).max(20).default([]),
  acknowledgements: z.array(z.object({
    commandId: z.string().uuid(),
    state: z.enum(["received", "running", "succeeded", "failed", "conflict", "unsupported", "expired", "cancelled"]),
    result: z.record(z.string(), z.unknown()).nullable().optional(),
    policyEpoch: z.number().int().nonnegative().optional(),
    appliedSections: sectionStateSchema.optional(),
  })).max(100).default([]),
  // 课表上传：每轮必报摘要（可选），内容变化时携带全量快照。
  timetableDigest: z.string().max(128).optional(),
  timetable: ciTimetableSchema.optional(),
  // 索取一次性教师绑定码：设备准备在屏上出示时才申请，服务端只存哈希、明文随签名响应回本机。
  bindingCodeRequested: z.boolean().default(false),
});
export const configurationKinds = ["profile", "components", "automation", "plugin", "settings"] as const;
export type ConfigurationKind = (typeof configurationKinds)[number];

/** 每种配置类型对应的 ClassIsland 顶层节名；用于校验该节必须是对象。 */
const configurationSections: Record<ConfigurationKind, string> = {
  profile: "profile",
  components: "components",
  automation: "automation",
  plugin: "plugin",
  settings: "settings",
};

/**
 * 配置类型 → 策略文档顶层节名。下发配置时以该节作为挂载点写入 { "$config": id }，
 * 由 materializeConfigReferences 在轮询时替换为配置文档本体。
 */
export function configurationSection(kind: string): string | null {
  return (configurationSections as Record<string, string>)[kind] ?? null;
}

/**
 * 配置文档的版本化结构校验：
 * - 根必须是 JSON 对象（拒绝数组/标量）；
 * - 可选的 `schemaVersion` 必须是 1..1000 的正整数（缺省视为 1，写入时补全）；
 * - 该类型对应的顶层节若存在，必须是对象；
 * - automation 的载体是 `workflows` 数组（宿主文件是裸数组，入库统一包成 { workflows: [...] }）。
 * 更深的宿主内部结构无法在服务端可靠建模，故此处只做版本与形状层面的强校验。
 */
export function configurationDocumentSchema(kind: ConfigurationKind) {
  const section = configurationSections[kind];
  return z.record(z.string(), z.unknown()).superRefine((document, ctx) => {
    const version = document.schemaVersion;
    if (version !== undefined && (typeof version !== "number" || !Number.isInteger(version) || version < 1 || version > 1000))
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["schemaVersion"], message: "配置文档的 schemaVersion 必须是不大于 1000 的正整数。" });
    const value = document[section];
    if (value !== undefined && (typeof value !== "object" || value === null || Array.isArray(value)))
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [section], message: `配置文档的 ${section} 节必须是对象。` });
    if (kind === "automation") {
      const list = document.workflows;
      if (list !== undefined && (!Array.isArray(list) || list.some((entry) => typeof entry !== "object" || entry === null || Array.isArray(entry))))
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["workflows"], message: "自动化配置的 workflows 必须是工作流对象组成的数组。" });
    }
    if (kind === "settings" && value !== undefined && !isSettingsReference(value) && !settingsLockSchema.safeParse(value).success)
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [section], message: "设置锁定配置的取值必须是布尔开关或 page.* 三态管控。" });
  });
}

/** 写入前补全 schemaVersion，保证每条修订都携带可追溯的版本号。 */
export function normalizeConfigurationDocument(kind: ConfigurationKind, document: Record<string, unknown>) {
  return { ...document, schemaVersion: (document.schemaVersion as number | undefined) ?? 1 };
}

/** 楼栋部署：楼栋 → 楼层 → 教室的层级，设备经 room_devices 绑定到唯一教室。 */
export const layoutNameSchema = z.string().trim().min(1).max(60);

export const buildingCreateSchema = z.object({
  name: layoutNameSchema,
  sortOrder: z.number().int().min(-1000).max(1000).default(0),
});

export const floorCreateSchema = z.object({
  buildingId: z.string().uuid(),
  name: layoutNameSchema,
  level: z.number().int().min(-10).max(200).default(0),
});

export const roomCreateSchema = z.object({
  floorId: z.string().uuid(),
  name: layoutNameSchema,
});

export const buildingPatchSchema = z.object({
  name: layoutNameSchema.optional(),
  sortOrder: z.number().int().min(-1000).max(1000).optional(),
}).refine((value) => Object.keys(value).length > 0, { message: "至少提供一个更新字段。" });

export const floorPatchSchema = z.object({
  name: layoutNameSchema.optional(),
  level: z.number().int().min(-10).max(200).optional(),
  sortOrder: z.number().int().min(-1000).max(1000).optional(),
}).refine((value) => Object.keys(value).length > 0, { message: "至少提供一个更新字段。" });

export const roomPatchSchema = z.object({
  name: layoutNameSchema.optional(),
  sortOrder: z.number().int().min(-1000).max(1000).optional(),
}).refine((value) => Object.keys(value).length > 0, { message: "至少提供一个更新字段。" });

/**
 * 设备与集控端的连接模式：http 为短轮询（默认，兼容一切反向代理与只读网络），
 * websocket 为常驻长连接（由 POST /api/v1/agent/ws 升级，协议与轮询同源同签名）。
 */
export const deviceTransports = ["http", "websocket"] as const;
export type DeviceTransport = (typeof deviceTransports)[number];
export const deviceTransportSchema = z.enum(deviceTransports);

/** 教室设备分配：add 为覆盖式写入（设备会从原教室移出），remove 从本教室移出。 */
/** 点名名单：云端维护的姓名列表，按作用域下发到设备端悬浮窗。 */
export const rollCallNamesSchema = z.array(z.string().trim().min(1).max(40)).max(500);

export const rollCallRosterSchema = z.object({
  name: z.string().trim().min(1).max(60),
  scopeType: z.enum(["school", "organization", "device"]),
  scopeId: z.string().uuid().nullable().optional(),
  names: rollCallNamesSchema,
}).superRefine((value, ctx) => {
  // 全校名单不接受目标；其余作用域必须给出目标，避免存成永不生效的孤儿名单。
  if (value.scopeType === "school") {
    if (value.scopeId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["scopeId"], message: "全校名单不能指定目标。" });
    return;
  }
  if (!value.scopeId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["scopeId"], message: "该作用域必须指定目标。" });
});

/**
 * 点名设置：与名单共用一套作用域，整行覆盖式写入。
 * 每个字段留空（null/缺省）都表示“这一项不表态”，继续向上级作用域继承，
 * 最终由设备本机的设置兜底；因此关掉全校抽人不必逐台设备写一遍。
 */
export const rollCallSettingsSchema = z.object({
  scopeType: z.enum(["school", "organization", "device"]),
  scopeId: z.string().uuid().nullable().optional(),
  enabled: z.boolean().nullish(),
  notify: z.boolean().nullish(),
  singleSeconds: z.number().int().min(1).max(120).nullish(),
  multiSeconds: z.number().int().min(2).max(300).nullish(),
}).superRefine((value, ctx) => {
  if (value.scopeType === "school") {
    if (value.scopeId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["scopeId"], message: "全校设置不能指定目标。" });
  } else if (!value.scopeId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["scopeId"], message: "该作用域必须指定目标。" });
  }
  // 一项都不表态等于把这行的内容清空，应落到删除该行，而不是留下一条永不生效的记录。
  if (value.enabled === undefined && value.notify === undefined && value.singleSeconds === undefined && value.multiSeconds === undefined)
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "至少要表态一项点名设置。" });
});

/**
 * 点名设置的逐字段界面表：界面只按这张表渲染，
 * 因此字段名与 rollCallSettingsSchema、插件端 RemoteRollCallSettings 必须由同一条 parity 测试守住。
 */
export const rollCallSettingFields = [
  { key: "enabled", kind: "switch", label: "点名悬浮窗", hint: "关掉后设备上的点名窗直接不见。", on: "显示", off: "隐藏" },
  { key: "notify", kind: "switch", label: "抽中时提醒", hint: "抽到人后同时拉起一条提醒。", on: "提醒", off: "不提醒" },
  { key: "singleSeconds", kind: "number", label: "单人停留秒数", hint: "“抽人”结果停留的时间。", min: 1, max: 120 },
  { key: "multiSeconds", kind: "number", label: "多人停留秒数", hint: "“多人”抽 2 人停留的时间，每多一人再加 1 秒。", min: 2, max: 300 },
] as const;

export type RollCallSettingKey = (typeof rollCallSettingFields)[number]["key"];
/** 一项设置的三态取值：null 表示这一层不表态，交给上级作用域，最终由设备本机兜底。 */
export type RollCallSettingsDraft = Record<RollCallSettingKey, boolean | number | null>;

export const roomDevicesSchema = z.object({
  add: z.array(z.string().uuid()).max(500).default([]),
  remove: z.array(z.string().uuid()).max(500).default([]),
}).refine((value) => !value.add.some((id) => value.remove.includes(id)), {
  message: "同一设备不能同时加入和移出。",
});