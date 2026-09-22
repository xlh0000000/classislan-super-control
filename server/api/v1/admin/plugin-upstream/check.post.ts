import { pluginUpstreamView, readPluginUpstreamConfig, runPluginUpstreamCheck } from "../../../../utils/plugin-upstream";

export default defineEventHandler(async (event) => {
  const user = event.context.user as { id: string; role: string; scopeOrgNodeId?: string | null };
  requirePermission(user, "plugins.write");
  assertSchoolWideScope(user, "插件上游版本检测");
  const db = useDatabase();
  if (!readPluginUpstreamConfig(db).enabled)
    throw createError({ statusCode: 409, message: "上游版本检测已关闭，先在设置里打开。" });
  // 手动这一趟不等间隔：管理员按下「立即检查」要的就是此刻的结果。
  const state = await runPluginUpstreamCheck(db);
  appendAudit({
    actorType: "user", actorId: user.id, action: "plugin.upstream_check", targetType: "plugin_upstream", targetId: state.version ?? undefined,
    summary: state.ok ? `检查插件上游版本：${state.version}` : `检查插件上游版本失败：${state.error ?? "未知原因"}`,
    details: { ok: state.ok, version: state.version, tagName: state.tagName, via: state.via, error: state.error },
  });
  return { upstream: pluginUpstreamView(db) };
});
