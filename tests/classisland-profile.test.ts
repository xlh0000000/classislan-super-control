import { describe, expect, it } from "vitest";
import {
  DEFAULT_CLASS_PLAN_GROUP_ID,
  GLOBAL_CLASS_PLAN_GROUP_ID,
  emptyProfile,
  ensureClassPlan,
  findClassPlan,
  periodsOf,
  readProfile,
  toClock,
  toTimeSpan,
  writeProfileDocument,
} from "../shared/classisland-profile";

const SUBJECT_LANGUAGE = "11111111-1111-1111-1111-111111111111";
const SUBJECT_MATH = "22222222-2222-2222-2222-222222222222";
const LAYOUT_ID = "33333333-3333-3333-3333-333333333333";
const PLAN_MONDAY = "44444444-4444-4444-4444-444444444444";

/** 模拟宿主写出的 PascalCase Profile.json（ClassIsland 默认命名策略）。 */
const hostProfile = {
  Name: "示例学校档案",
  Id: "99999999-9999-9999-9999-999999999999",
  IsOverlayClassPlanEnabled: true,
  TimeLayouts: {
    [LAYOUT_ID]: {
      Name: "夏季作息",
      Layouts: [
        { StartTime: "08:00:00", EndTime: "08:45:00", TimeType: 0, BreakName: "", IsHideDefault: false, DefaultClassId: "00000000-0000-0000-0000-000000000000" },
        { StartTime: "08:45:00", EndTime: "08:55:00", TimeType: 1, BreakName: "早休", IsHideDefault: false, DefaultClassId: "00000000-0000-0000-0000-000000000000" },
        { StartTime: "08:55:00", EndTime: "09:40:00", TimeType: 0, BreakName: "", IsHideDefault: false, DefaultClassId: "00000000-0000-0000-0000-000000000000" },
      ],
    },
  },
  ClassPlans: {
    [PLAN_MONDAY]: {
      Name: "周一",
      TimeLayoutId: LAYOUT_ID,
      Classes: [
        { SubjectId: SUBJECT_LANGUAGE, IsChangedClass: false, IsEnabled: true },
        { SubjectId: SUBJECT_MATH, IsChangedClass: false, IsEnabled: true },
      ],
      TimeRule: { WeekDay: 1, WeekCountDiv: 0, WeekCountDivTotal: 2 },
      AssociatedGroup: DEFAULT_CLASS_PLAN_GROUP_ID,
      IsEnabled: true,
    },
  },
  Subjects: {
    [SUBJECT_LANGUAGE]: { Name: "语文", Initial: "语", TeacherName: "张老师", IsOutDoor: false },
    [SUBJECT_MATH]: { Name: "数学", Initial: "数", TeacherName: "", IsOutDoor: false },
  },
  ClassPlanGroups: {
    [DEFAULT_CLASS_PLAN_GROUP_ID]: { Name: "默认", IsGlobal: false },
    [GLOBAL_CLASS_PLAN_GROUP_ID]: { Name: "全局课表群", IsGlobal: true },
  },
  SelectedClassPlanGroupId: DEFAULT_CLASS_PLAN_GROUP_ID,
};

describe("classisland profile model", () => {
  it("normalizes a PascalCase host profile into camelCase structures", () => {
    const profile = readProfile(hostProfile);
    expect(profile.name).toBe("示例学校档案");
    expect(profile.timeLayouts).toHaveLength(1);
    expect(profile.timeLayouts[0]?.name).toBe("夏季作息");
    expect(profile.subjects.map((subject) => subject.name)).toEqual(["数学", "语文"]);
    const plan = findClassPlan(profile, DEFAULT_CLASS_PLAN_GROUP_ID, 1);
    expect(plan?.name).toBe("周一");
    expect(plan?.classes.map((info) => info.subjectId)).toEqual([SUBJECT_LANGUAGE, SUBJECT_MATH]);
    // 未建模字段原样保留，避免保存时丢数据。
    expect(profile.extra["Id"]).toBe("99999999-9999-9999-9999-999999999999");
    expect(profile.extra["IsOverlayClassPlanEnabled"]).toBe(true);
  });

  it("counts only '上课' time points as periods", () => {
    const profile = readProfile(hostProfile);
    const periods = periodsOf(profile, LAYOUT_ID);
    expect(periods).toHaveLength(2);
    expect(periods[0]?.item.startTime).toBe("08:00");
    expect(periods[1]?.item.startTime).toBe("08:55");
  });

  it("keeps class lists aligned with the timetable when editing a day", () => {
    const profile = readProfile(hostProfile);
    const plan = ensureClassPlan(profile, DEFAULT_CLASS_PLAN_GROUP_ID, 2, LAYOUT_ID, "周二");
    expect(plan.classes).toHaveLength(2);
    expect(plan.timeRule.weekDay).toBe(2);
    const shortened = profile.timeLayouts[0]!;
    shortened.layouts = shortened.layouts.filter((item) => item.timeType !== 0 || item.startTime === "08:00");
    ensureClassPlan(profile, DEFAULT_CLASS_PLAN_GROUP_ID, 2, LAYOUT_ID, "周二");
    expect(plan.classes).toHaveLength(1);
  });

  it("round-trips through writeProfileDocument without losing data", () => {
    const profile = readProfile(hostProfile);
    const document = writeProfileDocument(profile);
    const again = readProfile(document);
    expect(again.name).toBe(profile.name);
    expect(again.subjects.map((subject) => subject.name)).toEqual(profile.subjects.map((subject) => subject.name));
    expect(again.timeLayouts[0]?.layouts[0]?.startTime).toBe("08:00");
    expect(again.classPlans[0]?.classes[1]?.subjectId).toBe(SUBJECT_MATH);
    expect(again.extra["Id"]).toBe("99999999-9999-9999-9999-999999999999");
    // .NET TimeSpan 往返格式。
    const layouts = document.timeLayouts as Record<string, { layouts: { startTime: string }[] }>;
    expect(layouts[LAYOUT_ID]?.layouts[0]?.startTime).toBe("08:00:00");
  });

  it("provides a usable empty profile with default groups and a timetable", () => {
    const profile = emptyProfile();
    expect(profile.classPlanGroups.some((group) => group.id === DEFAULT_CLASS_PLAN_GROUP_ID)).toBe(true);
    expect(profile.classPlanGroups.some((group) => group.id === GLOBAL_CLASS_PLAN_GROUP_ID)).toBe(true);
    expect(profile.timeLayouts).toHaveLength(1);
    expect(periodsOf(profile, profile.timeLayouts[0]!.id).length).toBeGreaterThan(0);
  });

  it("normalizes clock strings both ways", () => {
    expect(toClock("08:05:30")).toBe("08:05");
    expect(toClock("8:05")).toBe("08:05");
    expect(toClock("")).toBe("00:00");
    expect(toTimeSpan("8:5")).toBe("08:05:00");
    expect(toTimeSpan("08:05")).toBe("08:05:00");
  });
});