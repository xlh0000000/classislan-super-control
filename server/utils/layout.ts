import type Database from "better-sqlite3";
import { nowIso } from "./database";
import { deviceScopeFilter, type ScopeUser } from "./scope";

export type BuildingRow = { id: string; name: string; sortOrder: number };
export type FloorRow = { id: string; buildingId: string; name: string; level: number; sortOrder: number };
export type RoomRow = { id: string; floorId: string; name: string; sortOrder: number; deviceIds: string[] };
export type LayoutTree = { buildings: BuildingRow[]; floors: FloorRow[]; rooms: RoomRow[] };

/** 当前账号可见的设备 id；用于把越权设备的教室分配从视图里剔除。 */
function visibleDeviceIds(db: Database.Database, user: ScopeUser): Set<string> {
  const scope = deviceScopeFilter(db, user);
  const rows = db.prepare(`SELECT d.id FROM devices d WHERE ${scope.sql}`).all(...scope.params) as { id: string }[];
  return new Set(rows.map((row) => row.id));
}

/** 读取整棵楼栋树；教室内的设备只保留当前账号可见的部分。 */
export function layoutTree(db: Database.Database, user: ScopeUser): LayoutTree {
  const visible = visibleDeviceIds(db, user);
  const buildings = db.prepare("SELECT id,name,sort_order sortOrder FROM buildings ORDER BY sort_order,name").all() as BuildingRow[];
  const floors = db.prepare("SELECT id,building_id buildingId,name,level,sort_order sortOrder FROM building_floors ORDER BY level DESC,sort_order,name").all() as FloorRow[];
  const rooms = db.prepare("SELECT id,floor_id floorId,name,sort_order sortOrder FROM building_rooms ORDER BY sort_order,name").all() as Omit<RoomRow, "deviceIds">[];
  const assignments = db.prepare("SELECT room_id roomId,device_id deviceId FROM room_devices").all() as { roomId: string; deviceId: string }[];
  const byRoom = new Map<string, string[]>();
  for (const row of assignments) {
    if (!visible.has(row.deviceId)) continue;
    const list = byRoom.get(row.roomId);
    if (list) list.push(row.deviceId);
    else byRoom.set(row.roomId, [row.deviceId]);
  }
  return {
    buildings,
    floors,
    rooms: rooms.map((room) => ({ ...room, deviceIds: byRoom.get(room.id) ?? [] })),
  };
}

/**
 * 分配设备到教室：add 为覆盖式写入（device_id 主键保证一机一室，设备从原教室移出），
 * remove 只影响本教室的既有分配。
 */
export function assignRoomDevices(db: Database.Database, roomId: string, add: string[], remove: string[]) {
  const createdAt = nowIso();
  const removeStmt = db.prepare("DELETE FROM room_devices WHERE room_id=? AND device_id=?");
  for (const deviceId of remove) removeStmt.run(roomId, deviceId);
  const upsert = db.prepare(`INSERT INTO room_devices (device_id,room_id,created_at) VALUES (?,?,?)
    ON CONFLICT(device_id) DO UPDATE SET room_id=excluded.room_id, created_at=excluded.created_at`);
  for (const deviceId of add) upsert.run(deviceId, roomId, createdAt);
}

/** 教室当前设备 id 列表，用于审计摘要与变更提示。 */
export function roomDeviceIds(db: Database.Database, roomId: string): string[] {
  return (db.prepare("SELECT device_id deviceId FROM room_devices WHERE room_id=? ORDER BY device_id").all(roomId) as { deviceId: string }[])
    .map((row) => row.deviceId);
}