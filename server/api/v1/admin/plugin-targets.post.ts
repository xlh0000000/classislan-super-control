import { pluginUpdateTargetSchema } from "../../../../shared/schemas";
import { assertPluginTargetScope, deletePluginUpdateTarget, upsertPluginUpdateTarget } from "../../../utils/plugin-updates";

const SCOPE_NAMES: Record<string, string> = { school: "全校", organization: "组织", tag: "标签", device: "设备" };

export default defineEventHandler(async (event) => {
  const user = event.context.user as { id: string; role: string; scopeOrgNodeId?: string | null };
  requirePermission(user, "plugins.write");
  const parsed = pluginUpdateTargetSchema.safeParse(await readBody(event));
  if (!parsed.success) throw createError({ statusCode: 400, message: parsed.error.issues[0]?.message ?? "升级目标无效。" });
  const { scopeType, version } = parsed.data;
  const scopeId = scopeType === "school" ? null : parsed.data.scopeId;
  const db = useDatabase();
  assertPluginTargetScope(db, user, scopeType, scopeId);
  // 审计条目要能单独读懂：只记 UUID 的话，得点进详情才知道改的是哪一层、哪台机器。
  const scopeLabel = (type: string, id: string | null) => {
    if (type === "school") return "全校";
    const table = type === "organization" ? "org_nodes" : type === "tag" ? "tags" : "devices";
    const name = (db.prepare(`SELECT name FROM ${table} WHERE id=?`).get(id ?? "") as { name: string } | undefined)?.name ?? id;
    return `${SCOPE_NAMES[type] ?? type}「${name}」`;
  };

  if (version === null) {
    const removed = withAuditedTransaction(
      (database) => deletePluginUpdateTarget(database, scopeType, scopeId),
      () => ({
        actorType: "user", actorId: user.id, action: "plugin.target_delete", targetType: "plugin_update_target",
        targetId: scopeId ?? "school",
        summary: `取消${scopeLabel(scopeType, scopeId)}的插件目标版本`,
        details: { scopeType, scopeId },
      }),
    );
    return { scopeType, scopeId, cleared: removed };
  }

  if (!db.prepare("SELECT 1 FROM plugin_releases WHERE version=?").get(version))
    throw createError({ statusCode: 400, message: "该版本尚未上传。" });
  // 多态的 scope_id 用不了外键，存在性只能在这里逐个查：目标挂在不存在的组织或标签上，等于悄悄丢掉。
  const exists = scopeType === "organization" ? !!db.prepare("SELECT 1 FROM org_nodes WHERE id=?").get(scopeId)
    : scopeType === "tag" ? !!db.prepare("SELECT 1 FROM tags WHERE id=?").get(scopeId)
      : scopeType === "device" ? !!db.prepare("SELECT 1 FROM devices WHERE id=?").get(scopeId)
        : true;
  if (!exists) throw createError({ statusCode: 404, message: "目标对象不存在。" });

  const stored = withAuditedTransaction(
    (database) => upsertPluginUpdateTarget(database, { scopeType, scopeId, version }, user.id),
    () => ({
      actorType: "user", actorId: user.id, action: "plugin.target_set", targetType: "plugin_update_target",
      targetId: scopeId ?? "school",
      summary: `给${scopeLabel(scopeType, scopeId)}设置插件目标版本 ${version}`, details: { scopeType, scopeId, version },
    }),
  );
  return stored;
});
