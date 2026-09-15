import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { nowIso } from "./database";
import { appendAuditWithin } from "./security";
import { assertDeviceInScope, assertOrgNodeInScope, type ScopeUser } from "./scope";

export type RollCallScopeType = "school" | "organization" | "device";

export type RollCallRoster = {
  id: string;
  name: string;
  scopeType: RollCallScopeType;
  scopeId: string | null;
  names: string[];
  revision: number;
  updatedAt: string;
};

type RosterRow = {
  id: string;
  name: string;
  scopeType: RollCallScopeType;
  scopeId: string | null;
  names: string;
  revision: number;
  updatedAt: string;
};

/** 名单正文以 JSON 数组存储；解析失败按空名单处理，脏数据不能打挂每一次轮询。 */
function parseNames(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

/** 覆盖式写入前去掉空行与重复姓名，保证同一份名单的下发内容稳定。 */
export function normalizeRollCallNames(names: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of names) {
    const name = raw.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    result.push(name);
  }
  return result;
}

function mapRoster(row: RosterRow): RollCallRoster {
  return { ...row, names: parseNames(row.names) };
}

function findRoster(db: Database.Database, scopeType: RollCallScopeType, scopeId: string | null) {
  const row = (scopeId === null
    ? db.prepare("SELECT id,name,scope_type scopeType,scope_id scopeId,names,revision,updated_at updatedAt FROM rollcall_rosters WHERE scope_type=? AND scope_id IS NULL")
      .get(scopeType)
    : db.prepare("SELECT id,name,scope_type scopeType,scope_id scopeId,names,revision,updated_at updatedAt FROM rollcall_rosters WHERE scope_type=? AND scope_id=?")
      .get(scopeType, scopeId)) as RosterRow | undefined;
  return row ? mapRoster(row) : null;
}

export function listRollCallRosters(db: Database.Database): RollCallRoster[] {
  const rows = db.prepare(`SELECT id,name,scope_type scopeType,scope_id scopeId,names,revision,updated_at updatedAt
    FROM rollcall_rosters ORDER BY scope_type, name`).all() as RosterRow[];
  return rows.map(mapRoster);
}

/**
 * 全局单调修订号：任何一次名单写入或删除都会 +1，
 * 因此设备只要比较修订是否相等，就能判断自己手上的名单是否过期。
 */
function allocateRevision(db: Database.Database): number {
  const row = db.prepare("SELECT value FROM system_state WHERE key=?").get("rollcall.revision") as { value: string } | undefined;
  const next = (Number.parseInt(row?.value ?? "0", 10) || 0) + 1;
  db.prepare(`INSERT INTO system_state (key,value,updated_at) VALUES (?,?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
    .run("rollcall.revision", String(next), nowIso());
  return next;
}

/** 作用域目标必须真实存在且落在写入者的可见范围内。 */
function assertScopeTarget(db: Database.Database, user: ScopeUser, scopeType: RollCallScopeType, scopeId: string | null) {
  if (scopeType === "school") return;
  if (!scopeId) throw createError({ statusCode: 400, message: "该作用域必须指定目标。" });
  if (scopeType === "organization") {
    if (!db.prepare("SELECT 1 FROM org_nodes WHERE id=?").get(scopeId))
      throw createError({ statusCode: 404, message: "目标组织不存在。" });
    assertOrgNodeInScope(db, user, scopeId);
    return;
  }
  if (!db.prepare("SELECT 1 FROM devices WHERE id=? AND disabled_at IS NULL").get(scopeId))
    throw createError({ statusCode: 404, message: "目标设备不存在。" });
  assertDeviceInScope(db, user, scopeId);
}

/** 每个作用域最多一份名单：同一目标再次保存即为覆盖。 */
export function upsertRollCallRoster(
  db: Database.Database,
  user: ScopeUser,
  input: { name: string; scopeType: RollCallScopeType; scopeId: string | null; names: string[] },
): RollCallRoster {
  const scopeId = input.scopeType === "school" ? null : input.scopeId;
  const names = normalizeRollCallNames(input.names);
  return db.transaction(() => {
    assertScopeTarget(db, user, input.scopeType, scopeId);
    const existing = findRoster(db, input.scopeType, scopeId);
    const id = existing?.id ?? randomUUID();
    const revision = allocateRevision(db);
    const timestamp = nowIso();
    db.prepare(`INSERT INTO rollcall_rosters (id,name,scope_type,scope_id,names,revision,updated_at)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,scope_type=excluded.scope_type,scope_id=excluded.scope_id,names=excluded.names,revision=excluded.revision,updated_at=excluded.updated_at`)
      .run(id, input.name, input.scopeType, scopeId, JSON.stringify(names), revision, timestamp);
    appendAuditWithin(db, {
      actorType: "user", actorId: user.id, action: "rollcall.roster.save", targetType: "rollcall_roster", targetId: id,
      summary: `点名名单「${input.name}」已保存（${names.length} 人）`,
      details: { scopeType: input.scopeType, scopeId, revision, count: names.length },
    });
    return { id, name: input.name, scopeType: input.scopeType, scopeId, names, revision, updatedAt: timestamp };
  }).immediate();
}

export function deleteRollCallRoster(db: Database.Database, user: ScopeUser, id: string): boolean {
  return db.transaction(() => {
    const existing = db.prepare("SELECT id,name,scope_type scopeType,scope_id scopeId,names,revision,updated_at updatedAt FROM rollcall_rosters WHERE id=?")
      .get(id) as RosterRow | undefined;
    if (!existing) return false;
    // 删除同样推进修订号：设备下次轮询会发现解析结果变了，从而清空本地名单。
    allocateRevision(db);
    db.prepare("DELETE FROM rollcall_rosters WHERE id=?").run(id);
    appendAuditWithin(db, {
      actorType: "user", actorId: user.id, action: "rollcall.roster.delete", targetType: "rollcall_roster", targetId: id,
      summary: `点名名单「${existing.name}」已删除`,
      details: { scopeType: existing.scopeType, scopeId: existing.scopeId },
    });
    return true;
  }).immediate();
}

/**
 * 设备实际生效的名单：设备级 > 最近的祖先组织级 > 全校级。
 * 都没命中时返回空名单，设备据此清空本地缓存。
 */
export function resolveRollCallForDevice(db: Database.Database, deviceId: string): { revision: number; names: string[] } {
  const device = db.prepare("SELECT org_node_id orgNodeId FROM devices WHERE id=?").get(deviceId) as { orgNodeId: string | null } | undefined;
  if (!device) return { revision: 0, names: [] };
  const direct = findRoster(db, "device", deviceId);
  if (direct) return { revision: direct.revision, names: direct.names };
  // seen 防御组织树意外成环，避免轮询死循环。
  const seen = new Set<string>();
  let nodeId = device.orgNodeId;
  while (nodeId && !seen.has(nodeId)) {
    seen.add(nodeId);
    const roster = findRoster(db, "organization", nodeId);
    if (roster) return { revision: roster.revision, names: roster.names };
    nodeId = (db.prepare("SELECT parent_id parentId FROM org_nodes WHERE id=?").get(nodeId) as { parentId: string | null } | undefined)?.parentId ?? null;
  }
  const school = findRoster(db, "school", null);
  return school ? { revision: school.revision, names: school.names } : { revision: 0, names: [] };
}