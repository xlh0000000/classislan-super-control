import { rollCallSettingsSchema } from "../../../../../shared/schemas";
import { upsertRollCallSettings } from "../../../../utils/rollcall";
import { isTeacher } from "../../../../utils/scope";

export default defineEventHandler(async (event) => {
  const user = event.context.user as { id: string; role: string; scopeOrgNodeId?: string | null };
  requirePermission(user, "rollcall.write");
  const parsed = rollCallSettingsSchema.safeParse(await readBody(event));
  if (!parsed.success) throw createError({ statusCode: 400, message: "点名设置无效。", data: { issues: parsed.error.issues } });
  const input = parsed.data;
  if (isTeacher(user)) {
    // 教师只能决定自己绑定那台机器的点名行为：全校与组织默认值归管理员。
    if (input.scopeType !== "device")
      throw createError({ statusCode: 403, message: "教师只能为自己绑定的设备保存点名设置。" });
  } else {
    assertSchoolWideScope(user, "点名设置");
  }
  const saved = upsertRollCallSettings(useDatabase(), user, {
    scopeType: input.scopeType,
    scopeId: input.scopeId ?? null,
    enabled: input.enabled ?? null,
    multiEnabled: input.multiEnabled ?? null,
    notify: input.notify ?? null,
    singleSeconds: input.singleSeconds ?? null,
    multiSeconds: input.multiSeconds ?? null,
  });
  // 五项全不表态等于清除本层覆盖，返回 null 让前端据此回落到继承链。
  return { settings: saved };
});
