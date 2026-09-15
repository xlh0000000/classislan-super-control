import { describe, expect, it } from "vitest";
import {
  boolSetting,
  fromColorInput,
  jsonBool,
  jsonNumber,
  jsonSet,
  newComponentLine,
  newComponentNode,
  readComponentLines,
  readProfileSettings,
  settingFields,
  toColorInput,
  writeComponentLines,
  writeProfileSettings,
} from "../shared/classisland-config";

/** 通道 A：宿主写出的 PascalCase 档案，带叠加课表与临时课表群开关。 */
const hostProfile = {
  Name: "示例档案",
  Id: "99999999-9999-9999-9999-999999999999",
  IsOverlayClassPlanEnabled: true,
  OverlayClassPlanId: "44444444-4444-4444-4444-444444444444",
  IsTempClassPlanGroupEnabled: false,
  TempClassPlanGroupType: 0,
  SelectedClassPlanGroupId: "acaf4ef0-e261-4262-b941-34ea93cb4369",
  OrderedSchedules: {},
  TimeLayouts: { "33333333-3333-3333-3333-333333333333": { Name: "夏季作息", Layouts: [] } },
  ClassPlanGroups: {
    "acaf4ef0-e261-4262-b941-34ea93cb4369": { Name: "默认", IsGlobal: false },
    "00000000-0000-0000-0000-000000000000": { Name: "全局课表群", IsGlobal: true }
  },
  ClassPlans: { "44444444-4444-4444-4444-444444444444": { Name: "周一课表" } },
  Subjects: {},
  schemaVersion: 1
};

describe("readProfileSettings", () => {
  it("大小写不敏感地读取开关、下拉候选与课表群", () => {
    const model = readProfileSettings(hostProfile);
    expect(model.name).toBe("示例档案");
    expect(model.overlayEnabled).toBe(true);
    expect(model.overlayClassPlanId).toBe("44444444-4444-4444-4444-444444444444");
    expect(model.tempGroupEnabled).toBe(false);
    expect(model.tempGroupType).toBe(0);
    expect(model.classPlans).toEqual([{ id: "44444444-4444-4444-4444-444444444444", name: "周一课表" }]);
    expect(model.groups.map((group) => group.name)).toEqual(["默认", "全局课表群"]);
  });

  it("只改动会话字段，其余顶层节原样保留", () => {
    const model = readProfileSettings(hostProfile);
    model.tempGroupEnabled = true;
    model.tempGroupType = 1;
    const document = writeProfileSettings(model);

    expect(document.TimeLayouts).toEqual(hostProfile.TimeLayouts);
    expect(document.ClassPlans).toEqual(hostProfile.ClassPlans);
    expect(document.OrderedSchedules).toEqual({});
    expect(jsonBool(document, "IsTempClassPlanGroupEnabled")).toBe(true);
    expect(jsonNumber(document, "TempClassPlanGroupType")).toBe(1);
    // 写回时复用已有键名，不产生 Pascal 与 camel 两份副本。
    expect(Object.keys(document).filter((key) => key.toLowerCase() === "isoverlayclassplanenabled")).toHaveLength(1);
  });
});

describe("组件布局", () => {
  const componentDocument = {
    Lines: [
      {
        IsMainLine: true,
        IsNotificationEnabled: false,
        IslandSeparationMode: 2,
        CustomCornerRadius: 4,
        Children: [
          {
            Id: "DF3F8295-21F6-482E-BADA-FA0E5F14BB66",
            NameCache: "时间",
            MainWindowBodyFontSize: 12,
            Settings: { ShowExtraInfoOnTimePoint: true, ExtraInfoType: 1, Title: "课程", Accent: "#1E90FFFF", Nested: { a: 1 } },
            BackgroundColor: "#000000FF",
            CustomCornerRadius: 8
          }
        ]
      }
    ],
    schemaVersion: 1
  };

  it("读取行与组件，并把 Settings 拆成可表单化的标量", () => {
    const lines = readComponentLines(componentDocument);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.isMainLine).toBe(true);
    expect(lines[0]?.isNotificationEnabled).toBe(false);
    expect(lines[0]?.islandSeparationMode).toBe(2);
    const node = lines[0]?.children[0];
    expect(node?.id).toBe("DF3F8295-21F6-482E-BADA-FA0E5F14BB66");
    expect(node?.name).toBe("时间");
    expect(node?.fontSize).toBe(12);
    expect(node?.hasSettings).toBe(true);
    expect(settingFields(node!).map((field) => field.kind)).toEqual(["bool", "number", "text", "color"]);
    expect(boolSetting(node!, "ShowExtraInfoOnTimePoint")).toBe(true);
  });

  it("写回时保留未建模字段与复杂设置值", () => {
    const lines = readComponentLines(componentDocument);
    lines[0]!.children[0]!.settings.ShowExtraInfoOnTimePoint = false;
    const document = writeComponentLines(componentDocument, lines);

    expect(jsonNumber(document, "schemaVersion")).toBe(1);
    const line = (document.Lines as Record<string, unknown>[])[0]!;
    expect(line.CustomCornerRadius).toBe(4);
    const node = (line.Children as Record<string, unknown>[])[0]!;
    expect(node.CustomCornerRadius).toBe(8);
    const settings = node.Settings as Record<string, unknown>;
    expect(settings.ShowExtraInfoOnTimePoint).toBe(false);
    expect(settings.Nested).toEqual({ a: 1 });
    expect(node.NameCache).toBe("时间");
  });

  it("新增行只写入默认结构", () => {
    const line = newComponentLine();
    expect(line.children).toHaveLength(1);
    const document = writeComponentLines({}, [line]);
    const written = (document.Lines as Record<string, unknown>[])[0]!;
    expect(written.Children).toHaveLength(1);
    expect((written.Children as Record<string, unknown>[])[0]!.Id).toBe("");
  });
});

describe("颜色与开关辅助", () => {
  it("在 #RRGGBBAA 与 input[type=color] 的 #RRGGBB 之间往返", () => {
    expect(toColorInput("#1E90FFFF")).toBe("#1E90FF");
    expect(fromColorInput("#1E90FF", "#1E90FFFF")).toBe("#1E90FFFF");
    expect(fromColorInput("#1e90ff", "")).toBe("#1E90FFFF");
    expect(toColorInput("", "#000000")).toBe("#000000");
  });

  it("jsonSet 复用已有键名", () => {
    const record: Record<string, unknown> = { Name: "旧" };
    jsonSet(record, "name", "新");
    expect(record).toEqual({ Name: "新" });
    const node = newComponentNode("AAAA");
    expect(node.id).toBe("AAAA");
    expect(node.hasSettings).toBe(false);
  });
});