import { listEffectiveRollCall, resolveRollCallForDevice } from "../../../../utils/rollcall";
import { assertDeviceInScope } from "../../../../utils/scope";

/** 逐台设备的生效点名名单：教师只看到自己绑定的设备，组织范围账号只看到子树内的设备。 */
export default defineEventHandler((event) => {
  const user = event.context.user as { id: string; role: string; scopeOrgNodeId?: string | null };
  requirePermission(user, "rollcall.read");
  const db = useDatabase();
  // 设备详情只看一台机器：带上 deviceId 就不必把全部设备的生效名单搬一趟。
  const deviceId = getQuery(event).deviceId;
  if (typeof deviceId === "string" && deviceId) {
    const device = db.prepare("SELECT id,name FROM devices WHERE id=? AND disabled_at IS NULL").get(deviceId) as { id: string; name: string } | undefined;
    if (!device) throw createError({ statusCode: 404, message: "设备不存在。" });
    assertDeviceInScope(db, user, device.id);
    return { devices: [{ deviceId: device.id, deviceName: device.name, ...resolveRollCallForDevice(db, device.id) }] };
  }
  return { devices: listEffectiveRollCall(db, user) };
});
