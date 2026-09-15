import type Database from "better-sqlite3";
import { nowIso } from "./database";
import { appendAuditWithin } from "./security";

/** 用户生命周期错误，供路由映射为 HTTP 状态码，避免 util 直接依赖 Nitro 全局。 */
export class UserError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
    this.name = "UserError";
  }
}

/**
 * 删除某用户的全部会话。
 *
 * 角色或组织范围变化后必须调用：会话行本身不携带角色，若只依赖每次请求回查 users，
 * 会话看起来会“自动生效”，但重新启用或回滚范围时旧令牌仍可用。显式撤销让权限变更
 * 立刻需要重新认证。
 */
export function revokeUserSessions(db: Database.Database, userId: string) {
  return db.prepare("DELETE FROM sessions WHERE user_id=?").run(userId).changes;
}

type UserRow = { id: string; username: string; role: string; disabledAt: string | null };

function loadUser(db: Database.Database, id: string): UserRow {
  const row = db.prepare("SELECT id,username,role,disabled_at disabledAt FROM users WHERE id=?").get(id) as UserRow | undefined;
  if (!row) throw new UserError(404, "用户不存在。");
  return row;
}

/**
 * 停用/启用账号。停用会连同全部会话一起撤销，且启用必须重新登录，
 * 避免停用期间残留的令牌在恢复后重新生效。
 */
export function setUserDisabled(db: Database.Database, actorId: string, targetId: string, disabled: boolean, now = nowIso()) {
  const target = loadUser(db, targetId);
  if (target.role === "owner") throw new UserError(400, "不能停用唯一所有者。");
  if (disabled && target.disabledAt) throw new UserError(409, "用户已停用。");
  if (!disabled && !target.disabledAt) throw new UserError(409, "用户未停用。");
  db.transaction(() => {
    db.prepare("UPDATE users SET disabled_at=? WHERE id=?").run(disabled ? now : null, targetId);
    revokeUserSessions(db, targetId);
    appendAuditWithin(db, {
      actorType: "user", actorId, action: disabled ? "user.disable" : "user.enable",
      targetType: "user", targetId, summary: `${disabled ? "停用" : "启用"}用户 ${target.username}`,
    });
  })();
  return { id: targetId, disabledAt: disabled ? now : null };
}