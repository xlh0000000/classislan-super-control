import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  configurationDocumentSchema,
  policyPublishSchema,
  settingsLockFields,
  settingsLockKeys,
  settingsLockSchema,
} from "../shared/schemas";

/**
 * 设备端 SettingsPolicyService 是设置锁定的唯一执行者；服务端只负责校验与下发。
 * 两侧的键名一旦漂移，就会“发布成功但设备不认”，因此用静态一致性测试守住。
 */
const pluginSource = readFileSync(
  new URL("../plugin/ClassIsland.Control.Plugin/Services/SettingsPolicyService.cs", import.meta.url),
  "utf8",
);

function pluginKeys(source: string): string[] {
  return [...source.matchAll(/\(\s*"([A-Za-z]+)",\s*"/g)].map((match) => match[1]!);
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