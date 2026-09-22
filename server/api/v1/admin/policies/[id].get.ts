/**
 * 单条策略修订的详情：修订本身、当前挂在哪个作用域上、锁与文档本体，
 * 并把顶层的 { "$config": 配置ID } 引用翻译成配置名——列表里只有哈希，
 * 管理员要确认的恰恰是「这一节引用了哪份配置」。
 */
export default defineEventHandler((event) => {
  const user = event.context.user as { id: string; role: string; scopeOrgNodeId?: string | null };
  requirePermission(user, "policies.read");
  assertSchoolWideScope(user, "策略");
  const db = useDatabase();
  const id = getRouterParam(event, "id")!;
  const revision = db.prepare(`SELECT pr.id,pr.revision,pr.name,pr.mode,pr.document,pr.document_hash documentHash,
      pr.base_revision baseRevision,pr.created_at createdAt,pr.created_by createdBy,pr.locks,
      u.display_name createdByName
    FROM policy_revisions pr LEFT JOIN users u ON u.id=pr.created_by WHERE pr.id=?`).get(id) as {
      id: string; revision: number; name: string; mode: "replace" | "append"; document: string; documentHash: string;
      baseRevision: number | null; createdAt: string; createdBy: string | null; locks: string | null; createdByName: string | null;
    } | undefined;
  if (!revision) throw createError({ statusCode: 404, message: "策略修订不存在。" });
  const assignment = db.prepare(`SELECT id,scope_type scopeType,scope_id scopeId,priority,locks,created_at createdAt
    FROM policy_assignments WHERE policy_revision_id=? AND superseded_at IS NULL LIMIT 1`).get(id) as
    { id: string; scopeType: string; scopeId: string | null; priority: number; locks: string; createdAt: string } | undefined;

  const document = JSON.parse(revision.document) as Record<string, unknown>;
  // 引用只取顶层节：节内再套 $config 属于配置文档自己的事，由下发时展开。
  const references = Object.entries(document).flatMap(([section, value]) => {
    const node = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    if (typeof node.$config !== "string") return [];
    const configurationId = node.$config;
    const config = db.prepare(`SELECT c.name,c.kind,cr.revision FROM configurations c
      JOIN configuration_revisions cr ON cr.id=c.current_revision_id WHERE c.id=?`).get(configurationId) as
      { name: string; kind: string; revision: number } | undefined;
    // 配置被删或还没有修订时照样列出来，管理员才看得到这条引用已经指空了。
    return [{ section, configurationId, name: config?.name ?? null, kind: config?.kind ?? null, revision: config?.revision ?? null }];
  });

  const { document: _serialized, locks: _rawLocks, ...meta } = revision;
  return {
    ...meta,
    document,
    references,
    // 修订自带的锁才是「这一版当时锁了什么」；assignment 上的那份属于当前生效版本，旧修订没有。
    locks: JSON.parse(revision.locks ?? assignment?.locks ?? "[]") as string[],
    scope: assignment ? {
      assignmentId: assignment.id,
      scopeType: assignment.scopeType,
      scopeId: assignment.scopeId,
      scopeName: scopeName(db, assignment.scopeType, assignment.scopeId),
      priority: assignment.priority,
      createdAt: assignment.createdAt,
    } : null,
  };
});

/** 作用域对象名：组织/标签/设备各查各的表，对象已删除时直说。 */
function scopeName(db: ReturnType<typeof useDatabase>, scopeType: string, scopeId: string | null): string {
  if (scopeType === "school") return "全校";
  const table = scopeType === "organization" ? "org_nodes" : scopeType === "tag" ? "tags" : "devices";
  const row = scopeId ? db.prepare(`SELECT name FROM ${table} WHERE id=?`).get(scopeId) as { name: string } | undefined : undefined;
  return row?.name ?? "已删除的对象";
}
