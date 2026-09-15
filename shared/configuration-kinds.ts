/**
 * 配置库的四种配置：导航栏按类型各给一个入口。
 * 课表（档案）已有专门的课表页，这里只把入口指过去，不再另建页。
 */
export type ConfigKindEntry = {
  id: "profile" | "components" | "automation" | "plugin";
  /** 导航栏短名 */
  nav: string;
  /** 导航栏右侧小字 */
  code: string;
  kicker: string;
  description: string;
  /** 导航目标：课表指向已有课表页，其余指向配置库的类型页 */
  page: string;
};

export const configKindEntries: ConfigKindEntry[] = [
  {
    id: "profile",
    nav: "课表",
    code: "TIMETABLE",
    kicker: "TIMETABLE / 档案与课表",
    description: "课表、时间表与科目都写在档案里，去课表页编辑，这里只用于下发与回滚。",
    page: "/timetable",
  },
  {
    id: "components",
    nav: "组件布局",
    code: "COMPONENTS",
    kicker: "COMPONENTS / 组件布局",
    description: "主界面放哪些组件、怎么排版，用结构化控件直接编辑。",
    page: "/configurations/components",
  },
  {
    id: "automation",
    nav: "自动化",
    code: "AUTOMATION",
    kicker: "AUTOMATION / 自动化工作流",
    description: "触发条件与动作组成的工作流，在编辑器的 JSON 分页里改。",
    page: "/configurations/automation",
  },
  {
    id: "plugin",
    nav: "插件设置",
    code: "PLUGIN",
    kicker: "PLUGIN / 插件设置",
    description: "集控插件在设备上的行为设置，在编辑器的 JSON 分页里改。",
    page: "/configurations/plugin",
  },
];

/** 按类型取入口；未知类型返回 null，页面据此报 404。 */
export function configKindEntry(id: string): ConfigKindEntry | null {
  return configKindEntries.find((entry) => entry.id === id) ?? null;
}
