import { describe, expect, it } from "vitest";
import { configurationDocumentSchema, normalizeConfigurationDocument } from "../shared/schemas";

describe("configuration document validation", () => {
  it("rejects documents whose root is not an object", () => {
    expect(configurationDocumentSchema("profile").safeParse([1, 2, 3]).success).toBe(false);
    expect(configurationDocumentSchema("profile").safeParse("text").success).toBe(false);
    expect(configurationDocumentSchema("profile").safeParse(null).success).toBe(false);
  });

  it("rejects a non-positive or non-integer schemaVersion", () => {
    expect(configurationDocumentSchema("profile").safeParse({ schemaVersion: 0 }).success).toBe(false);
    expect(configurationDocumentSchema("profile").safeParse({ schemaVersion: 1.5 }).success).toBe(false);
    expect(configurationDocumentSchema("profile").safeParse({ schemaVersion: "1" }).success).toBe(false);
    expect(configurationDocumentSchema("profile").safeParse({ schemaVersion: 3 }).success).toBe(true);
  });

  it("requires the kind's top-level section to be an object when present", () => {
    expect(configurationDocumentSchema("components").safeParse({ components: ["bad"] }).success).toBe(false);
    expect(configurationDocumentSchema("components").safeParse({ components: {} }).success).toBe(true);
    // 其他类型的节不参与 components 的结构校验。
    expect(configurationDocumentSchema("components").safeParse({ automation: ["allowed"] }).success).toBe(true);
  });

  it("stamps a default schemaVersion when normalizing", () => {
    expect(normalizeConfigurationDocument("profile", { profile: { name: "x" } })).toEqual({ profile: { name: "x" }, schemaVersion: 1 });
    expect(normalizeConfigurationDocument("profile", { schemaVersion: 4 })).toEqual({ schemaVersion: 4 });
  });
});