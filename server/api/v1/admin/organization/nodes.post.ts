import { randomUUID } from "node:crypto";
import { z } from "zod";
import { assertOrgNodeInScope } from "../../../../utils/scope";

const createNodeSchema = z.object({ parentId: z.string().uuid(), name: z.string().trim().min(1).max(80) });

export default defineEventHandler(async (event) => {
  const user = event.context.user as { id: string; role: string; scopeOrgNodeId?: string | null };
  requirePermission(user, "organization.write");
  const input = createNodeSchema.safeParse(await readBody(event));
  if (!input.success) throw createError({ statusCode: 400, message: "组织节点信息无效。" });
  const db = useDatabase();
  const parent = db.prepare("SELECT path FROM org_nodes WHERE id=?").get(input.data.parentId) as { path: string } | undefined;
  if (!parent) throw createError({ statusCode: 404, message: "父组织节点不存在。" });
  assertOrgNodeInScope(db, user, input.data.parentId);
  const id = randomUUID();
  const path = `${parent.path === "/" ? "" : parent.path}/${id}`;
  withAuditedTransaction(
    (database) => {
      database.prepare("INSERT INTO org_nodes (id,parent_id,name,path,created_at) VALUES (?,?,?,?,?)")
        .run(id, input.data.parentId, input.data.name, path, nowIso());
      return id;
    },
    () => ({ actorType: "user", actorId: user.id, action: "organization.node.create", targetType: "org_node", targetId: id, summary: `创建组织节点 ${input.data.name}` }),
  );
  return { id, parentId: input.data.parentId, name: input.data.name, path };
});