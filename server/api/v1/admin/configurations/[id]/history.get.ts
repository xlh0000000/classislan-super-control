export default defineEventHandler((event) => {
  const user = event.context.user as { id: string; role: string; scopeOrgNodeId?: string | null };
  requirePermission(user, "configurations.read");
  assertSchoolWideScope(user, "配置库");
  const id = getRouterParam(event, "id")!;
  const db = useDatabase();
  const config = db.prepare("SELECT 1 FROM configurations WHERE id=?").get(id);
  if (!config) throw createError({ statusCode: 404, message: "配置不存在。" });
  return db.prepare(`SELECT id,revision,name,document documentJson,document_hash documentHash,created_by createdBy,created_at createdAt
    FROM configuration_revisions WHERE configuration_id=? ORDER BY revision DESC LIMIT 100`).all(id);
});