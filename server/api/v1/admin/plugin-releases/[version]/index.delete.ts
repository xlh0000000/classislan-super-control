import { PLUGIN_RELEASE_VERSION_PATTERN } from "../../../../../../shared/schemas";
import { removePluginRelease } from "../../../../../utils/plugin-release-store";

export default defineEventHandler(async (event) => {
  const user = event.context.user as { id: string; role: string; scopeOrgNodeId?: string | null };
  requirePermission(user, "plugins.write");
  assertSchoolWideScope(user, "插件发布版本");
  const version = getRouterParam(event, "version") ?? "";
  if (!PLUGIN_RELEASE_VERSION_PATTERN.test(version)) throw createError({ statusCode: 400, message: "插件版本号格式无效。" });
  const db = useDatabase();
  const release = db.prepare("SELECT version,is_current isCurrent,file_name fileName FROM plugin_releases WHERE version=?").get(version) as
    { version: string; isCurrent: number; fileName: string } | undefined;
  if (!release) throw createError({ statusCode: 404, message: "该版本尚未上传。" });
  // 当前版本正被设备默认跟随，撤它等于把所有没设过目标的机器指向悬空版本；回滚请先设别的版本。
  if (release.isCurrent === 1) throw createError({ statusCode: 400, message: "请先把其他版本设为当前版本，再撤回这一版。" });
  withAuditedTransaction(
    (database) => {
      const result = database.prepare("DELETE FROM plugin_releases WHERE version=?").run(version);
      // 库里的行与磁盘上的包一起消失：留着文件没人引用，只会在备份里占地方并误导排障。
      if (result.changes > 0) removePluginRelease(version);
      return result.changes;
    },
    () => ({
      actorType: "user", actorId: user.id, action: "plugin.release_delete", targetType: "plugin_release", targetId: version,
      summary: `撤回插件包 ${version}`, details: { version, fileName: release.fileName },
    }),
  );
  return { version, deleted: true };
});
