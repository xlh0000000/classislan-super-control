/**
 * ClassIsland 档案（Profile）模型：课表、时间表、科目与课表群。
 * 读写都做大小写不敏感的键匹配，因为宿主自身用 PascalCase 写 Profile.json，
 * 而插件用 JsonSerializerDefaults.Web（camelCase）读取；两端的键名都可能出现。
 * 编辑器只改动已知字段，其余字段原样保留在 `extra` 里，保证往返不丢数据。
 */

export const DEFAULT_CLASS_PLAN_GROUP_ID = "acaf4ef0-e261-4262-b941-34ea93cb4369";
export const GLOBAL_CLASS_PLAN_GROUP_ID = "00000000-0000-0000-0000-000000000000";

export const WEEKDAYS: { value: number; label: string }[] = [
  { value: 1, label: "周一" },
  { value: 2, label: "周二" },
  { value: 3, label: "周三" },
  { value: 4, label: "周四" },
  { value: 5, label: "周五" },
  { value: 6, label: "周六" },
  { value: 0, label: "周日" },
];

export const TIME_TYPES: { value: number; label: string }[] = [
  { value: 0, label: "上课" },
  { value: 1, label: "课间" },
  { value: 2, label: "分割线" },
  { value: 3, label: "行动" },
];

export type CiTimeLayoutItem = {
  startTime: string;
  endTime: string;
  timeType: number;
  breakName: string;
  isHideDefault: boolean;
  defaultClassId: string;
  extra: Record<string, unknown>;
};

export type CiTimeLayout = { id: string; name: string; layouts: CiTimeLayoutItem[]; extra: Record<string, unknown> };

export type CiClassInfo = { subjectId: string; isChangedClass: boolean; isEnabled: boolean; extra: Record<string, unknown> };

export type CiTimeRule = { weekDay: number; weekCountDiv: number; weekCountDivTotal: number };

export type CiClassPlan = {
  id: string;
  name: string;
  timeLayoutId: string;
  classes: CiClassInfo[];
  timeRule: CiTimeRule;
  associatedGroup: string;
  isEnabled: boolean;
  extra: Record<string, unknown>;
};

export type CiSubject = { id: string; name: string; initial: string; teacherName: string; isOutDoor: boolean; extra: Record<string, unknown> };

export type CiClassPlanGroup = { id: string; name: string; isGlobal: boolean; extra: Record<string, unknown> };

export type CiProfile = {
  name: string;
  timeLayouts: CiTimeLayout[];
  classPlans: CiClassPlan[];
  subjects: CiSubject[];
  classPlanGroups: CiClassPlanGroup[];
  selectedClassPlanGroupId: string;
  extra: Record<string, unknown>;
};

const MANAGED_ROOT_KEYS = ["name", "timelayouts", "classplans", "subjects", "classplaingroups", "selectedclassplaingroupid", "schemaversion"];
const MANAGED_LAYOUT_KEYS = ["name", "layouts"];
const MANAGED_LAYOUT_ITEM_KEYS = ["starttime", "endtime", "timetype", "breakname", "ishidedefault", "defaultclassid"];
const MANAGED_PLAN_KEYS = ["name", "timelayoutid", "classes", "timerule", "associatedgroup", "isenabled"];
const MANAGED_CLASS_KEYS = ["subjectid", "ischangedclass", "isenabled"];
const MANAGED_SUBJECT_KEYS = ["name", "initial", "teachername", "isoutdoor"];
const MANAGED_GROUP_KEYS = ["name", "isglobal"];

export function uuid(): string {
  const generator = globalThis.crypto?.randomUUID;
  if (typeof generator === "function") return generator.call(globalThis.crypto);
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const random = (Math.random() * 16) | 0;
    const value = char === "x" ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}
function asBool(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}
function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function findKey(object: Record<string, unknown>, name: string): string | undefined {
  if (name in object) return name;
  const lower = name.toLowerCase();
  return Object.keys(object).find((key) => key.toLowerCase() === lower);
}
function ciGet(object: Record<string, unknown> | undefined, name: string): unknown {
  if (!object) return undefined;
  const key = findKey(object, name);
  return key === undefined ? undefined : object[key];
}
function extraKeys(record: Record<string, unknown>, managed: string[]): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!managed.includes(key.toLowerCase())) kept[key] = value;
  }
  return kept;
}

