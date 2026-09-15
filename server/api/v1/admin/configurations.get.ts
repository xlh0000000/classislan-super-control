export default defineEventHandler((event) => {
  const user = event.context.user as { id: string; role: string; scopeOrgNodeId?: string | null };
  requirePermission(user, "configurations.read");
  assertSchoolWideScope(user, "配置库");
  const db = useDatabase();
  const rows = db.prepare(`SELECT c.id configurationId,c.kind,c.name,c.updated_at updatedAt,
    cr.revision currentRevision, cr.document_hash currentHash, cr.created_at revisionCreatedAt
    FROM configurations c LEFT JOIN configuration_revisions cr ON cr.id=c.current_revision_id
    ORDER BY c.updated_at DESC`).all() as {
      configurationId: string; kind: string; name: string; updatedAt: string;
      currentRevision: number | null; currentHash: string | null; revisionCreatedAt: string | null;
    }[];
  return rows.map((row) => ({
    ...row,
    revisionCount: (db.prepare("SELECT COUNT(*) count FROM configuration_revisions WHERE configuration_id=?").get(row.configurationId) as { count: number }).count,
  }));
});