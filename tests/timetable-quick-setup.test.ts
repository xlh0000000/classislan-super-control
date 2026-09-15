import { describe, expect, it } from "vitest";
import {
  analyzeQuickTable,
  applyQuickSetup,
  detectPeriodRef,
  detectWeekday,
  parseQuickTable,
  parseSubjectCell,
  previewQuickSetup,
} from "../shared/timetable-quick-setup";
import {
  DEFAULT_CLASS_PLAN_GROUP_ID,
  emptyProfile,
  findClassPlan,
  periodsOf,
  type CiProfile,
} from "../shared/classisland-profile";

function fixture() {
  const profile = emptyProfile("快装测试");
  const layoutId = profile.timeLayouts[0]!.id;
  return { profile, layoutId };
}

function subjectId(profile: CiProfile, name: string): string {
  return profile.subjects.find((subject) => subject.name === name)?.id ?? "";
}

describe("快装表格解析", () => {
  it("自动嗅探制表符、半角逗号与全角逗号", () => {
    expect(parseQuickTable("周一\t周二\n语文\t数学")).toEqual([
      ["周一", "周二"],
      ["语文", "数学"],
    ]);
    expect(parseQuickTable("周一,周二\n语文,数学")).toEqual([
      ["周一", "周二"],
      ["语文", "数学"],
    ]);
    expect(parseQuickTable("周一，周二\n语文，数学")).toEqual([
      ["周一", "周二"],
      ["语文", "数学"],
    ]);
  });

  it("处理 CSV 引号与空行", () => {
    expect(parseQuickTable('周一,周二\n\n"语,文",数学')).toEqual([
      ["周一", "周二"],
      ["语,文", "数学"],
    ]);
  });

  it("识别星期表头", () => {
    expect(detectWeekday("周一")).toBe(1);
    expect(detectWeekday("星期一")).toBe(1);
    expect(detectWeekday("星期天")).toBe(0);
    expect(detectWeekday("周日（上午）")).toBe(0);
    expect(detectWeekday("Mon")).toBe(1);
    expect(detectWeekday("节次")).toBeNull();
    expect(detectWeekday("")).toBeNull();
  });

  it("识别节次：时间区间、序号与中文数字", () => {
    expect(detectPeriodRef("08:00-08:45")).toEqual({ kind: "time", start: "08:00", end: "08:45" });
    expect(detectPeriodRef("08:00:00-08:45:00")).toEqual({ kind: "time", start: "08:00", end: "08:45" });
    expect(detectPeriodRef("08:00~09:00")).toEqual({ kind: "time", start: "08:00", end: "09:00" });
    expect(detectPeriodRef("第3节")).toEqual({ kind: "index", index: 2 });
    expect(detectPeriodRef("3")).toEqual({ kind: "index", index: 2 });
    expect(detectPeriodRef("三")).toEqual({ kind: "index", index: 2 });
    expect(detectPeriodRef("十二")).toEqual({ kind: "index", index: 11 });
    expect(detectPeriodRef("上午")).toBeNull();
  });

  it("把任课教师写进括号", () => {
    expect(parseSubjectCell("语文(张三)")).toEqual({ name: "语文", teacherName: "张三" });
    expect(parseSubjectCell("英语（李四）")).toEqual({ name: "英语", teacherName: "李四" });
    expect(parseSubjectCell("数学")).toEqual({ name: "数学", teacherName: "" });
    expect(parseSubjectCell("—")).toBeNull();
    expect(parseSubjectCell("")).toBeNull();
  });

  it("星期在行时自动转置", () => {
    const analysis = analyzeQuickTable([
      ["", "第1节", "第2节"],
      ["周一", "语文", "数学"],
      ["周二", "英语", "物理"],
    ]);
    expect(analysis.transposed).toBe(true);
    expect(analysis.headerRow).toBe(true);
    expect(analysis.headerColumn).toBe(true);
    expect(analysis.grid[1]).toEqual(["第1节", "语文", "英语"]);
  });
});

