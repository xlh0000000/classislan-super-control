import { z } from "zod";

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

/** settings 节：全部为布尔开关，未给出的项回落到不锁定。 */
export const settingsLockSchema = z.record(
  z.string().min(1).max(60),
  z.boolean(),
);

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
  if (!settingsLockSchema.safeParse(settings).success)
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["document", "settings"], message: "settings 节的取值必须是布尔开关。" });
}

/**
 * time 节：云端按作用域（分组）调控的自动时间偏移。
 * - offsetSeconds：固定偏移秒数（正数把本机时间提前、负数延后）；
 * - auto：设备以集控端时钟为准持续自动校准偏移，优先于 offsetSeconds。
 * 两项都缺省或整个节被撤下时，设备恢复本机原有偏移。
 */
export const timeSectionSchema = z.object({
  offsetSeconds: z.number().min(-86400).max(86400).optional(),
  auto: z.boolean().optional(),
}).strict();

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
      message: "time 节只接受 offsetSeconds（-86400..86400 的秒数）与 auto（布尔开关）。",
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

const sectionStateSchema = z.record(z.string(), z.enum(["applied", "skipped", "failed"]));

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
  acknowledgements: z.array(z.object({
    commandId: z.string().uuid(),
    state: z.enum(["received", "running", "succeeded", "failed", "conflict", "unsupported", "expired", "cancelled"]),
    result: z.record(z.string(), z.unknown()).nullable().optional(),
    policyEpoch: z.number().int().nonnegative().optional(),
    appliedSections: sectionStateSchema.optional(),
  })).max(100).default([]),
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
 * - 该类型对应的顶层节若存在，必须是对象。
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
    if (kind === "settings" && value !== undefined && !isSettingsReference(value) && !settingsLockSchema.safeParse(value).success)
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [section], message: "设置锁定配置的取值必须是布尔开关。" });
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

export const roomDevicesSchema = z.object({
  add: z.array(z.string().uuid()).max(500).default([]),
  remove: z.array(z.string().uuid()).max(500).default([]),
}).refine((value) => !value.add.some((id) => value.remove.includes(id)), {
  message: "同一设备不能同时加入和移出。",
});