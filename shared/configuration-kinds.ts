/**
 * 配置库的四种配置：导航栏按类型各给一个入口，四类都先进列表。
 * 课表（档案）的列表在这里，从行上再进课表页编辑具体内容。
 */
export type ConfigKindEntry = {
  id: "profile" | "components" | "automation" | "plugin";
  /** 导航栏短名 */
  nav: string;
  /** 类型页标题上的小字 */
  kicker: string;
  /** 导航目标：该类型的配置列表页 */
  page: string;
};

export const configKindEntries: ConfigKindEntry[] = [
  { id: "profile", nav: "课表", kicker: "课表档案", page: "/configurations/profile" },
  { id: "components", nav: "组件布局", kicker: "主界面组件", page: "/configurations/components" },
  { id: "automation", nav: "自动化", kicker: "自动化流程", page: "/configurations/automation" },
  { id: "plugin", nav: "插件设置", kicker: "插件行为", page: "/configurations/plugin" },
];

/** 按类型取入口；未知类型返回 null，页面据此报 404。 */
export function configKindEntry(id: string): ConfigKindEntry | null {
  return configKindEntries.find((entry) => entry.id === id) ?? null;
}