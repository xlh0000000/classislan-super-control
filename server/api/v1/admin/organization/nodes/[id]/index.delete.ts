import { assertOrgNodeInScope } from "../../../../../../utils/scope";
export default defineEventHandler(async (event) => {
  const user = event.context.user as { id: string; role: string; scopeOrgNodeId?: string | null };
  requirePermission(user, "organization.write");
  const id = getRouterParam(event, "id")!;
  const db = useDatabase();
  const node = db.prepare("SELECT id,name,path FROM org_nodes WHERE id=?").get(id) as { id: string; name: string; path: string } | undefined;
  if (!node) throw createError({ statusCode: 404, message: "组织节点不存在。" });
  assertOrgNodeInScope(db, user, id);
  const children = db.prepare("SELECT COUNT(*) count FROM org_nodes WHERE parent_id=?").get(id) as { count: number };
  if (children.count > 0) throw createError({ statusCode: 409, message: "请先移动或删除子节点。" });
  const devices = db.prepare("SELECT COUNT(*) count FROM devices WHERE org_node_id=?").get(id) as { count: number };
  if (devices.count > 0) throw createError({ statusCode: 409, message: `仍有 ${devices.count} 台设备属于该组织，请先移动设备。` });
  const usedByPolicy = db.prepare("SELECT COUNT(*) count FROM policy_assignments WHERE scope_type='organization' AND scope_id=? AND superseded_at IS NULL").get(id) as { count: number };
  if (usedByPolicy.count > 0) throw createError({ statusCode: 409, message: "该组织仍被活动策略引用，请先替换策略。" });
  const usedByPluginTarget = db.prepare("SELECT COUNT(*) count FROM plugin_update_targets WHERE scope_type='organization' AND scope_id=?").get(id) as { count: number };
  if (usedByPluginTarget.count > 0) throw createError({ statusCode: 409, message: "该组织仍被插件升级目标引用，请先取消目标。" });
  withAuditedTransaction(
    (database) => {
      database.prepare("DELETE FROM org_nodes WHERE id=?").run(id);
      return id;
    },
    () => ({ actorType: "user", actorId: user.id, action: "organization.node.delete", targetType: "org_node", targetId: id, summary: `删除组织节点 ${node.name}` }),
  );
  return { id, deleted: true };
});