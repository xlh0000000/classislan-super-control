export default defineEventHandler((event) => {
  const user = event.context.user as { id: string; role: string; scopeOrgNodeId?: string | null };
  requirePermission(user, "users.read");
  assertSchoolWideScope(user, "用户管理");
  return useDatabase().prepare(`SELECT id,username,display_name displayName,role,scope_org_node_id scopeOrgNodeId,created_at createdAt,disabled_at disabledAt,must_change_password mustChangePassword
    FROM users ORDER BY created_at`).all();
});