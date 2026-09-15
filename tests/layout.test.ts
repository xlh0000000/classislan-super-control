import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../server/migrations";

type HttpError = Error & { statusCode?: number };
(globalThis as unknown as { createError: (opts: { statusCode: number; message: string }) => HttpError }).createError =
  (opts) => Object.assign(new Error(opts.message), { statusCode: opts.statusCode });

import { buildingCreateSchema, floorCreateSchema, roomCreateSchema, roomDevicesSchema } from "../shared/schemas";
import { assignRoomDevices, layoutTree, roomDeviceIds } from "../server/utils/layout";
import { policyLayersForDeviceFromDb, publishPolicy } from "../server/utils/policy";

const NOW = "2026-09-11T00:00:00.000Z";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const owner = { id: "user-owner", role: "owner" };

function createDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  db.prepare("INSERT INTO users (id,username,password_hash,display_name,role,scope_org_node_id,created_at) VALUES (?,?,?,?,?,?,?)")
    .run(owner.id, "owner", "hash", "所有者", "owner", null, NOW);
  return db;
}
function seedOrg(db: Database.Database, id: string, parentId: string | null, path: string) {
  db.prepare("INSERT INTO org_nodes (id,parent_id,name,path,sort_order,created_at) VALUES (?,?,?,?,0,?)")
    .run(id, parentId, `org-${id}`, path, NOW);
}
function seedDevice(db: Database.Database, id: string, orgNodeId: string | null) {
  db.prepare("INSERT INTO devices (id,name,org_node_id,public_key_jwk,key_thumbprint,created_at) VALUES (?,?,?,?,?,?)")
    .run(id, `dev-${id}`, orgNodeId, "{}", `thumb-${id}`, NOW);
}
function seedBuilding(db: Database.Database, id: string, name = `楼-${id}`) {
  db.prepare("INSERT INTO buildings (id,name,sort_order,created_at) VALUES (?,?,0,?)").run(id, name, NOW);
}
function seedFloor(db: Database.Database, id: string, buildingId: string, name = `层-${id}`, level = 1) {
  db.prepare("INSERT INTO building_floors (id,building_id,name,level,sort_order,created_at) VALUES (?,?,?,?,0,?)")
    .run(id, buildingId, name, level, NOW);
}
function seedRoom(db: Database.Database, id: string, floorId: string, name = `室-${id}`) {
  db.prepare("INSERT INTO building_rooms (id,floor_id,name,sort_order,created_at) VALUES (?,?,?,0,?)").run(id, floorId, name, NOW);
}
function countAssignments(db: Database.Database) {
  return (db.prepare("SELECT COUNT(*) count FROM room_devices").get() as { count: number }).count;
}

describe("building layout schemas", () => {
  it("requires a non-empty trimmed name", () => {
    expect(buildingCreateSchema.safeParse({ name: "  教学楼  " }).success).toBe(true);
    expect(buildingCreateSchema.safeParse({ name: "  " }).success).toBe(false);
    expect(buildingCreateSchema.safeParse({ name: "x".repeat(61) }).success).toBe(false);
  });

  it("requires uuid parents for floors and rooms", () => {
    expect(floorCreateSchema.safeParse({ buildingId: "not-a-uuid", name: "一层" }).success).toBe(false);
    expect(floorCreateSchema.safeParse({ buildingId: uuid(1), name: "一层", level: 1 }).success).toBe(true);
    expect(roomCreateSchema.safeParse({ floorId: uuid(2), name: "101" }).success).toBe(true);
    expect(roomCreateSchema.safeParse({ floorId: uuid(2) }).success).toBe(false);
  });

  it("rejects a device that is both added and removed", () => {
    expect(roomDevicesSchema.safeParse({}).success).toBe(true);
    expect(roomDevicesSchema.safeParse({ add: [uuid(3)], remove: [uuid(3)] }).success).toBe(false);
    expect(roomDevicesSchema.safeParse({ add: [uuid(3)], remove: [uuid(4)] }).success).toBe(true);
  });
});

