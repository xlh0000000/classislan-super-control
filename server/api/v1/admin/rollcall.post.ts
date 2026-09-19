import { rollCallRosterSchema } from "../../../../shared/schemas";
import { upsertRollCallRoster } from "../../../utils/rollcall";
import { isTeacher } from "../../../utils/scope";

export default defineEventHandler(async (event) => {
  const user = event.context.user as { id: string; role: string; scopeOrgNodeId?: string | null };
  requirePermission(user, "rollcall.write");
  const parsed = rollCallRosterSchema.safeParse(await readBody(event));
  if (!parsed.success) throw createError({ statusCode: 400, message: "点名名单无效。", data: { issues: parsed.error.issues } });
  const input = parsed.data;
  if (isTeacher(user)) {
    // 教师只可能改自己设备上的名单：全校与组织名单归管理员，跨设备的写入一律拒绝。
    if (input.scopeType !== "device")
      throw createError({ statusCode: 403, message: "教师只能为自己绑定的设备保存点名名单。" });
  } else {
    assertSchoolWideScope(user, "点名名单");
  }
  return upsertRollCallRoster(useDatabase(), user, {
    name: input.name,
    scopeType: input.scopeType,
    scopeId: input.scopeId ?? null,
    names: input.names,
  });
});
