export default defineEventHandler(async (event) => {
  const user = event.context.user as { id: string; role: string };
  requirePermission(user, "organization.write");
  assertSchoolWideScope(user, "设备标签");
  const id = getRouterParam(event, "id")!;
  const db = useDatabase();
  const tag = db.prepare("SELECT id,name FROM tags WHERE id=?").get(id) as { id: string; name: string } | undefined;
  if (!tag) throw createError({ statusCode: 404, message: "标签不存在。" });
  const usedByPolicy = db.prepare("SELECT COUNT(*) count FROM policy_assignments WHERE scope_type='tag' AND scope_id=? AND superseded_at IS NULL").get(id) as { count: number };
  if (usedByPolicy.count > 0) throw createError({ statusCode: 409, message: "该标签仍被活动策略引用，请先替换策略。" });
  const usedByPluginTarget = db.prepare("SELECT COUNT(*) count FROM plugin_update_targets WHERE scope_type='tag' AND scope_id=?").get(id) as { count: number };
  if (usedByPluginTarget.count > 0) throw createError({ statusCode: 409, message: "该标签仍被插件升级目标引用，请先取消目标。" });
  withAuditedTransaction(
    (database) => {
      database.prepare("DELETE FROM device_tags WHERE tag_id=?").run(id);
      database.prepare("DELETE FROM tags WHERE id=?").run(id);
      // 标签被移除会改变原持有该标签设备的有效策略。
      bumpDesiredStateEpoch(database, nowIso());
      return id;
    },
    () => ({ actorType: "user", actorId: user.id, action: "organization.tag.delete", targetType: "tag", targetId: id, summary: `删除标签 ${tag.name}` }),
  );
  return { id, deleted: true };
});