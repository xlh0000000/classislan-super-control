import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  configurationDocumentSchema,
  policyPublishSchema,
  settingsLockFields,
  settingsLockKeys,
  settingsLockSchema,
  settingsPageFields,
  settingsPagePrefix,
  validateSettingsSection,
} from "../shared/schemas";

/**
 * 设备端 SettingsPolicyService 是设置锁定的唯一执行者；服务端只负责校验与下发。
 * 两侧的键名一旦漂移，就会“发布成功但设备不认”，因此用静态一致性测试守住。
 */
const pluginSource = readFileSync(
  new URL("../plugin/ClassIsland.Control.Plugin/Services/SettingsPolicyService.cs", import.meta.url),
  "utf8",
);
const pagePluginSource = readFileSync(
  new URL("../plugin/ClassIsland.Control.Plugin/Services/SettingsPagePolicyService.cs", import.meta.url),
  "utf8",
);

function pluginKeys(source: string): string[] {
  return [...source.matchAll(/\(\s*"([A-Za-z]+)",\s*"/g)].map((match) => match[1]!);
}

/** ManagedPages 数组里的 (页 Id, 标签) 元组；Id 含点（classisland.plugins）。 */
function managedPages(source: string): { id: string; label: string }[] {
  const block = /ManagedPages\s*=\s*\[([\s\S]*?)\];/.exec(source)?.[1] ?? "";
  return [...block.matchAll(/\(\s*"([\w.]+)",\s*"([^"]+)"\s*\)/g)].map((match) => ({ id: match[1]!, label: match[2]! }));
}

describe("设置锁定键 ↔ 设备端执行器一致性", () => {
  it("服务端字段表与设备端 SettableLocks 完全一致", () => {
    expect(pluginKeys(pluginSource).sort()).toEqual([...settingsLockKeys].sort());
  });

  it("每个字段都有界面所需的标签与说明", () => {
    for (const field of settingsLockFields) {
      expect(field.label.length, `${field.key} 缺少标签`).toBeGreaterThan(0);
      expect(field.hint.length, `${field.key} 缺少说明`).toBeGreaterThan(0);
    }
  });

  it("只有 allowExitManagement 使用反极性（开关表示锁定）", () => {
    const inverted = settingsLockFields.filter((field) => field.invert).map((field) => field.key);
    expect(inverted).toEqual(["allowExitManagement"]);
  });
});

describe("设置锁定校验", () => {
  it("settingsLockSchema 只接受布尔开关", () => {
    expect(settingsLockSchema.safeParse({ disableSettingsEditing: true }).success).toBe(true);
    expect(settingsLockSchema.safeParse({ disableSettingsEditing: "true" }).success).toBe(false);
    expect(settingsLockSchema.safeParse({ disableSettingsEditing: 1 }).success).toBe(false);
  });

  const policy = (document: Record<string, unknown>) => ({
    name: "锁定测试", scopeType: "school" as const, document,
  });

  it("策略允许 settings 布尔节与配置库引用", () => {
    expect(policyPublishSchema.safeParse(policy({ settings: { disableSettingsEditing: true } })).success).toBe(true);
    expect(policyPublishSchema.safeParse(policy({ settings: { $config: "8f1f2f9e-0000-4000-8000-000000000000" } })).success).toBe(true);
  });

  it("策略拒绝非布尔的 settings 取值与数组节", () => {
    expect(policyPublishSchema.safeParse(policy({ settings: { disableSettingsEditing: "yes" } })).success).toBe(false);
    expect(policyPublishSchema.safeParse(policy({ settings: [true] })).success).toBe(false);
  });

  it("配置库允许 settings 类型并校验取值", () => {
    const schema = configurationDocumentSchema("settings");
    expect(schema.safeParse({ schemaVersion: 1, settings: { disableDebugMenu: true } }).success).toBe(true);
    expect(schema.safeParse({ schemaVersion: 1, settings: { disableDebugMenu: "yes" } }).success).toBe(false);
  });
});

describe("设置页逐页管控 ↔ 设备端一致性", () => {
  it("服务端字段表与设备端 ManagedPages 的页 Id 与标签完全一致", () => {
    const pages = managedPages(pagePluginSource);
    expect(pages.length, "ManagedPages 数组解析失败").toBeGreaterThan(0);
    expect(pages.map((page) => page.id)).toEqual(settingsPageFields.map((field) => field.key));
    expect(pages.map((page) => page.label)).toEqual(settingsPageFields.map((field) => field.label));
  });

  it("settings 节接受 page.* 三态并与布尔锁混用", () => {
    expect(settingsLockSchema.safeParse({
      [`${settingsPagePrefix}clock`]: "readonly",
      [`${settingsPagePrefix}classisland.plugins`]: "hidden",
      disableSettingsEditing: true,
    }).success).toBe(true);
    expect(settingsLockSchema.safeParse({ [`${settingsPagePrefix}general`]: "none" }).success).toBe(true);
  });

  it("拒绝未知页 Id、非法强度与错误类型", () => {
    expect(settingsLockSchema.safeParse({ [`${settingsPagePrefix}nope`]: "hidden" }).success).toBe(false);
    expect(settingsLockSchema.safeParse({ [`${settingsPagePrefix}clock`]: "locked" }).success).toBe(false);
    expect(settingsLockSchema.safeParse({ [`${settingsPagePrefix}clock`]: true }).success).toBe(false);
  });

  it("策略发布文档同样守住 page.* 取值", () => {
    const publish = (settings: Record<string, unknown>) => ({ name: "逐页管控", scopeType: "school" as const, document: { settings } });
    expect(policyPublishSchema.safeParse(publish({ [`${settingsPagePrefix}window`]: "readonly" })).success).toBe(true);
    expect(policyPublishSchema.safeParse(publish({ [`${settingsPagePrefix}window`]: 3 })).success).toBe(false);
  });

  it("validateSettingsSection 对空节与 $config 引用直接放行", () => {
    expect(validateSettingsSection({})).toBeNull();
    expect(validateSettingsSection({ $config: "x" })).toBeNull();
  });
});