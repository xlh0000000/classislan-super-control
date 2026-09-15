/**
 * ClassIsland 配置文档的可视化编辑模型。
 *
 * 宿主自身用 PascalCase 写配置，插件用 JsonSerializerDefaults.Web（camelCase、不区分大小写）
 * 读取，同一份文档里两种键名都可能出现。这里统一用大小写不敏感的方式读写，并在写回时
 * 复用文档中已有的键名，避免同一字段产生两个大小写不同的副本。
 * 未建模的字段一律原样保留，保证往返不丢数据。
 */

export type JsonObject = Record<string, unknown>;

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findKey(record: JsonObject, name: string): string | null {
  const lowered = name.toLowerCase();
  for (const key of Object.keys(record)) if (key.toLowerCase() === lowered) return key;
  return null;
}

export function jsonGet(record: JsonObject | null | undefined, name: string): unknown {
  if (!record) return undefined;
  const key = findKey(record, name);
  return key === null ? undefined : record[key];
}

/** 写入字段：已有同名（忽略大小写）键时改原键，否则新建。 */
export function jsonSet(record: JsonObject, name: string, value: unknown): void {
  const key = findKey(record, name);
  record[key ?? name] = value;
}

export function jsonString(record: JsonObject | null | undefined, name: string, fallback = ""): string {
  const value = jsonGet(record, name);
  return typeof value === "string" ? value : fallback;
}

export function jsonBool(record: JsonObject | null | undefined, name: string, fallback = false): boolean {
  const value = jsonGet(record, name);
  return typeof value === "boolean" ? value : fallback;
}

