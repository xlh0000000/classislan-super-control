import { isTeacher } from "../../../utils/scope";

export default defineEventHandler((event) => {
  const user = event.context.user as { id: string; role: string; scopeOrgNodeId?: string | null };
  const db = useDatabase();
  // 教师进不了配置库，但要能挑一份课表配置套到自己绑定的设备上，所以只放开 profile 一类的只读列表。
  if (isTeacher(user)) requirePermission(user, "timetable.apply");
  else {
    requirePermission(user, "configurations.read");
    assertSchoolWideScope(user, "配置库");
  }
  const rows = db.prepare(`SELECT c.id configurationId,c.kind,c.name,c.updated_at updatedAt,
    cr.revision currentRevision, cr.document_hash currentHash, cr.created_at revisionCreatedAt
    FROM configurations c LEFT JOIN configuration_revisions cr ON cr.id=c.current_revision_id
    ${isTeacher(user) ? "WHERE c.kind='profile'" : ""}
    ORDER BY c.updated_at DESC`).all() as {
      configurationId: string; kind: string; name: string; updatedAt: string;
      currentRevision: number | null; currentHash: string | null; revisionCreatedAt: string | null;
    }[];
  return rows.map((row) => ({
    ...row,
    revisionCount: (db.prepare("SELECT COUNT(*) count FROM configuration_revisions WHERE configuration_id=?").get(row.configurationId) as { count: number }).count,
  }));
});
