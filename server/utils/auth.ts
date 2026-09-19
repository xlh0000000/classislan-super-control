import { randomUUID } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";
import { deleteCookie, getCookie, setCookie } from "h3";
import { nowIso, useDatabase } from "./database";
import { randomToken, sha256 } from "./security";

export type SessionUser = { id: string; username: string; displayName: string; role: string; scopeOrgNodeId: string | null; mustChangePassword: boolean };
/** 会话行本身只在服务端内部流转：sessionId 用于改密时保留当前会话，不下发给浏览器。 */
export type AuthenticatedUser = SessionUser & { sessionId: string };
const SESSION_TTL_SECONDS = 60 * 60 * 12;


export async function hashPassword(password: string) {
  return hash(password, { memoryCost: 65536, timeCost: 3, parallelism: 1, outputLen: 32 });
}

export async function verifyPassword(hashValue: string, password: string) {
  return verify(hashValue, password);
}

export function createSession(event: Parameters<typeof setCookie>[0], userId: string) {
  const raw = randomToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();
  useDatabase().prepare("INSERT INTO sessions (id,user_id,token_hash,expires_at,created_at,last_seen_at) VALUES (?,?,?,?,?,?)")
    .run(randomUUID(), userId, sha256(raw), expiresAt, nowIso(), nowIso());
  setCookie(event, "cic_session", raw, { httpOnly: true, secure: !import.meta.dev, sameSite: "strict", path: "/", maxAge: SESSION_TTL_SECONDS });
}

export function getSessionUser(event: Parameters<typeof getCookie>[0]): AuthenticatedUser | null {
  const token = getCookie(event, "cic_session");
  if (!token) return null;
  const row = useDatabase().prepare(`SELECT u.id, u.username, u.display_name as displayName, u.role, u.scope_org_node_id as scopeOrgNodeId,
    u.must_change_password as mustChangePassword, s.id as sessionId
    FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=? AND s.expires_at>? AND u.disabled_at IS NULL`).get(sha256(token), nowIso()) as
    (Omit<AuthenticatedUser, "mustChangePassword"> & { mustChangePassword: number }) | undefined;
  if (!row) return null;
  useDatabase().prepare("UPDATE sessions SET last_seen_at=? WHERE id=?").run(nowIso(), row.sessionId);
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    role: row.role,
    scopeOrgNodeId: row.scopeOrgNodeId ?? null,
    mustChangePassword: row.mustChangePassword === 1,
    sessionId: row.sessionId,
  };
}

export function requireUser(event: Parameters<typeof getCookie>[0]): AuthenticatedUser {
  const user = getSessionUser(event);
  if (!user) throw createError({ statusCode: 401, statusMessage: "Authentication required" });
  return user;
}

/** 批量建号带着初始密码：首改完成前，管理端不接受任何其他操作。 */
export function assertNoPendingPasswordChange(user: Pick<SessionUser, "mustChangePassword">) {
  if (user.mustChangePassword)
    throw createError({ statusCode: 403, message: "请先修改初始密码。" });
}

export function destroySession(event: Parameters<typeof deleteCookie>[0]) {
  const token = getCookie(event, "cic_session");
  if (token) useDatabase().prepare("DELETE FROM sessions WHERE token_hash=?").run(sha256(token));
  deleteCookie(event, "cic_session", { path: "/" });
}
