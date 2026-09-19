import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { hashPassword } from "./auth";
import { nowIso } from "./database";
import { appendAuditWithin, CREDENTIAL_ALPHABET, randomReadableString } from "./security";

/**
 * 教师账号一次最多批量生成的条数。上限由口令哈希决定：argon2 每条要几百毫秒，
 * 线程池并行度有限，批次再大只会让请求超时；也顺带避免把建号接口当成整校名册导入通道。
 */
export const MAX_TEACHER_BATCH = 50;

const INITIAL_PASSWORD_GROUPS = 4;
const INITIAL_PASSWORD_GROUP_SIZE = 4;

/**
 * 形如 `KQ7F-2mXD-9WTR-JKPE` 的初始口令：够长、能读出来、也敲得进去。
 * 字母表去掉易混字符（0/O、1/I/l），因为口令常由管理员口头或纸条转达；
 * 首登强制改密，所以它只是短暂存在的引导凭据，不承担长期机密。
 */
export function generateInitialPassword() {
  const chars = randomReadableString(CREDENTIAL_ALPHABET, INITIAL_PASSWORD_GROUPS * INITIAL_PASSWORD_GROUP_SIZE);
  const groups: string[] = [];
  for (let index = 0; index < chars.length; index += INITIAL_PASSWORD_GROUP_SIZE)
    groups.push(chars.slice(index, index + INITIAL_PASSWORD_GROUP_SIZE));
  return groups.join("-");
}

export type TeacherAccountRequest = { username: string; displayName?: string };
export type RejectedTeacherAccount = { username: string; reason: string };
export type CreatedTeacherAccount = { id: string; username: string; displayName: string; password: string };

const USERNAME_PATTERN = /^[A-Za-z0-9_.-]{3,32}$/;

/**
 * 把请求切成「可建」与「被拒」两拨：先按字符集与长度校验，再去掉本次请求内的重复，
 * 最后比对库里已有的用户名（大小写不敏感，与登录查询一致）。
 * 被拒条目带原因，界面据此逐条提示，而不是整批失败。
 */
export function planTeacherAccounts(db: Database.Database, accounts: TeacherAccountRequest[]) {
  const valid: { username: string; displayName: string }[] = [];
  const rejected: RejectedTeacherAccount[] = [];
  const seen = new Set<string>();
  for (const account of accounts) {
    const username = account.username.trim();
    if (!USERNAME_PATTERN.test(username)) {
      rejected.push({ username, reason: "用户名需为 3-32 位字母、数字或 . _ -" });
      continue;
    }
    const key = username.toLowerCase();
    if (seen.has(key)) {
      rejected.push({ username, reason: "本次请求内重复" });
      continue;
    }
    seen.add(key);
    if (db.prepare("SELECT 1 FROM users WHERE username=? COLLATE NOCASE").get(username)) {
      rejected.push({ username, reason: "用户名已存在" });
      continue;
    }
    const displayName = account.displayName?.trim();
    valid.push({ username, displayName: displayName || username });
  }
  return { valid, rejected };
}

/**
 * 批量建教师账号：每个账号带一条随机初始口令，并把强制首改标记打开，
 * 于是首次登录只能去改密码（管理端中间件在改密前拒绝其他请求）。
 * 口令明文只出现在返回值里，供界面一次性展示；库里只有 argon2 哈希。
 * 插入与审计同处一个事务；用户名撞车（并发建号）按逐条被拒处理，不牵连整批。
 */
export async function createTeacherAccounts(
  db: Database.Database,
  actorId: string,
  input: { accounts: TeacherAccountRequest[]; scopeOrgNodeId: string | null },
  now = nowIso(),
): Promise<{ created: CreatedTeacherAccount[]; rejected: RejectedTeacherAccount[] }> {
  const { valid, rejected } = planTeacherAccounts(db, input.accounts);
  if (!valid.length) return { created: [], rejected };
  const planned = valid.map((account) => ({ ...account, password: generateInitialPassword() }));
  const hashes = await Promise.all(planned.map((account) => hashPassword(account.password)));
  return db.transaction(() => {
    const created: CreatedTeacherAccount[] = [];
    planned.forEach((account, index) => {
      const id = randomUUID();
      const changes = db.prepare(`INSERT INTO users (id,username,password_hash,display_name,role,scope_org_node_id,must_change_password,created_at)
        VALUES (?,?,?,?,?,?,1,?)
        ON CONFLICT(username) DO NOTHING`)
        .run(id, account.username, hashes[index], account.displayName, "teacher", input.scopeOrgNodeId, now).changes;
      if (!changes) rejected.push({ username: account.username, reason: "用户名已存在" });
      else created.push({ id, username: account.username, displayName: account.displayName, password: account.password });
    });
    // 全部撞车的批次不改动作证链：什么都没建，就不该留下一条“创建”记录。
    if (created.length) appendAuditWithin(db, {
      actorType: "user", actorId, action: "user.bulk.create", targetType: "user",
      summary: `批量创建 ${created.length} 个教师账号`,
      details: { role: "teacher", scopeOrgNodeId: input.scopeOrgNodeId, usernames: created.map((row) => row.username), rejected: rejected.length },
    });
    return { created, rejected };
  })();
}
