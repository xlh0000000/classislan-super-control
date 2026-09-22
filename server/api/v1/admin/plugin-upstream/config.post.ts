import { pluginUpstreamConfigSchema } from "../../../../../shared/schemas";
import { pluginUpstreamView, writePluginUpstreamConfig } from "../../../../utils/plugin-upstream";

export default defineEventHandler(async (event) => {
  const user = event.context.user as { id: string; role: string; scopeOrgNodeId?: string | null };
  requirePermission(user, "plugins.write");
  // 检测到的版本是全校共享的一份事实，组织管理员改不动它。
  assertSchoolWideScope(user, "插件上游版本检测");
  const parsed = pluginUpstreamConfigSchema.safeParse(await readBody(event));
  if (!parsed.success)
    throw createError({ statusCode: 400, message: parsed.error.issues[0]?.message ?? "检测设置无效。", data: { issues: parsed.error.issues } });

  const db = useDatabase();
  withAuditedTransaction(
    (database) => writePluginUpstreamConfig(database, parsed.data),
    (saved) => ({
      actorType: "user", actorId: user.id, action: "plugin.upstream_config", targetType: "plugin_upstream",
      summary: `${saved.enabled ? "开启" : "关闭"}插件上游版本检测`,
      details: { enabled: saved.enabled, repo: saved.repo, proxies: saved.proxies, intervalMinutes: saved.intervalMinutes },
    }),
  );
  return { upstream: pluginUpstreamView(db) };
});
