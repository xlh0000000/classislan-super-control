import { describe, expect, it } from "vitest";

type HttpError = Error & { statusCode?: number };
(globalThis as unknown as { createError: (opts: { statusCode: number; message: string }) => HttpError }).createError =
  (opts) => Object.assign(new Error(opts.message), { statusCode: opts.statusCode });

import { requirePermission } from "../server/utils/permissions";

function allows(role: string, permission: string) {
  try {
    requirePermission({ role }, permission);
    return true;
  } catch {
    return false;
  }
}

describe("role permission matrix", () => {
  it("grants the owner every permission, including ones not in the table", () => {
    for (const permission of ["devices.write", "users.write", "system.write", "made.up.permission"])
      expect(allows("owner", permission)).toBe(true);
  });

  it("lets admin manage users and read audit but not invent permissions", () => {
    expect(allows("admin", "users.write")).toBe(true);
    expect(allows("admin", "users.read")).toBe(true);
    expect(allows("admin", "audit.read")).toBe(true);
    expect(allows("admin", "made.up.permission")).toBe(false);
  });

  it("limits operator to device and task operations plus audit read", () => {
    expect(allows("operator", "devices.write")).toBe(true);
    expect(allows("operator", "tasks.write")).toBe(true);
    expect(allows("operator", "audit.read")).toBe(true);
    expect(allows("operator", "policies.write")).toBe(false);
    expect(allows("operator", "users.read")).toBe(false);
    expect(allows("operator", "system.write")).toBe(false);
  });

  it("keeps auditor read-only on the audit log", () => {
    expect(allows("auditor", "audit.read")).toBe(true);
    expect(allows("auditor", "devices.read")).toBe(false);
    expect(allows("auditor", "devices.write")).toBe(false);
    expect(allows("auditor", "users.read")).toBe(false);
  });

  it("lets admin publish roll-call rosters but keeps operator read-only", () => {
    expect(allows("admin", "rollcall.read")).toBe(true);
    expect(allows("admin", "rollcall.write")).toBe(true);
    expect(allows("operator", "rollcall.read")).toBe(true);
    expect(allows("operator", "rollcall.write")).toBe(false);
    expect(allows("viewer", "rollcall.read")).toBe(true);
    expect(allows("viewer", "rollcall.write")).toBe(false);
  });

  it("keeps viewer read-only", () => {
    expect(allows("viewer", "devices.read")).toBe(true);
    expect(allows("viewer", "tasks.read")).toBe(true);
    expect(allows("viewer", "organization.read")).toBe(true);
    expect(allows("viewer", "devices.write")).toBe(false);
    expect(allows("viewer", "tasks.write")).toBe(false);
    expect(allows("viewer", "audit.read")).toBe(false);
  });

  it("limits teacher to bound-device roll-call and timetable apply", () => {
    expect(allows("teacher", "devices.read")).toBe(true);
    expect(allows("teacher", "rollcall.read")).toBe(true);
    expect(allows("teacher", "rollcall.write")).toBe(true);
    expect(allows("teacher", "timetable.apply")).toBe(true);
    expect(allows("teacher", "binding.write")).toBe(true);
    expect(allows("teacher", "devices.write")).toBe(false);
    expect(allows("teacher", "configurations.write")).toBe(false);
    expect(allows("teacher", "users.read")).toBe(false);
    expect(allows("teacher", "audit.read")).toBe(false);
    expect(allows("teacher", "system.write")).toBe(false);
  });

  it("grants binding management to admin and operator but timetable apply only to admin", () => {
    expect(allows("admin", "binding.write")).toBe(true);
    expect(allows("admin", "timetable.apply")).toBe(true);
    expect(allows("operator", "binding.write")).toBe(true);
    expect(allows("operator", "timetable.apply")).toBe(false);
    expect(allows("viewer", "binding.write")).toBe(false);
  });

  it("denies every permission to an unknown role", () => {
    for (const permission of ["devices.read", "tasks.write", "audit.read", "*"])
      expect(allows("ghost", permission)).toBe(false);
  });

  it("responds with 403 when a role lacks the permission", () => {
    try {
      requirePermission({ role: "viewer" }, "devices.write");
      throw new Error("expected denial");
    } catch (error) {
      expect((error as HttpError).statusCode).toBe(403);
    }
  });
});