export function jsonNumber(record: JsonObject | null | undefined, name: string, fallback = 0): number {
  const value = jsonGet(record, name);
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function jsonObject(record: JsonObject | null | undefined, name: string): JsonObject | null {
  const value = jsonGet(record, name);
  return isJsonObject(value) ? value : null;
}

/** 取出未建模字段（保留原始键名）。 */
function extrasOf(record: JsonObject, managed: string[]): JsonObject {
  const lowered = new Set(managed.map((key) => key.toLowerCase()));
  const extras: JsonObject = {};
  for (const [key, value] of Object.entries(record)) if (!lowered.has(key.toLowerCase())) extras[key] = value;
  return extras;
}

/** ClassIsland 的颜色是 #RRGGBBAA，input[type=color] 只认 #RRGGBB。 */
export function toColorInput(value: string, fallback = "#000000"): string {
  const match = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(value.trim());
  return match ? `#${match[1]}` : fallback;
}

export function fromColorInput(value: string, previous = ""): string {
  const alpha = /^#[0-9a-f]{6}([0-9a-f]{2})$/i.exec(previous.trim())?.[1] ?? "FF";
  return `${toColorInput(value)}${alpha}`.toUpperCase();
}

/* ------------------------------------------------------------------ 档案（profile） */

const PROFILE_MANAGED = [
  "name",
  "isoverlayclassplanenabled",
  "overlayclassplanid",
  "istempclassplaingroupenabled",
  "tempclassplaingrouptype",
  "selectedclassplaingroupid",
];

export type NamedEntry = { id: string; name: string };

export type ProfileSettingsModel = {
  name: string;
  overlayEnabled: boolean;
  overlayClassPlanId: string;
  tempGroupEnabled: boolean;
  tempGroupType: number;
  selectedClassPlanGroupId: string;
  classPlans: NamedEntry[];
  groups: NamedEntry[];
  extra: JsonObject;
};

function namedEntries(source: JsonObject | null, fallback: string): NamedEntry[] {
  if (!source) return [];
  return Object.entries(source).map(([id, value]) => ({
    id,
    name: jsonString(isJsonObject(value) ? value : null, "name", fallback),
  }));
}

export function readProfileSettings(document: JsonObject): ProfileSettingsModel {
  return {
    name: jsonString(document, "name", "档案"),
    overlayEnabled: jsonBool(document, "isOverlayClassPlanEnabled"),
    overlayClassPlanId: jsonString(document, "overlayClassPlanId"),
    tempGroupEnabled: jsonBool(document, "isTempClassPlanGroupEnabled"),
    tempGroupType: jsonNumber(document, "tempClassPlanGroupType", 1),
    selectedClassPlanGroupId: jsonString(document, "selectedClassPlanGroupId"),
    classPlans: namedEntries(jsonObject(document, "classPlans"), "未命名课表"),
    groups: namedEntries(jsonObject(document, "classPlanGroups"), "未命名课表群"),
    extra: extrasOf(document, PROFILE_MANAGED),
  };
}

export function writeProfileSettings(model: ProfileSettingsModel): JsonObject {
  const document: JsonObject = { ...model.extra };
  // 新建键统一用宿主自己的 PascalCase 写法；文档里已存在同名键（含 camelCase）时沿用原键名。
  jsonSet(document, "Name", model.name);
  jsonSet(document, "IsOverlayClassPlanEnabled", model.overlayEnabled);
  jsonSet(document, "OverlayClassPlanId", model.overlayClassPlanId || null);
  jsonSet(document, "IsTempClassPlanGroupEnabled", model.tempGroupEnabled);
  jsonSet(document, "TempClassPlanGroupType", model.tempGroupType);
  jsonSet(document, "SelectedClassPlanGroupId", model.selectedClassPlanGroupId);
  return document;
}

/* --------------------------------------------------------------- 组件布局（components） */

const NODE_MANAGED = [
  "id",
  "namecache",
  "hideonrule",
  "mainwindowbodyfontsize",
  "opacity",
  "iscustombackgroundcolorenabled",
  "backgroundcolor",
  "backgroundopacity",
  "isfixedwidthenabled",
  "fixedwidth",
];

const LINE_MANAGED = [
  "children",
  "ismainline",
  "isnotificationenabled",
  "isvisible",
  "hideonrule",
  "islandseparationmode",
];

/** 可表单化的标量值。 */
export type ScalarValue = boolean | number | string;

export type SettingField = { key: string; kind: "bool" | "number" | "text" | "color" };

export type ComponentNodeModel = {
  id: string;
  name: string;
  hideOnRule: boolean;
  fontSize: number;
  opacity: number;
  customBackground: boolean;
  backgroundColor: string;
  backgroundOpacity: number;
  fixedWidthEnabled: boolean;
  fixedWidth: number;
  /** 组件自身的设置（只保留可表单化的标量字段）。 */
  settings: Record<string, ScalarValue>;
  /** 组件设置里的非标量字段，原样保留。 */
  settingsExtra: JsonObject;
  hasSettings: boolean;
  extra: JsonObject;
};

const COLOR_PATTERN = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i;

export function isColorValue(value: ScalarValue): boolean {
  return typeof value === "string" && COLOR_PATTERN.test(value.trim());
}

/** 把一个组件的 Settings 拆成可表单化的标量与需要原样保留的复杂值。 */
function readSettings(raw: unknown) {
  const record = isJsonObject(raw) ? raw : null;
  const scalars: Record<string, ScalarValue> = {};
  const extras: JsonObject = {};
  for (const [key, value] of Object.entries(record ?? {})) {
    if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") scalars[key] = value;
    else extras[key] = value;
  }
  return { scalars, extras, present: record !== null };
}

/** 组件设置里可渲染成控件的字段（按原键名顺序）。 */
export function settingFields(node: ComponentNodeModel): SettingField[] {
  return Object.entries(node.settings).map(([key, value]) => ({
    key,
    kind: typeof value === "boolean" ? "bool" : typeof value === "number" ? "number" : isColorValue(value) ? "color" : "text",
  }));
}

export function boolSetting(node: ComponentNodeModel, key: string): boolean {
  return node.settings[key] === true;
}

export function numberSetting(node: ComponentNodeModel, key: string): number {
  const value = node.settings[key];
  return typeof value === "number" ? value : 0;
}

export function textSetting(node: ComponentNodeModel, key: string): string {
  const value = node.settings[key];
  return typeof value === "string" ? value : "";
}

export type ComponentLineModel = {
  isMainLine: boolean;
  isNotificationEnabled: boolean;
  isVisible: boolean;
  hideOnRule: boolean;
  islandSeparationMode: number;
  children: ComponentNodeModel[];
  extra: JsonObject;
};

export function readComponentNode(raw: unknown): ComponentNodeModel {
  const record = isJsonObject(raw) ? raw : {};
  const settings = readSettings(jsonGet(record, "settings"));
  return {
    id: jsonString(record, "id"),
    name: jsonString(record, "nameCache"),
    hideOnRule: jsonBool(record, "hideOnRule"),
    fontSize: jsonNumber(record, "mainWindowBodyFontSize", 16),
    opacity: jsonNumber(record, "opacity", 1),
    customBackground: jsonBool(record, "isCustomBackgroundColorEnabled"),
    backgroundColor: jsonString(record, "backgroundColor", "#000000FF"),
    backgroundOpacity: jsonNumber(record, "backgroundOpacity", 0.5),
    fixedWidthEnabled: jsonBool(record, "isFixedWidthEnabled"),
    fixedWidth: jsonNumber(record, "fixedWidth", 200),
    settings: settings.scalars,
    settingsExtra: settings.extras,
    hasSettings: settings.present,
    extra: extrasOf(record, NODE_MANAGED),
  };
}

export function writeComponentNode(model: ComponentNodeModel): JsonObject {
  const record: JsonObject = { ...model.extra };
  jsonSet(record, "Id", model.id.trim().toLowerCase());
  jsonSet(record, "NameCache", model.name);
  jsonSet(record, "HideOnRule", model.hideOnRule);
  jsonSet(record, "MainWindowBodyFontSize", model.fontSize);
  jsonSet(record, "Opacity", model.opacity);
  jsonSet(record, "IsCustomBackgroundColorEnabled", model.customBackground);
  jsonSet(record, "BackgroundColor", model.backgroundColor);
  jsonSet(record, "BackgroundOpacity", model.backgroundOpacity);
  jsonSet(record, "IsFixedWidthEnabled", model.fixedWidthEnabled);
  jsonSet(record, "FixedWidth", model.fixedWidth);
  if (model.hasSettings) jsonSet(record, "Settings", { ...model.settings, ...model.settingsExtra });
  return record;
}

export function readComponentLines(document: JsonObject): ComponentLineModel[] {
  const lines = jsonGet(document, "lines");
  if (!Array.isArray(lines)) return [];
  return lines.map((raw) => {
    const record = isJsonObject(raw) ? raw : {};
    const children = jsonGet(record, "children");
    return {
      isMainLine: jsonBool(record, "isMainLine"),
      isNotificationEnabled: jsonBool(record, "isNotificationEnabled", true),
      isVisible: jsonBool(record, "isVisible", true),
      hideOnRule: jsonBool(record, "hideOnRule"),
      islandSeparationMode: jsonNumber(record, "islandSeparationMode"),
      children: Array.isArray(children) ? children.map(readComponentNode) : [],
      extra: extrasOf(record, LINE_MANAGED),
    };
  });
}

export function writeComponentLines(document: JsonObject, lines: ComponentLineModel[]): JsonObject {
  const result: JsonObject = { ...document };
  jsonSet(
    result,
    "Lines",
    lines.map((line) => {
      const record: JsonObject = { ...line.extra };
      jsonSet(record, "Children", line.children.map(writeComponentNode));
      jsonSet(record, "IsMainLine", line.isMainLine);
      jsonSet(record, "IsNotificationEnabled", line.isNotificationEnabled);
      jsonSet(record, "IsVisible", line.isVisible);
      jsonSet(record, "HideOnRule", line.hideOnRule);
      jsonSet(record, "IslandSeparationMode", line.islandSeparationMode);
      return record;
    }),
  );
  return result;
}

export function newComponentNode(id = ""): ComponentNodeModel {
  return {
    id,
    name: "",
    hideOnRule: false,
    fontSize: 16,
    opacity: 1,
    customBackground: false,
    backgroundColor: "#000000FF",
    backgroundOpacity: 0.5,
    fixedWidthEnabled: false,
    fixedWidth: 200,
    settings: {},
    settingsExtra: {},
    hasSettings: false,
    extra: {},
  };
}

export function newComponentLine(): ComponentLineModel {
  return {
    isMainLine: false,
    isNotificationEnabled: true,
    isVisible: true,
    hideOnRule: false,
    islandSeparationMode: 0,
    children: [newComponentNode()],
    extra: {},
  };
}

/* ------------------------------------------------------------------ 结构标签 */

export const TEMP_GROUP_TYPES: { value: number; label: string }[] = [
  { value: 1, label: "继承当前课表群" },
  { value: 0, label: "覆盖当前课表群" },
];

export const ISLAND_SEPARATION_MODES: { value: number; label: string }[] = [
  { value: 0, label: "默认" },
  { value: 1, label: "禁用" },
  { value: 2, label: "启用" },
];

/** 文档顶层可识别的节与说明，用于可视化编辑器显示当前编辑范围。 */
export const CONFIG_KIND_LABELS: Record<string, string> = {
  profile: "档案与课表",
  components: "组件布局",
  automation: "自动化工作流",
  plugin: "插件设置",
  settings: "设置锁定",
};