describe("快装预览与写入", () => {
  it("预览不修改档案", () => {
    const { profile, layoutId } = fixture();
    const preview = previewQuickSetup(profile, {
      text: "节次\t周一\t周二\n第1节\t语文\t数学\n第2节\t语文(张老师)\t数学",
      layoutId,
      groupId: DEFAULT_CLASS_PLAN_GROUP_ID,
    });
    expect(preview.cells).toBe(4);
    expect(preview.subjects.map((subject) => subject.name)).toEqual(["语文", "数学"]);
    expect(preview.columns.map((column) => column.weekDay)).toEqual([null, 1, 2]);
    expect(profile.subjects).toEqual([]);
    expect(findClassPlan(profile, DEFAULT_CLASS_PLAN_GROUP_ID, 1)).toBeUndefined();
  });

  it("写入课表、建科目并记住任课教师", () => {
    const { profile, layoutId } = fixture();
    const result = applyQuickSetup(profile, {
      text: "节次\t周一\t周二\n第1节\t语文\t数学\n第2节\t语文(张老师)\t数学",
      layoutId,
      groupId: DEFAULT_CLASS_PLAN_GROUP_ID,
    });
    expect(result).toEqual({ createdSubjects: 2, createdPeriods: 0, writtenCells: 4, skippedCells: 0 });
    expect(subjectId(profile, "数学")).not.toBe("");
    expect(profile.subjects.find((subject) => subject.name === "语文")?.teacherName).toBe("张老师");

    const monday = findClassPlan(profile, DEFAULT_CLASS_PLAN_GROUP_ID, 1);
    const tuesday = findClassPlan(profile, DEFAULT_CLASS_PLAN_GROUP_ID, 2);
    expect(monday?.name).toBe("周一课表");
    expect(monday?.classes[0]?.subjectId).toBe(subjectId(profile, "语文"));
    expect(monday?.classes[1]?.subjectId).toBe(subjectId(profile, "语文"));
    expect(tuesday?.classes[0]?.subjectId).toBe(subjectId(profile, "数学"));
  });

  it("仅填空模式跳过已有课", () => {
    const { profile, layoutId } = fixture();
    applyQuickSetup(profile, {
      text: "节次\t周一\t周二\n第1节\t语文\t数学",
      layoutId,
      groupId: DEFAULT_CLASS_PLAN_GROUP_ID,
    });
    const result = applyQuickSetup(profile, {
      text: "节次\t周一\t周二\n第1节\t体育\t数学\n第2节\t体育\t体育",
      layoutId,
      groupId: DEFAULT_CLASS_PLAN_GROUP_ID,
      mode: "fill",
    });
    expect(result.skippedCells).toBe(2);
    expect(result.writtenCells).toBe(2);
    expect(findClassPlan(profile, DEFAULT_CLASS_PLAN_GROUP_ID, 1)?.classes[0]?.subjectId).toBe(subjectId(profile, "语文"));
    expect(findClassPlan(profile, DEFAULT_CLASS_PLAN_GROUP_ID, 1)?.classes[1]?.subjectId).toBe(subjectId(profile, "体育"));
  });

  it("按时间区间补建时间点并保持排序", () => {
    const { profile, layoutId } = fixture();
    const before = periodsOf(profile, layoutId).length;
    const result = applyQuickSetup(profile, {
      text: "节次\t周一\n07:00-07:45\t早读\n09:00-09:45\t数学",
      layoutId,
      groupId: DEFAULT_CLASS_PLAN_GROUP_ID,
    });
    expect(result.createdPeriods).toBe(2);
    const layout = profile.timeLayouts[0]!;
    const starts = layout.layouts.map((item) => item.startTime);
    expect(starts).toEqual([...starts].sort());
    expect(starts[0]).toBe("07:00");

    const periods = periodsOf(profile, layoutId);
    expect(periods.length).toBe(before + 2);
    const plan = findClassPlan(profile, DEFAULT_CLASS_PLAN_GROUP_ID, 1);
    const indexOf = (start: string) => periods.findIndex((period) => period.item.startTime === start);
    expect(plan?.classes[indexOf("07:00")]?.subjectId).toBe(subjectId(profile, "早读"));
    expect(plan?.classes[indexOf("09:00")]?.subjectId).toBe(subjectId(profile, "数学"));
  });

  it("复用已有时间点而不重复添加", () => {
    const { profile, layoutId } = fixture();
    applyQuickSetup(profile, {
      text: "节次\t周一\n08:00-08:45\t语文",
      layoutId,
      groupId: DEFAULT_CLASS_PLAN_GROUP_ID,
    });
    expect(profile.timeLayouts[0]!.layouts.length).toBe(15);
    expect(findClassPlan(profile, DEFAULT_CLASS_PLAN_GROUP_ID, 1)?.classes[0]?.subjectId).toBe(subjectId(profile, "语文"));
  });

  it("缺少星期表头时给出提示且不写入", () => {
    const { profile, layoutId } = fixture();
    const preview = previewQuickSetup(profile, {
      text: "科目\t语文\t数学",
      layoutId,
      groupId: DEFAULT_CLASS_PLAN_GROUP_ID,
    });
    expect(preview.cells).toBe(0);
    expect(preview.messages.join("")).toContain("星期");
  });
});