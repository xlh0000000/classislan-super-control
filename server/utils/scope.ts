import type Database from "better-sqlite3";

export type ScopeUser = { id: string; role: string; scopeOrgNodeId?: string | null };

/** 所有者始终拥有全校范围；其余用户按 scope_org_node_id 限定在组织子树内。 */
export function effectiveScopeOrgNodeId(user: ScopeUser): string | null {
  return user.role === "owner" ? null : (user.scopeOrgNodeId ?? null);
}

/** 返回用户在组织树中可见的节点 id；null 表示全校（不过滤），空数组表示无任何可见节点。 */
export function visibleOrgNodeIds(db: Database.Database, user: ScopeUser): string[] | null {
  const rootId = effectiveScopeOrgNodeId(user);
  if (!rootId) return null;
  const node = db.prepare("SELECT path FROM org_nodes WHERE id=?").get(rootId) as { path: string } | undefined;
  if (!node) return [];
  const prefix = node.path === "/" ? "/%" : `${node.path}/%`;
  return (db.prepare("SELECT id FROM org_nodes WHERE path=? OR path LIKE ?").all(node.path, prefix) as { id: string }[])
    .map((row) => row.id);
}

export function hasSchoolWideScope(user: ScopeUser): boolean {
  return effectiveScopeOrgNodeId(user) === null;
}

/** 设备查询范围：返回可拼接的 SQL 片段与参数；别名固定为 d。 */
export function deviceScopeFilter(db: Database.Database, user: ScopeUser, alias = "d"): { sql: string; params: string[] } {
  const ids = visibleOrgNodeIds(db, user);
  if (ids === null) return { sql: "1=1", params: [] };
  if (ids.length === 0) return { sql: "0=1", params: [] };
  return { sql: `${alias}.org_node_id IN (${ids.map(() => "?").join(",")})`, params: ids };
}

/** 写入前校验设备位于用户可见范围内；越权与不存在都返回 404，避免泄露资源存在性。 */
export function assertDeviceInScope(db: Database.Database, user: ScopeUser, deviceId: string) {
  const ids = visibleOrgNodeIds(db, user);
  if (ids === null) return;
  const row = db.prepare("SELECT org_node_id orgNodeId FROM devices WHERE id=?").get(deviceId) as { orgNodeId: string | null } | undefined;
  if (!row || !row.orgNodeId || !ids.includes(row.orgNodeId))
    throw createError({ statusCode: 404, message: "设备不存在。" });
}

/** 目标组织节点必须落在用户可写范围内，否则拒绝（越权按不存在处理）。 */
export function assertOrgNodeInScope(db: Database.Database, user: ScopeUser, orgNodeId: string | null) {
  const ids = visibleOrgNodeIds(db, user);
  if (ids === null) return;
  if (!orgNodeId || !ids.includes(orgNodeId))
    throw createError({ statusCode: 404, message: "目标组织不存在。" });
}

/** 全校级资源（策略、配置库、系统与备份、批量接入）只对全校范围账号开放。 */
export function assertSchoolWideScope(user: ScopeUser, resource: string) {
  if (!hasSchoolWideScope(user))
    throw createError({ statusCode: 403, message: `当前账号的组织范围不足以访问${resource}。` });
}