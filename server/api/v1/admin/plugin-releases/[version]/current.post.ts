import { PLUGIN_RELEASE_VERSION_PATTERN } from "../../../../../../shared/schemas";

export default defineEventHandler(async (event) => {
  const user = event.context.user as { id: string; role: string; scopeOrgNodeId?: string | null };
  requirePermission(user, "plugins.write");
  const version = getRouterParam(event, "version") ?? "";
  if (!PLUGIN_RELEASE_VERSION_PATTERN.test(version)) throw createError({ statusCode: 400, message: "插件版本号格式无效。" });
  const db = useDatabase();
  const release = db.prepare("SELECT version,is_current isCurrent,file_name fileName FROM plugin_releases WHERE version=?").get(version) as
    { version: string; isCurrent: number; fileName: string } | undefined;
  if (!release) throw createError({ statusCode: 404, message: "该版本尚未上传。" });
  if (release.isCurrent === 1) return { version, isCurrent: true };
  assertSchoolWideScope(user, "插件发布版本");
  withAuditedTransaction(
    (database) => {
      // 两条语句一起提交：中间不能有此刻同时存在两个「当前版本」的状态。
      database.prepare("UPDATE plugin_releases SET is_current=0 WHERE is_current=1").run();
      database.prepare("UPDATE plugin_releases SET is_current=1 WHERE version=?").run(version);
      return version;
    },
    () => ({
      actorType: "user", actorId: user.id, action: "plugin.release_current", targetType: "plugin_release", targetId: version,
      summary: `将插件当前版本设为 ${version}`, details: { version, fileName: release.fileName },
    }),
  );
  return { version, isCurrent: true };
});
