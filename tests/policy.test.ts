import { describe, expect, it } from "vitest";
import {
  hasLockedDescendant,
  isLockedPath,
  normalizePointer,
  normalizePointers,
  resolvePolicy,
} from "../server/utils/policy";

describe("layered policy resolution", () => {
  it("keeps a locked parent path from lower layers", () => {
    const result = resolvePolicy([
      { scopeType: "school", scopeId: null, priority: 0, revision: 1, document: { profile: { enabled: true, name: "school" } }, locks: ["/profile/enabled"] },
      { scopeType: "device", scopeId: "device", priority: 0, revision: 2, document: { profile: { enabled: false, name: "device" } }, locks: [] },
    ]);
    expect(result.document).toEqual({ profile: { enabled: true, name: "device" } });
    expect(result.locks["/profile/enabled"]?.scopeType).toBe("school");
  });

  it("does not allow a lower layer to replace a locked descendant with null", () => {
    const result = resolvePolicy([
      { scopeType: "school", scopeId: null, priority: 0, revision: 1, document: { profile: { enabled: true, name: "school" } }, locks: ["/profile/enabled"] },
      { scopeType: "device", scopeId: "device", priority: 0, revision: 2, document: { profile: null }, locks: [] },
    ]);
    expect(result.document).toEqual({ profile: { enabled: true, name: "school" } });
  });

  it("does not allow a lower layer to replace a locked descendant with an array", () => {
    const result = resolvePolicy([
      { scopeType: "school", scopeId: null, priority: 0, revision: 1, document: { profile: { enabled: true } }, locks: ["/profile/enabled"] },
      { scopeType: "device", scopeId: "device", priority: 0, revision: 2, document: { profile: ["shadow"] }, locks: [] },
    ]);
    expect(result.document).toEqual({ profile: { enabled: true } });
  });

  it("still merges objects into a subtree that has locked descendants", () => {
    const result = resolvePolicy([
      { scopeType: "school", scopeId: null, priority: 0, revision: 1, document: { profile: { enabled: true, name: "school" } }, locks: ["/profile/enabled"] },
      { scopeType: "device", scopeId: "device", priority: 0, revision: 2, document: { profile: { name: "device", extra: 1 } }, locks: [] },
    ]);
    expect(result.document).toEqual({ profile: { enabled: true, name: "device", extra: 1 } });
  });

  it("carries the desired-state epoch through resolution", () => {
    const result = resolvePolicy([], 7);
    expect(result).toMatchObject({ revision: 0, epoch: 7, document: {}, locks: {} });
  });
});

describe("RFC 6901 JSON Pointer", () => {
  it("decodes ~1 before ~0 so that ~01 is not misread as /", () => {
    expect(normalizePointer("/a~01b")).toBe("/a~01b");
    expect(normalizePointer("/a~1b")).toBe("/a~1b");
    expect(normalizePointer("/a~0b")).toBe("/a~0b");
    expect(normalizePointer("/a~1~0b")).toBe("/a~1~0b");
    // 未转义的 "/" 分隔 token，转义后的 ~0/~1 必须原样往返。
    expect(normalizePointer("/profile/~/name")).toBe("/profile/~0/name");
  });

  it("treats an escaped slash as part of a single key", () => {
    const result = resolvePolicy([
      { scopeType: "school", scopeId: null, priority: 0, revision: 1, document: { "a/b": { x: 1 } }, locks: ["/a~1b/x"] },
      { scopeType: "device", scopeId: "d", priority: 0, revision: 2, document: { "a/b": { x: 2 } }, locks: [] },
    ]);
    expect(result.document).toEqual({ "a/b": { x: 1 } });
  });

  it("treats an escaped tilde as part of a single key", () => {
    const result = resolvePolicy([
      { scopeType: "school", scopeId: null, priority: 0, revision: 1, document: { "a~b": 1 }, locks: ["/a~0b"] },
      { scopeType: "device", scopeId: "d", priority: 0, revision: 2, document: { "a~b": 2 }, locks: [] },
    ]);
    expect(result.document).toEqual({ "a~b": 1 });
  });

  it("normalizes, deduplicates and drops the root pointer", () => {
    expect(normalizePointers(["/a/~1b", "/a/~1b", "", "/c"])).toEqual(["/a/~1b", "/c"]);
  });

  it("rejects pointers that do not start with a slash", () => {
    expect(() => normalizePointer("profile")).toThrow(RangeError);
  });

  it("matches locks on the exact path and descendants", () => {
    expect(isLockedPath("/a/b", ["/a"])).toBe(true);
    expect(isLockedPath("/ab", ["/a"])).toBe(false);
    expect(hasLockedDescendant("/a", ["/a/b"])).toBe(true);
    expect(hasLockedDescendant("/a/b", ["/a"])).toBe(false);
  });
});