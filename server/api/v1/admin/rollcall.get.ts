import { listRollCallRosters, listRollCallSettings } from "../../../utils/rollcall";

export default defineEventHandler((event) => {
  const user = event.context.user as { id: string; role: string; scopeOrgNodeId?: string | null };
  requirePermission(user, "rollcall.read");
  assertSchoolWideScope(user, "点名名单");
  const db = useDatabase();
  return { rosters: listRollCallRosters(db), settings: listRollCallSettings(db) };
});