describe("layout tree", () => {
  it("keeps the building hierarchy and hides out-of-scope devices", () => {
    const db = createDb();
    seedOrg(db, "a", null, "/a");
    seedOrg(db, "c", null, "/c");
    seedDevice(db, "dA", "a");
    seedDevice(db, "dC", "c");
    seedBuilding(db, "b1", "教学楼");
    seedFloor(db, "f1", "b1", "四层", 4);
    seedRoom(db, "r1", "f1", "101");
    assignRoomDevices(db, "r1", ["dA", "dC"], []);

    const all = layoutTree(db, owner);
    expect(all.buildings.map((row) => row.name)).toEqual(["教学楼"]);
    expect(all.floors.map((row) => row.name)).toEqual(["四层"]);
    expect(all.rooms).toHaveLength(1);
    expect([...all.rooms[0]!.deviceIds].sort()).toEqual(["dA", "dC"]);

    const scoped = layoutTree(db, { id: "user-scoped", role: "admin", scopeOrgNodeId: "a" });
    expect(scoped.rooms[0]!.deviceIds).toEqual(["dA"]);
  });

  it("moves a device to the room it was assigned to last", () => {
    const db = createDb();
    seedDevice(db, "d1", null);
    seedBuilding(db, "b1");
    seedFloor(db, "f1", "b1");
    seedRoom(db, "r1", "f1");
    seedRoom(db, "r2", "f1");
    assignRoomDevices(db, "r1", ["d1"], []);
    assignRoomDevices(db, "r2", ["d1"], []);
    expect(roomDeviceIds(db, "r1")).toEqual([]);
    expect(roomDeviceIds(db, "r2")).toEqual(["d1"]);
    assignRoomDevices(db, "r1", [], ["d1"]);
    expect(roomDeviceIds(db, "r2")).toEqual(["d1"]);
    assignRoomDevices(db, "r2", [], ["d1"]);
    expect(countAssignments(db)).toBe(0);
  });

  it("cascades assignments when a room or device is deleted", () => {
    const db = createDb();
    seedDevice(db, "d1", null);
    seedDevice(db, "d2", null);
    seedBuilding(db, "b1");
    seedFloor(db, "f1", "b1");
    seedRoom(db, "r1", "f1");
    seedRoom(db, "r2", "f1");
    assignRoomDevices(db, "r1", ["d1"], []);
    assignRoomDevices(db, "r2", ["d2"], []);
    db.prepare("DELETE FROM building_rooms WHERE id=?").run("r1");
    expect(roomDeviceIds(db, "r1")).toEqual([]);
    db.prepare("DELETE FROM devices WHERE id=?").run("d2");
    expect(countAssignments(db)).toBe(0);
    db.prepare("DELETE FROM buildings WHERE id=?").run("b1");
    expect((db.prepare("SELECT COUNT(*) count FROM building_floors").get() as { count: number }).count).toBe(0);
  });
});

describe("device policy layers", () => {
  it("lists applicable layers in merge order with their names", () => {
    const db = createDb();
    seedOrg(db, "o1", null, "/o1");
    seedDevice(db, "dev1", "o1");
    publishPolicy(db, { name: "学校基线", document: { profile: { name: "school" } }, scopeType: "school", scopeId: null, priority: 0, locks: [] }, owner, NOW);
    publishPolicy(db, { name: "机房策略", document: { profile: { name: "device" } }, scopeType: "device", scopeId: "dev1", priority: 0, locks: [] }, owner, NOW);

    const layers = policyLayersForDeviceFromDb(db, "dev1");
    expect(layers.map((layer) => layer.name)).toEqual(["学校基线", "机房策略"]);
    expect(layers.map((layer) => layer.revision)).toEqual([1, 2]);
    expect(layers.map((layer) => layer.scopeType)).toEqual(["school", "device"]);
    expect(layers[1]!.document).toEqual({ profile: { name: "device" } });
    expect(policyLayersForDeviceFromDb(db, "missing")).toEqual([]);
  });
});