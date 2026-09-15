import { randomUUID } from "node:crypto";
import { initializeSchema } from "../../../../shared/schemas";
import { assertBootstrapToken } from "../../../utils/bootstrap";

export default defineEventHandler(async (event) => {
  assertBootstrapToken(event);
  const input = initializeSchema.safeParse(await readBody(event));
  if (!input.success) throw createError({ statusCode: 400, message: input.error.issues[0]?.message || "输入无效" });
  const db = useDatabase();
  const initialized = db.prepare("SELECT value FROM system_state WHERE key='initialized'").get() as { value: string } | undefined;
  if (initialized?.value === "true") throw createError({ statusCode: 409, message: "系统已经完成初始化。" });
  const userId = randomUUID();
  const rootId = randomUUID();
  const createdAt = nowIso();
  const passwordHash = await hashPassword(input.data.password);
  const initialize = db.transaction(() => {
    const marker = db.prepare("SELECT value FROM system_state WHERE key='initialized'").get() as { value: string } | undefined;
    if (marker?.value === "true") throw new Error("System already initialized");
    const count = (db.prepare("SELECT COUNT(*) as count FROM users").get() as { count: number }).count;
    if (count > 0) throw new Error("System already has a user");
    db.prepare("INSERT INTO users (id,username,password_hash,display_name,role,created_at) VALUES (?,?,?,?,?,?)")
      .run(userId, input.data.username, passwordHash, input.data.username, "owner", createdAt);
    db.prepare("INSERT INTO org_nodes (id,parent_id,name,path,sort_order,created_at) VALUES (?,NULL,?,'/',0,?)")
      .run(rootId, input.data.schoolName, createdAt);
    db.prepare("INSERT INTO system_state (key,value,updated_at) VALUES ('school_name',?,?),('initialized','true',?)")
      .run(input.data.schoolName, createdAt, createdAt);
    appendAuditWithin(db, { actorType: "user", actorId: userId, action: "system.initialize", targetType: "system", summary: "完成控制平面初始化", details: { schoolName: input.data.schoolName } });
  });
  try { initialize(); } catch { throw createError({ statusCode: 409, message: "初始化已由其他请求完成。" }); }
  createSession(event, userId);
  return { initialized: true };
});