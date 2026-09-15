import { describe, expect, it } from "vitest";
import { resolveSubjectShortcut } from "../shared/subject-shortcut";

const subjects = [
  { id: "a", name: "语文", initial: "语" },
  { id: "b", name: "数学", initial: "数" },
  { id: "c", name: "English", initial: "y" },
  { id: "d", name: "体育", initial: "" },
];

describe("科目快选快捷键", () => {
  it("数字键按顺序直选，0 是清空", () => {
    expect(resolveSubjectShortcut(subjects, "1")).toEqual({ clear: false, id: "a" });
    expect(resolveSubjectShortcut(subjects, "3")).toEqual({ clear: false, id: "c" });
    expect(resolveSubjectShortcut(subjects, "0")).toEqual({ clear: true });
  });

  it("数字越界不处理", () => {
    expect(resolveSubjectShortcut(subjects, "5")).toBeNull();
  });

  it("按简称首字符选，简称缺省时用名称首字", () => {
    expect(resolveSubjectShortcut(subjects, "数")).toEqual({ clear: false, id: "b" });
    expect(resolveSubjectShortcut(subjects, "y")).toEqual({ clear: false, id: "c" });
    expect(resolveSubjectShortcut(subjects, "Y")).toEqual({ clear: false, id: "c" });
    expect(resolveSubjectShortcut(subjects, "体")).toEqual({ clear: false, id: "d" });
  });

  it("没有匹配或多字符按键不处理", () => {
    expect(resolveSubjectShortcut(subjects, "z")).toBeNull();
    expect(resolveSubjectShortcut(subjects, "yu")).toBeNull();
    expect(resolveSubjectShortcut(subjects, "")).toBeNull();
  });

  it("数字直选优先于首字符匹配", () => {
    const numeric = [{ id: "x", name: "1班", initial: "1" }];
    expect(resolveSubjectShortcut(numeric, "1")).toEqual({ clear: false, id: "x" });
  });
});