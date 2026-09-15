import { visibleOrgNodeIds } from "../../../utils/scope";

export default defineEventHandler((event) => {
  const user = event.context.user as { id: string; role: string; scopeOrgNodeId?: string | null };
  requirePermission(user, "organization.read");
  const db = useDatabase();
  const ids = visibleOrgNodeIds(db, user);
  const columns = "id,parent_id parentId,name,path,sort_order sortOrder";
  const nodes = ids === null
    ? db.prepare(`SELECT ${columns} FROM org_nodes ORDER BY path,sort_order,name`).all()
    : ids.length === 0
      ? []
      : db.prepare(`SELECT ${columns} FROM org_nodes WHERE id IN (${ids.map(() => "?").join(",")}) ORDER BY path,sort_order,name`).all(...ids);
  return {
    nodes,
    tags: db.prepare("SELECT id,name,color FROM tags ORDER BY name").all(),
    scoped: ids !== null,
    scopeOrgNodeId: ids === null ? null : (user.scopeOrgNodeId ?? null),
  };
});