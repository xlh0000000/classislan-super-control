import { listEffectiveRollCall } from "../../../../utils/rollcall";

/** 逐台设备的生效点名名单：教师只看到自己绑定的设备，组织范围账号只看到子树内的设备。 */
export default defineEventHandler((event) => {
  const user = event.context.user as { id: string; role: string; scopeOrgNodeId?: string | null };
  requirePermission(user, "rollcall.read");
  return { devices: listEffectiveRollCall(useDatabase(), user) };
});
