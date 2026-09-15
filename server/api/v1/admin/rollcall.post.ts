import { rollCallRosterSchema } from "../../../../shared/schemas";
import { upsertRollCallRoster } from "../../../utils/rollcall";

export default defineEventHandler(async (event) => {
  const user = event.context.user as { id: string; role: string; scopeOrgNodeId?: string | null };
  requirePermission(user, "rollcall.write");
  assertSchoolWideScope(user, "点名名单");
  const parsed = rollCallRosterSchema.safeParse(await readBody(event));
  if (!parsed.success) throw createError({ statusCode: 400, message: "点名名单无效。", data: { issues: parsed.error.issues } });
  const input = parsed.data;
  return upsertRollCallRoster(useDatabase(), user, {
    name: input.name,
    scopeType: input.scopeType,
    scopeId: input.scopeId ?? null,
    names: input.names,
  });
});