/** "08:00:00" / "08:00:00.1234567" / "08:00" → "08:00"。 */
export function toClock(value: unknown): string {
  const match = /^(\d{1,2}):(\d{1,2})/.exec(asString(value).trim());
  return match ? `${match[1]!.padStart(2, "0")}:${match[2]!.padStart(2, "0")}` : "00:00";
}
/** "08:00" → "08:00:00"（.NET TimeSpan 的反序列化格式）。 */
export function toTimeSpan(clock: string): string {
  const match = /^(\d{1,2}):(\d{1,2})/.exec(clock.trim());
  return match ? `${match[1]!.padStart(2, "0")}:${match[2]!.padStart(2, "0")}:00` : "00:00:00";
}

function readLayoutItem(raw: unknown): CiTimeLayoutItem {
  const record = asRecord(raw) ?? {};
  return {
    startTime: toClock(ciGet(record, "startTime")),
    endTime: toClock(ciGet(record, "endTime")),
    timeType: asNumber(ciGet(record, "timeType"), 0),
    breakName: asString(ciGet(record, "breakName")),
    isHideDefault: asBool(ciGet(record, "isHideDefault")),
    defaultClassId: asString(ciGet(record, "defaultClassId")),
    extra: extraKeys(record, MANAGED_LAYOUT_ITEM_KEYS),
  };
}

function readTimeLayout(id: string, raw: unknown): CiTimeLayout {
  const record = asRecord(raw) ?? {};
  return {
    id,
    name: asString(ciGet(record, "name"), "时间表"),
    layouts: Array.isArray(ciGet(record, "layouts")) ? (ciGet(record, "layouts") as unknown[]).map(readLayoutItem) : [],
    extra: extraKeys(record, MANAGED_LAYOUT_KEYS),
  };
}

function readClassInfo(raw: unknown): CiClassInfo {
  const record = asRecord(raw) ?? {};
  return {
    subjectId: asString(ciGet(record, "subjectId")),
    isChangedClass: asBool(ciGet(record, "isChangedClass")),
    isEnabled: asBool(ciGet(record, "isEnabled"), true),
    extra: extraKeys(record, MANAGED_CLASS_KEYS),
  };
}

function readTimeRule(raw: unknown): CiTimeRule {
  const record = asRecord(raw) ?? {};
  return {
    weekDay: asNumber(ciGet(record, "weekDay"), 1),
    weekCountDiv: asNumber(ciGet(record, "weekCountDiv"), 0),
    weekCountDivTotal: asNumber(ciGet(record, "weekCountDivTotal"), 2),
  };
}

function readClassPlan(id: string, raw: unknown): CiClassPlan {
  const record = asRecord(raw) ?? {};
  const classesRaw = ciGet(record, "classes");
  return {
    id,
    name: asString(ciGet(record, "name"), "新课表"),
    timeLayoutId: asString(ciGet(record, "timeLayoutId")),
    classes: Array.isArray(classesRaw) ? (classesRaw as unknown[]).map(readClassInfo) : [],
    timeRule: readTimeRule(ciGet(record, "timeRule")),
    associatedGroup: asString(ciGet(record, "associatedGroup"), DEFAULT_CLASS_PLAN_GROUP_ID),
    isEnabled: asBool(ciGet(record, "isEnabled"), true),
    extra: extraKeys(record, MANAGED_PLAN_KEYS),
  };
}

function readSubject(id: string, raw: unknown): CiSubject {
  const record = asRecord(raw) ?? {};
  return {
    id,
    name: asString(ciGet(record, "name")),
    initial: asString(ciGet(record, "initial")),
    teacherName: asString(ciGet(record, "teacherName")),
    isOutDoor: asBool(ciGet(record, "isOutDoor")),
    extra: extraKeys(record, MANAGED_SUBJECT_KEYS),
  };
}

function readGroup(id: string, raw: unknown): CiClassPlanGroup {
  const record = asRecord(raw) ?? {};
  return { id, name: asString(ciGet(record, "name"), "课表群"), isGlobal: asBool(ciGet(record, "isGlobal")), extra: extraKeys(record, MANAGED_GROUP_KEYS) };
}

