/**
 * 某一个作用域的历史修订：策略卡片「历史」二级视图的数据源。
 *
 * 查询在 server/utils/policy.ts 里，这里只做入参校验——作用域类型必须是这四类之一，
 * 且除全校外必须给出对象，否则等于把整张 assignments 表倒给前端。
 */
const scopeTypes = new Set(["school", "organization", "tag", "device"]);

export default defineEventHandler((event) => {
  const user = event.context.user as { id: string; role: string; scopeOrgNodeId?: string | null };
  requirePermission(user, "policies.read");
  assertSchoolWideScope(user, "策略");
  const query = getQuery(event);
  const scopeType = typeof query.scopeType === "string" ? query.scopeType : "";
  if (!scopeTypes.has(scopeType)) throw createError({ statusCode: 400, message: "作用域类型无效。" });
  const scopeId = typeof query.scopeId === "string" && query.scopeId ? query.scopeId : null;
  if (scopeType !== "school" && !scopeId) throw createError({ statusCode: 400, message: "缺少作用域对象。" });
  return policyScopeHistory(useDatabase(), scopeType, scopeId);
});
