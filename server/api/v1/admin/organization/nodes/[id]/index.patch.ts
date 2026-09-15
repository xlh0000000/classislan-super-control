import { z } from "zod";
import { assertOrgNodeInScope } from "../../../../../../utils/scope";

const patchSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  parentId: z.string().uuid().nullable().optional(),
  sortOrder: z.number().int().min(-100000).max(100000).optional(),
}).refine((value) => Object.keys(value).length > 0, { message: "至少提供一个更新字段。" });

export default defineEventHandler(async (event) => {
  const user = event.context.user as { id: string; role: string; scopeOrgNodeId?: string | null };
  requirePermission(user, "organization.write");
  const id = getRouterParam(event, "id")!;
  const input = patchSchema.safeParse(await readBody(event));
  if (!input.success) throw createError({ statusCode: 400, message: "组织节点更新信息无效。" });
  const db = useDatabase();
  const node = db.prepare("SELECT id,parent_id parentId,name,path FROM org_nodes WHERE id=?").get(id) as { id: string; parentId: string | null; name: string; path: string } | undefined;
  if (!node) throw createError({ statusCode: 404, message: "组织节点不存在。" });
  assertOrgNodeInScope(db, user, id);
  const changedAt = nowIso();
  db.transaction(() => {
    if (input.data.parentId !== undefined && input.data.parentId !== node.parentId) {
      const newParentId = input.data.parentId;
      if (newParentId === id) throw new Error("cannot-move-into-self");
      if (newParentId) {
        const parent = db.prepare("SELECT path FROM org_nodes WHERE id=?").get(newParentId) as { path: string } | undefined;
        if (!parent) throw new Error("parent-not-found");
        assertOrgNodeInScope(db, user, newParentId);
        if (parent.path.startsWith(`${node.path}/`) || parent.path === node.path) throw new Error("cannot-move-into-descendant");
        const newPath = `${parent.path === "/" ? "" : parent.path}/${id}`;
        // 更新自身及所有后代路径
        db.prepare("UPDATE org_nodes SET parent_id=?,path=?,updated_at=? WHERE id=?").run(newParentId, newPath, changedAt, id);
        const descendants = db.prepare("SELECT id,path FROM org_nodes WHERE path LIKE ?").all(`${node.path}/%`) as { id: string; path: string }[];
        for (const descendant of descendants) {
          const descendantNewPath = `${newPath}${descendant.path.slice(node.path.length)}`;
          db.prepare("UPDATE org_nodes SET path=?,updated_at=? WHERE id=?").run(descendantNewPath, changedAt, descendant.id);
        }
      } else {
        const newPath = `/${id}`;
        db.prepare("UPDATE org_nodes SET parent_id=NULL,path=?,updated_at=? WHERE id=?").run(newPath, changedAt, id);
        const descendants = db.prepare("SELECT id,path FROM org_nodes WHERE path LIKE ?").all(`${node.path}/%`) as { id: string; path: string }[];
        for (const descendant of descendants) {
          const descendantNewPath = `${newPath}${descendant.path.slice(node.path.length)}`;
          db.prepare("UPDATE org_nodes SET path=?,updated_at=? WHERE id=?").run(descendantNewPath, changedAt, descendant.id);
        }
      }
    }
    if (input.data.name && input.data.name !== node.name)
      db.prepare("UPDATE org_nodes SET name=?,updated_at=? WHERE id=?").run(input.data.name, changedAt, id);
    if (input.data.sortOrder !== undefined)
      db.prepare("UPDATE org_nodes SET sort_order=?,updated_at=? WHERE id=?").run(input.data.sortOrder, changedAt, id);
    // 组织树移动会改变子树上设备的组织继承链，需推进 epoch。
    if (input.data.parentId !== undefined && input.data.parentId !== node.parentId) bumpDesiredStateEpoch(db, changedAt);
    appendAuditWithin(db, { actorType: "user", actorId: user.id, action: "organization.node.update", targetType: "org_node", targetId: id, summary: `更新组织节点 ${input.data.name ?? node.name}`, details: { fields: Object.keys(input.data) } });
  })();
  return { id, updatedAt: changedAt };
});