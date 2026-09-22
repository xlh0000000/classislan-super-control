import { describe, expect, it } from "vitest";
import { enrollmentTokenSchema, pollSchema } from "../shared/schemas";

describe("protocol schemas", () => {
  it("rejects long-lived enrollment credentials", () => {
    expect(enrollmentTokenSchema.safeParse({ kind: "code", ttlMinutes: 1441 }).success).toBe(false);
  });

  it("requires bundle credentials to declare multiple uses", () => {
    expect(enrollmentTokenSchema.safeParse({ kind: "bundle", ttlMinutes: 60, maxUses: 1 }).success).toBe(false);
    expect(enrollmentTokenSchema.safeParse({ kind: "bundle", ttlMinutes: 60, maxUses: 20 }).success).toBe(true);
  });

  it("accepts an empty authenticated poll payload", () => {
    expect(pollSchema.safeParse({
      deviceId: "2e64dbad-e2f3-49f3-9629-1bb4681fffb6",
      sequence: 1,
      timestampUtc: "2026-09-11T00:00:00.000Z",
      pluginVersion: "0.1.0",
      appVersion: "2.1.1.1",
      platform: "Windows/x64",
      capabilityDigest: "abc",
      policyRevision: 0,
      driftCount: 0,
      acknowledgements: [],
    }).success).toBe(true);
  });

  // 自升级回报是新字段：已经在跑的插件根本不会带它们，缺省必须等于「本机没有升级动作」。
  it("treats omitted plugin update report fields as no pending upgrade", () => {
    const base = {
      deviceId: "2e64dbad-e2f3-49f3-9629-1bb4681fffb6",
      sequence: 1,
      timestampUtc: "2026-09-11T00:00:00.000Z",
      pluginVersion: "0.1.0",
      appVersion: "2.1.1.1",
      platform: "Windows/x64",
      capabilityDigest: "abc",
      policyRevision: 0,
      driftCount: 0,
      acknowledgements: [],
    };
    expect(pollSchema.parse(base)).toMatchObject({ pluginUpdateState: "", pluginUpdateVersion: "" });
    expect(pollSchema.safeParse({ ...base, pluginUpdateState: "staged", pluginUpdateVersion: "0.1.7.0" }).success).toBe(true);
    expect(pollSchema.safeParse({ ...base, pluginUpdateState: "downloading" }).success).toBe(false);
    expect(pollSchema.safeParse({ ...base, pluginUpdateVersion: "x".repeat(33) }).success).toBe(false);
  });
});
