import { isTeacher } from "../../../../../utils/scope";

export default defineEventHandler((event) => {
  const user = event.context.user as { id: string; role: string; scopeOrgNodeId?: string | null };
  const db = useDatabase();
  const id = getRouterParam(event, "id")!;
  // 教师可查看课表配置本体以便确认要套用哪一份；其余类型仍属配置库权限。
  if (isTeacher(user)) {
    requirePermission(user, "timetable.apply");
    // 非课表类型按不存在处理：既不泄露可见性，也让下文的 404 统一收口不存在的 id。
    const kind = db.prepare("SELECT kind kind FROM configurations WHERE id=?").get(id) as { kind: string } | undefined;
    if (kind && kind.kind !== "profile") throw createError({ statusCode: 404, message: "配置不存在。" });
  } else {
    requirePermission(user, "configurations.read");
    assertSchoolWideScope(user, "配置库");
  }
  const config = db.prepare(`SELECT c.id configurationId,c.kind,c.name,c.updated_at updatedAt,
    cr.revision currentRevision, cr.document_hash currentHash, cr.created_at revisionCreatedAt
    FROM configurations c LEFT JOIN configuration_revisions cr ON cr.id=c.current_revision_id
    WHERE c.id=?`).get(id) as Record<string, unknown> | undefined;
  if (!config) throw createError({ statusCode: 404, message: "配置不存在。" });
  return config;
});
