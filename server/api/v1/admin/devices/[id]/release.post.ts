import { randomUUID } from "node:crypto";
import { z } from "zod";
import { assertDeviceInScope } from "../../../../../utils/scope";

/** 解除集控的 TTL：设备可能离线，给管理员留出足够的上线窗口。 */
const RELEASE_TTL_MS = 24 * 60 * 60 * 1000;

const bodySchema = z.object({ reason: z.string().trim().max(200).optional() }).partial();

/**
 * 解除集控：设备端唯一允许清除入网身份的通道。
 *
 * 设备端在入网后会拒绝一切本地解除操作（改服务器地址、清空凭据、重装身份），
 * 因此这个入口必须只由管理员经命令队列下发，并在设备回执 succeeded 后才算生效。
 */
export default defineEventHandler(async (event) => {
  const user = event.context.user as { id: string; role: string; scopeOrgNodeId?: string | null };
  requirePermission(user, "devices.write");
  const id = getRouterParam(event, "id")!;
  const db = useDatabase();
  assertDeviceInScope(db, user, id);
  const device = db.prepare("SELECT id,name,disabled_at disabledAt FROM devices WHERE id=?").get(id) as
    { id: string; name: string; disabledAt: string | null } | undefined;
  if (!device) throw createError({ statusCode: 404, message: "设备不存在。" });
  if (device.disabledAt) throw createError({ statusCode: 409, message: "设备已停用，请先恢复设备再解除集控。" });
  const input = bodySchema.safeParse((await readBody(event).catch(() => undefined)) ?? {});
  if (!input.success) throw createError({ statusCode: 400, message: "解除集控参数无效。" });

  // 只对明确声明支持该能力的设备下发，避免等待一个永远不会被执行的命令。
  const snapshot = db.prepare("SELECT capabilities FROM capability_snapshots WHERE device_id=?").get(id) as
    { capabilities: string } | undefined;
  let supported = false;
  if (snapshot) {
    try {
      supported = (JSON.parse(snapshot.capabilities) as { id?: string }[]).some((item) => item?.id === "enrollment.release.v1");
    } catch { supported = false; }
  }
  if (!supported)
    throw createError({ statusCode: 409, message: "该设备未声明支持解除集控能力，请先升级设备端插件。" });

  const inflight = db.prepare(`SELECT id FROM commands
    WHERE device_id=? AND capability_id='enrollment.release.v1' AND state IN ('pending','offered','received','running')`).get(id);
  if (inflight) throw createError({ statusCode: 409, message: "已有一条解除命令等待设备回执，请稍候。" });

  const createdAt = nowIso();
  const taskId = randomUUID();
  const commandId = randomUUID();
  const expiresAt = new Date(Date.now() + RELEASE_TTL_MS).toISOString();
  // deviceId 随命令下发，设备会比对自身身份后再执行，避免误投命令让别的设备掉线。
  const payload = JSON.stringify({ deviceId: id, reason: input.data.reason ?? "", requestedBy: user.id });
  db.transaction(() => {
    db.prepare(`INSERT INTO tasks
      (id,name,capability_id,state,payload,scheduled_at,expires_at,created_by,created_at,updated_at,
       mode,batch_size,percent,failure_threshold,max_concurrency,cancel_requested,idempotency_key,idempotency_actor_id,idempotency_request_hash,target_snapshot)
      VALUES (?,?,?,?,?,NULL,?,?,?,?,?,NULL,NULL,0,0,0,NULL,NULL,NULL,?)`)
      .run(taskId, `解除集控 ${device.name}`, "enrollment.release.v1", "running", payload,
        expiresAt, user.id, createdAt, createdAt, "all", JSON.stringify([{ id, orgNodeId: null }]));
    db.prepare(`INSERT INTO task_batches (id,task_id,batch_index,device_ids,state,created_at,updated_at)
      VALUES (?,?,0,?,?,?,?)`)
      .run(randomUUID(), taskId, JSON.stringify([id]), "active", createdAt, createdAt);
    db.prepare(`INSERT INTO commands
      (id,task_id,device_id,capability_id,payload,not_before,expires_at,state,max_attempts,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(commandId, taskId, id, "enrollment.release.v1", payload, createdAt, expiresAt, "pending", 3, createdAt);
    appendAuditWithin(db, {
      actorType: "user", actorId: user.id, action: "device.release", targetType: "device", targetId: id,
      summary: `解除设备 ${device.name} 的集控接入`, details: { commandId, taskId, reason: input.data.reason ?? null, expiresAt },
    });
  })();
  return { deviceId: id, commandId, taskId, expiresAt };
});