export function readProfile(raw: unknown): CiProfile {
  const root = asRecord(raw) ?? {};
  const layouts = asRecord(ciGet(root, "timeLayouts")) ?? {};
  const plans = asRecord(ciGet(root, "classPlans")) ?? {};
  const subjects = asRecord(ciGet(root, "subjects")) ?? {};
  const groups = asRecord(ciGet(root, "classPlanGroups")) ?? {};
  const profile: CiProfile = {
    name: asString(ciGet(root, "name"), "档案"),
    timeLayouts: Object.entries(layouts).map(([id, value]) => readTimeLayout(id, value)),
    classPlans: Object.entries(plans).map(([id, value]) => readClassPlan(id, value)),
    subjects: Object.entries(subjects).map(([id, value]) => readSubject(id, value)).sort((a, b) => a.name.localeCompare(b.name, "zh-CN")),
    classPlanGroups: Object.entries(groups).map(([id, value]) => readGroup(id, value)),
    selectedClassPlanGroupId: asString(ciGet(root, "selectedClassPlanGroupId"), DEFAULT_CLASS_PLAN_GROUP_ID),
    extra: extraKeys(root, MANAGED_ROOT_KEYS),
  };
  ensureDefaults(profile);
  return profile;
}

function ensureDefaults(profile: CiProfile) {
  if (!profile.timeLayouts.length) profile.timeLayouts.push(readTimeLayout(uuid(), { name: "默认时间表", layouts: standardLayoutItems() }));
  if (!profile.classPlanGroups.some((group) => group.id === DEFAULT_CLASS_PLAN_GROUP_ID))
    profile.classPlanGroups.push({ id: DEFAULT_CLASS_PLAN_GROUP_ID, name: "默认", isGlobal: false, extra: {} });
  if (!profile.classPlanGroups.some((group) => group.id === GLOBAL_CLASS_PLAN_GROUP_ID))
    profile.classPlanGroups.push({ id: GLOBAL_CLASS_PLAN_GROUP_ID, name: "全局课表群", isGlobal: true, extra: {} });
  if (!profile.classPlanGroups.some((group) => group.id === profile.selectedClassPlanGroupId))
    profile.selectedClassPlanGroupId = DEFAULT_CLASS_PLAN_GROUP_ID;
}

export function emptyProfile(name = "新档案"): CiProfile {
  const profile: CiProfile = {
    name,
    timeLayouts: [],
    classPlans: [],
    subjects: [],
    classPlanGroups: [],
    selectedClassPlanGroupId: DEFAULT_CLASS_PLAN_GROUP_ID,
    extra: {},
  };
  ensureDefaults(profile);
  return profile;
}

export function newLayoutItem(timeType = 0): CiTimeLayoutItem {
  return { startTime: "08:00", endTime: "08:45", timeType, breakName: "", isHideDefault: false, defaultClassId: "", extra: {} };
}

/** 标准作息：8 节 45 分钟课，节间 10 分钟课间，上午/下午之间 60 分钟。 */
export function standardLayoutItems(): CiTimeLayoutItem[] {
  const items: CiTimeLayoutItem[] = [];
  const add = (startMinutes: number, endMinutes: number, timeType: number) => {
    const clock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
    items.push({ startTime: clock(startMinutes), endTime: clock(endMinutes), timeType, breakName: "", isHideDefault: false, defaultClassId: "", extra: {} });
  };
  let cursor = 8 * 60;
  for (let period = 0; period < 8; period++) {
    add(cursor, cursor + 45, 0);
    cursor += 45;
    if (period === 3) {
      add(cursor, cursor + 60, 1);
      cursor += 60;
    } else if (period < 7) {
      add(cursor, cursor + 10, 1);
      cursor += 10;
    }
  }
  return items;
}

export function newSubject(name = "新科目"): CiSubject {
  return { id: uuid(), name, initial: name.slice(0, 1), teacherName: "", isOutDoor: false, extra: {} };
}

export function periodsOf(profile: CiProfile, timeLayoutId: string): { index: number; item: CiTimeLayoutItem }[] {
  const layout = profile.timeLayouts.find((candidate) => candidate.id === timeLayoutId) ?? profile.timeLayouts[0];
  if (!layout) return [];
  let index = 0;
  const result: { index: number; item: CiTimeLayoutItem }[] = [];
  for (const item of layout.layouts) if (item.timeType === 0) result.push({ index: index++, item });
  return result;
}

