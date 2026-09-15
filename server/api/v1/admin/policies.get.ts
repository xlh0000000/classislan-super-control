export default defineEventHandler((event) => {
  const user = event.context.user as { id: string; role: string; scopeOrgNodeId?: string | null };
  requirePermission(user, "policies.read");
  assertSchoolWideScope(user, "策略");
  return useDatabase().prepare(`SELECT pr.id, pr.revision, pr.name, pr.document_hash documentHash, pr.base_revision baseRevision, pr.mode mode,
      pr.created_at createdAt,
      pa.id assignmentId, pa.scope_type scopeType, pa.scope_id scopeId, pa.priority, pa.locks
    FROM policy_revisions pr
    LEFT JOIN policy_assignments pa ON pa.policy_revision_id = pr.id AND pa.superseded_at IS NULL
    ORDER BY pr.revision DESC`).all();
});