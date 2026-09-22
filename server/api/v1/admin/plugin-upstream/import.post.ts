import { pluginUpstreamImportSchema } from "../../../../../shared/schemas";
import { importPluginUpstreamRelease, pluginUpstreamView } from "../../../../utils/plugin-upstream";

export default defineEventHandler(async (event) => {
  const user = event.context.user as { id: string; role: string; scopeOrgNodeId?: string | null };
  requirePermission(user, "plugins.write");
  assertSchoolWideScope(user, "插件发布包");
  const parsed = pluginUpstreamImportSchema.safeParse(await readBody(event));
  if (!parsed.success) throw createError({ statusCode: 400, message: "要拉取的上游版本无效。" });
  const db = useDatabase();
  // 只把包取回来存着：不设为当前版本，也就不存在「点一下全校跟着升」。
  const imported = await importPluginUpstreamRelease(db, user.id, { version: parsed.data.version });
  return { imported, upstream: pluginUpstreamView(db) };
});
