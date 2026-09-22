/**
 * 按作用域聚合的策略现状：每个曾被挂过的作用域一行，带当前生效的那一版与历史条数。
 *
 * 修订列表（/policies）是按修订倒序的流水账，管理员要看的「哪一路现在跑第几版」混在里面找不到，
 * 聚合格式在 server/utils/policy.ts 里，这里只负责放行。
 */
export default defineEventHandler((event) => {
  const user = event.context.user as { id: string; role: string; scopeOrgNodeId?: string | null };
  requirePermission(user, "policies.read");
  assertSchoolWideScope(user, "策略");
  return policyScopeOverviews(useDatabase());
});