export function subjectsForGroup(profile: CiProfile, groupId: string): CiClassPlan[] {
  return profile.classPlans.filter((plan) => plan.associatedGroup === groupId || (groupId === DEFAULT_CLASS_PLAN_GROUP_ID && !plan.associatedGroup));
}

export function findClassPlan(profile: CiProfile, groupId: string, weekDay: number): CiClassPlan | undefined {
  return profile.classPlans.find((plan) => plan.associatedGroup === groupId && plan.timeRule.weekDay === weekDay && !plan.extra["isOverlay"]);
}

export function subjectName(profile: CiProfile, subjectId: string): string {
  return profile.subjects.find((subject) => subject.id === subjectId)?.name ?? "";
}
export function subjectInitial(profile: CiProfile, subjectId: string): string {
  const subject = profile.subjects.find((item) => item.id === subjectId);
  return subject ? subject.initial || subject.name.slice(0, 1) : "";
}

/** 确保某天存在课表，并把 classes 长度对齐到时间表里的上课节数。 */
export function ensureClassPlan(profile: CiProfile, groupId: string, weekDay: number, timeLayoutId: string, name: string): CiClassPlan {
  let plan = findClassPlan(profile, groupId, weekDay);
  if (!plan) {
    plan = {
      id: uuid(),
      name,
      timeLayoutId,
      classes: [],
      timeRule: { weekDay, weekCountDiv: 0, weekCountDivTotal: 2 },
      associatedGroup: groupId,
      isEnabled: true,
      extra: {},
    };
    profile.classPlans.push(plan);
  }
  if (timeLayoutId) plan.timeLayoutId = timeLayoutId;
  const count = periodsOf(profile, plan.timeLayoutId).length;
  while (plan.classes.length < count) plan.classes.push({ subjectId: "", isChangedClass: false, isEnabled: true, extra: {} });
  if (plan.classes.length > count) plan.classes.length = count;
  return plan;
}

/** 生成可直接提交给 /configurations 的 Profile 文档（camelCase，保留原有未知字段）。 */
export function writeProfileDocument(profile: CiProfile): Record<string, unknown> {
  const document: Record<string, unknown> = { ...profile.extra };
  document.name = profile.name;
  document.timeLayouts = Object.fromEntries(
    profile.timeLayouts.map((layout) => [
      layout.id,
      {
        ...layout.extra,
        name: layout.name,
        layouts: layout.layouts.map((item) => ({
          ...item.extra,
          startTime: toTimeSpan(item.startTime),
          endTime: toTimeSpan(item.endTime),
          timeType: item.timeType,
          breakName: item.breakName,
          isHideDefault: item.isHideDefault,
          defaultClassId: item.defaultClassId || GLOBAL_CLASS_PLAN_GROUP_ID,
        })),
      },
    ]),
  );
  document.classPlans = Object.fromEntries(
    profile.classPlans.map((plan) => [
      plan.id,
      {
        ...plan.extra,
        name: plan.name,
        timeLayoutId: plan.timeLayoutId,
        classes: plan.classes.map((info) => ({
          ...info.extra,
          subjectId: info.subjectId || GLOBAL_CLASS_PLAN_GROUP_ID,
          isChangedClass: info.isChangedClass,
          isEnabled: info.isEnabled,
        })),
        timeRule: { weekDay: plan.timeRule.weekDay, weekCountDiv: plan.timeRule.weekCountDiv, weekCountDivTotal: plan.timeRule.weekCountDivTotal },
        associatedGroup: plan.associatedGroup,
        isEnabled: plan.isEnabled,
      },
    ]),
  );
  document.subjects = Object.fromEntries(
    profile.subjects.map((subject) => [subject.id, { ...subject.extra, name: subject.name, initial: subject.initial, teacherName: subject.teacherName, isOutDoor: subject.isOutDoor }]),
  );
  document.classPlanGroups = Object.fromEntries(
    profile.classPlanGroups.map((group) => [group.id, { ...group.extra, name: group.name, isGlobal: group.isGlobal }]),
  );
  document.selectedClassPlanGroupId = profile.selectedClassPlanGroupId;
  return document;
}