import { listRollCallRosters } from "../../../utils/rollcall";

export default defineEventHandler((event) => {
  const user = event.context.user as { id: string; role: string; scopeOrgNodeId?: string | null };
  requirePermission(user, "rollcall.read");
  assertSchoolWideScope(user, "点名名单");
  return { rosters: listRollCallRosters(useDatabase()) };
});