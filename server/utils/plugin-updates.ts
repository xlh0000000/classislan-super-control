import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { PLUGIN_RELEASE_VERSION_PATTERN } from "../../shared/schemas";
import { nowIso } from "./database";
import { assertDeviceInScope, assertOrgNodeInScope, hasSchoolWideScope, type ScopeUser } from "./scope";

export type PluginUpdateScopeType = "school" | "organization" | "tag" | "device";
export type PluginUpdateTargetRow = { id: string; scopeType: PluginUpdateScopeType; scopeId: string | null; version: string; updatedAt: string };
/** 设备此刻该升到哪、为什么是这一版：来源作用域要一起回给界面，否则「这台为什么是 0.1.8」没法解释。 */
export type ResolvedPluginUpdateTarget = { version: string; scopeType: PluginUpdateScopeType; scopeId: string | null; source: "target" | "latest" };

/** 四段数字版本按段比大小；非四段的脏数据一律排最低，免得把设备指向解析不了的版本。 */
export function comparePluginVersions(a: string, b: string): number {
  const digits = (value: string) => (PLUGIN_RELEASE_VERSION_PATTERN.test(value) ? value.split(".").map(Number) : null);
  const leftDigits = digits(a);
  const rightDigits = digits(b);
  for (let i = 0; i < 4; i += 1) {
    const left = leftDigits?.[i];
    const right = rightDigits?.[i];
    // 任一侧不是四段数字就当作更旧：宁可让设备停在自己的版本上，也不把一个读不懂的版本推给它。
    if (left === right) continue;
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    return left - right;
  }
  return 0;
}

/** 与策略层同一套作用域门槛：标签和全校只对全校账号开放，组织/设备按各自可见范围。 */
export function assertPluginTargetScope(db: Database.Database, user: ScopeUser, scopeType: PluginUpdateScopeType, scopeId: string | null) {
  if (scopeType === "school" || scopeType === "tag") {
    if (!hasSchoolWideScope(user)) throw createError({ statusCode: 403, message: "全校级插件升级目标需要全校范围的账号。" });
    return;
  }
  if (scopeType === "organization") assertOrgNodeInScope(db, user, scopeId);
  else assertDeviceInScope(db, user, scopeId!);
}

export function pluginUpdateTargets(db: Database.Database): PluginUpdateTargetRow[] {
  const rows = db.prepare("SELECT id,scope_type scopeType,scope_id scopeId,version,updated_at updatedAt FROM plugin_update_targets").all() as {
    id: string; scopeType: PluginUpdateScopeType; scopeId: string | null; version: string; updatedAt: string;
  }[];
  return rows;
}

/**
 * 设备生效目标：device > tag > 最近的组织祖先 > school > 最新发布版。
 * 排序与 policyLayersForDeviceFromDb 一致。同一层出现多条（例如设备挂了两个标签，各设了不同版本）
 * 时取最近写入的那条，因为管理员后改的才是他想要的。
 * 谁都没单独表态时跟着「当前版本」走——上传即全校升级，这正是静默自升级要的默认。
 */
export function resolvePluginUpdateTarget(db: Database.Database, deviceId: string): ResolvedPluginUpdateTarget | null {
  const device = db.prepare("SELECT org_node_id orgNodeId FROM devices WHERE id=?").get(deviceId) as { orgNodeId: string | null } | undefined;
  if (!device) return null;
  const tagIds = new Set((db.prepare("SELECT tag_id tagId FROM device_tags WHERE device_id=?").all(deviceId) as { tagId: string }[]).map((row) => row.tagId));
  const orgIds: string[] = [];
  let orgId = device.orgNodeId;
  while (orgId) {
    const row = db.prepare("SELECT id,parent_id parentId FROM org_nodes WHERE id=?").get(orgId) as { id: string; parentId: string | null } | undefined;
    if (!row) break;
    orgIds.unshift(row.id);
    orgId = row.parentId;
  }
  const rank: Record<PluginUpdateScopeType, number> = { school: 0, organization: 1, tag: 2, device: 3 };
  let best: { row: PluginUpdateTargetRow; strength: number } | null = null;
  for (const row of pluginUpdateTargets(db)) {
    if (row.scopeType === "school") continue;
    let depth = -1;
    switch (row.scopeType) {
      case "device": if (row.scopeId !== deviceId) continue; depth = 0; break;
      case "tag": if (row.scopeId === null || !tagIds.has(row.scopeId)) continue; depth = 0; break;
      case "organization": {
        if (row.scopeId === null) continue;
        const index = orgIds.indexOf(row.scopeId);
        if (index < 0) continue;
        // 组织越深越大：祖先设了默认值、子树改了口径时，以子树为准。
        depth = index + 1;
        break;
      }
    }
    const strength = rank[row.scopeType] * 1000 + depth;
    if (best && (strength < best.strength || (strength === best.strength && row.updatedAt <= best.row.updatedAt))) continue;
    best = { row, strength };
  }
  if (best) return { version: best.row.version, scopeType: best.row.scopeType, scopeId: best.row.scopeId, source: "target" };
  const school = db.prepare("SELECT version,scope_id scopeId FROM plugin_update_targets WHERE scope_type='school'").get() as { version: string; scopeId: string | null } | undefined;
  if (school) return { version: school.version, scopeType: "school", scopeId: null, source: "target" };
  const latest = db.prepare("SELECT version FROM plugin_releases WHERE is_current=1").get() as { version: string } | undefined;
  return latest ? { version: latest.version, scopeType: "school", scopeId: null, source: "latest" } : null;
}

export function upsertPluginUpdateTarget(db: Database.Database, input: { scopeType: PluginUpdateScopeType; scopeId: string | null; version: string }, actorId: string, now = nowIso()): PluginUpdateTargetRow {
  const existing = db.prepare("SELECT id FROM plugin_update_targets WHERE scope_type=? AND COALESCE(scope_id,'')=?")
    .get(input.scopeType, input.scopeId ?? "") as { id: string } | undefined;
  const id = existing?.id ?? randomUUID();
  if (existing) {
    db.prepare("UPDATE plugin_update_targets SET version=?,updated_at=?,updated_by=? WHERE id=?")
      .run(input.version, now, actorId, id);
  } else {
    db.prepare("INSERT INTO plugin_update_targets (id,scope_type,scope_id,version,updated_at,updated_by) VALUES (?,?,?,?,?,?)")
      .run(id, input.scopeType, input.scopeId, input.version, now, actorId);
  }
  return { id, scopeType: input.scopeType, scopeId: input.scopeId, version: input.version, updatedAt: now };
}

export function deletePluginUpdateTarget(db: Database.Database, scopeType: PluginUpdateScopeType, scopeId: string | null) {
  const result = db.prepare("DELETE FROM plugin_update_targets WHERE scope_type=? AND COALESCE(scope_id,'')=?").run(scopeType, scopeId ?? "");
  return result.changes > 0;
}

/** 记下设备的升级回报；回报的当前版本与插件在轮询里报的 plugin_version 同源，不另立事实。 */
export function recordPluginUpdateReport(db: Database.Database, deviceId: string, state: string, version: string) {
  db.prepare("UPDATE devices SET plugin_update_state=?,plugin_update_version=? WHERE id=?").run(state, version, deviceId);
}

/** 设备注销/移组织时清掉挂在它名下的目标，否则那行会一直无人认领（scope_id 是多态列，外键管不到）。 */
export function deleteDevicePluginUpdateTargets(db: Database.Database, deviceId: string) {
  db.prepare("DELETE FROM plugin_update_targets WHERE scope_type='device' AND COALESCE(scope_id,'')=?").run(deviceId);
}
