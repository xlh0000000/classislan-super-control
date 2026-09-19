import type Database from "better-sqlite3";
import { nowIso } from "./database";
import { appendAuditWithin, CREDENTIAL_ALPHABET, randomReadableString, sha256, timingSafeEqualText } from "./security";

/** 绑定码有效期：够教师走到设备前扫码，又短到被旁人记住也来不及复用。 */
export const BINDING_CODE_TTL_MS = 5 * 60_000;
const BINDING_CODE_LENGTH = 10;

export type BoundTeacher = {
  userId: string;
  username: string;
  displayName: string;
  boundBy: "admin" | "qr";
  createdAt: string;
};

/** 设备当前绑定的教师，按绑定时间排列。 */
export function listDeviceTeachers(db: Database.Database, deviceId: string): BoundTeacher[] {
  return db.prepare(`SELECT t.user_id userId,u.username,u.display_name displayName,t.bound_by boundBy,t.created_at createdAt
    FROM device_teachers t JOIN users u ON u.id=t.user_id
    WHERE t.device_id=? ORDER BY t.created_at,u.username`).all(deviceId) as BoundTeacher[];
}

/** 某教师绑定的设备清单（供解绑等界面回显）。 */
export function listTeacherDevices(db: Database.Database, userId: string) {
  return db.prepare(`SELECT d.id deviceId,d.name deviceName,t.bound_by boundBy,t.created_at createdAt
    FROM device_teachers t JOIN devices d ON d.id=t.device_id
    WHERE t.user_id=? AND d.disabled_at IS NULL ORDER BY d.name`).all(userId) as {
    deviceId: string; deviceName: string; boundBy: "admin" | "qr"; createdAt: string;
  }[];
}

/**
 * 签发一次性绑定码：库里只留 sha256，明文只随已签名的轮询响应回到该设备自己屏上。
 * 每次申请都换新的码并覆盖旧值，因此屏上停留的码过期或被人抄走都无法二次使用。
 */
export function issueBindingCode(db: Database.Database, deviceId: string, now = nowIso()) {
  const code = randomReadableString(CREDENTIAL_ALPHABET, BINDING_CODE_LENGTH);
  const expiresAt = new Date(Date.parse(now) + BINDING_CODE_TTL_MS).toISOString();
  db.prepare("UPDATE devices SET binding_code_hash=?,binding_code_expires_at=? WHERE id=?").run(sha256(code), expiresAt, deviceId);
  return { code, expiresAt };
}

function clearBindingCode(db: Database.Database, deviceId: string) {
  db.prepare("UPDATE devices SET binding_code_hash=NULL,binding_code_expires_at=NULL WHERE id=?").run(deviceId);
}

/** 绑定关系落库：重复绑定按已存在处理，不报错也不产生第二条审计。 */
function insertBinding(db: Database.Database, deviceId: string, userId: string, boundBy: "admin" | "qr", now: string) {
  return db.prepare(`INSERT INTO device_teachers (device_id,user_id,bound_by,created_at) VALUES (?,?,?,?)
    ON CONFLICT(device_id,user_id) DO NOTHING`).run(deviceId, userId, boundBy, now).changes === 1;
}

function loadBindableDevice(db: Database.Database, deviceId: string) {
  const device = db.prepare("SELECT id,name FROM devices WHERE id=? AND disabled_at IS NULL").get(deviceId) as { id: string; name: string } | undefined;
  if (!device) throw createError({ statusCode: 404, message: "设备不存在。" });
  return device;
}

function loadBindableUser(db: Database.Database, userId: string) {
  const user = db.prepare("SELECT id,username,display_name displayName FROM users WHERE id=? AND disabled_at IS NULL")
    .get(userId) as { id: string; username: string; displayName: string } | undefined;
  if (!user) throw createError({ statusCode: 404, message: "用户不存在。" });
  return user;
}

/** 管理员在后台把教师绑到设备上；设备与教师都要落在操作者的可见范围内（由路由把关）。 */
export function bindTeacher(db: Database.Database, actorId: string, deviceId: string, userId: string, now = nowIso()) {
  const device = loadBindableDevice(db, deviceId);
  const user = loadBindableUser(db, userId);
  return db.transaction(() => {
    const created = insertBinding(db, deviceId, userId, "admin", now);
    if (created) appendAuditWithin(db, {
      actorType: "user", actorId, action: "device.teacher.bind", targetType: "device", targetId: deviceId,
      summary: `绑定教师 ${user.displayName} 至设备 ${device.name}`, details: { userId, boundBy: "admin" },
    });
    return { deviceId, userId, created };
  })();
}

/** 解绑不区分来源：管理端与教师本人（自助解除）走同一条路径，路由已确认其对设备的可见性。 */
export function unbindTeacher(db: Database.Database, actorId: string, deviceId: string, userId: string, now = nowIso()) {
  const device = loadBindableDevice(db, deviceId);
  return db.transaction(() => {
    const changes = db.prepare("DELETE FROM device_teachers WHERE device_id=? AND user_id=?").run(deviceId, userId).changes;
    if (!changes) return false;
    appendAuditWithin(db, {
      actorType: "user", actorId, action: "device.teacher.unbind", targetType: "device", targetId: deviceId,
      summary: `解除设备 ${device.name} 的教师绑定`, details: { userId, at: now },
    });
    return true;
  })();
}

/**
 * 教师扫码兑换绑定：设备屏上出示的一次性码 + 设备 id 换来一条绑定关系。
 * 码校验失败时给出的是一句统一提示——不区分“设备没出码 / 码错 / 已过期”，免得给探测留线索。
 */
export function redeemBindingCode(db: Database.Database, userId: string, deviceId: string, code: string, now = nowIso()) {
  const device = db.prepare(`SELECT name,binding_code_hash hash,binding_code_expires_at expiresAt
    FROM devices WHERE id=? AND disabled_at IS NULL`).get(deviceId) as
    { name: string; hash: string | null; expiresAt: string | null } | undefined;
  if (!device) throw createError({ statusCode: 404, message: "设备不存在。" });
  const user = loadBindableUser(db, userId);
  const valid = !!device.hash && !!device.expiresAt && Date.parse(device.expiresAt) > Date.parse(now)
    && timingSafeEqualText(device.hash, sha256(code));
  if (!valid) throw createError({ statusCode: 403, message: "绑定码无效或已过期，请在设备上重新出示。" });
  return db.transaction(() => {
    // 校验通过即作废：同一个码第二次兑换（哪怕并发）也只能有一次生效。
    clearBindingCode(db, deviceId);
    const created = insertBinding(db, deviceId, userId, "qr", now);
    if (created) appendAuditWithin(db, {
      actorType: "user", actorId: userId, action: "device.teacher.bind", targetType: "device", targetId: deviceId,
      summary: `教师 ${user.displayName} 扫码绑定设备 ${device.name}`, details: { userId, boundBy: "qr" },
    });
    return { deviceId, userId, created };
  })();
}
