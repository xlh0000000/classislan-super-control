import type Database from "better-sqlite3";
import { createError } from "h3";
import type { z } from "zod";
import type { pollSchema } from "../../shared/schemas";
import type { AuthenticatedDeviceRequest } from "./device-auth";
import { appendAuditWithin, canonicalJson, sha256 } from "./security";
import { advanceTaskState, claimCommandsForDevice, terminalCommandStates } from "./tasks";
import { materializeConfigReferences, resolvePolicyForDeviceFromDb } from "./policy";
import { resolveRollCallForDevice } from "./rollcall";
import { signResponseBody } from "./server-signing";
import { timetableDigestMatches, upsertDeviceTimetable } from "./device-timetable";

export type DevicePollInput = z.infer<typeof pollSchema>;

export type DevicePollOutcome = {
  body: string;
  keyId: string;
  signature: string;
  replayed: boolean;
};

export type DeviceResponseSigner = (body: string) => { keyId: string; signature: string };

/** 允许被设备回执覆盖的状态；cancelling 也在内，使被取消的命令能收到设备侧终态。 */
const ACKNOWLEDGEABLE_STATES = ["pending", "offered", "received", "running", "cancelling"];

/** 每设备保留的响应缓存条数，足够覆盖客户端尚未确认的最后一批序列。 */
const RESPONSE_RETENTION = 16;

type AcknowledgementReceipt = {
  commandId: string;
  status: "accepted" | "already-recorded" | "rejected";
  reason?: string;
  state?: string;
};

export function readCachedDeviceResponse(db: Database.Database, deviceId: string, sequence: number) {
  return db
    .prepare("SELECT request_hash requestHash, response_body body, response_key_id keyId, response_signature signature FROM device_responses WHERE device_id=? AND sequence=?")
    .get(deviceId, sequence) as { requestHash: string; body: string; keyId: string; signature: string } | undefined;
}

/**
 * 处理一次已通过签名校验的设备轮询。
 *
 * 关键不变量：序列消费、ACK 处理、命令 offer、策略解析、响应签名与响应缓存
 * 全部在同一个 IMMEDIATE 事务中完成。这样“序列已提交但响应丢失”时，设备用同一
 * (deviceId, sequence, requestHash) 重放可以拿回完全相同的签名响应，而不会被永久 409。
 */
export function processDevicePoll(
  db: Database.Database,
  authenticated: AuthenticatedDeviceRequest,
  input: DevicePollInput,
  seenAt: string,
  sign: DeviceResponseSigner = signResponseBody,
): DevicePollOutcome {
  const { deviceId, sequence, requestHash } = authenticated;

  const acknowledgePlaceholders = ACKNOWLEDGEABLE_STATES.map(() => "?").join(",");
  // 决策与执行都在同一个 IMMEDIATE 事务内：先取写锁，再依据最新的 last_sequence 与响应缓存
  // 判定“重放/执行/拒绝”，避免多进程并发时基于过期序列重复执行。
  const transaction = db.transaction(() => {
    // 1) 同序列同摘要重放：返回完全相同的已签名字节；同序列不同摘要则拒绝。
    const cached = readCachedDeviceResponse(db, deviceId, sequence);
    if (cached) {
      if (cached.requestHash !== requestHash)
        throw createError({ statusCode: 409, message: "设备请求序列已绑定其他正文。" });
      return { body: cached.body, keyId: cached.keyId, signature: cached.signature, replayed: true };
    }
    // 2) 新请求必须严格为 last+1。仅当序列等于 last（升级前的历史序列、尚未写入缓存）时，
    //    允许重算一次并补写缓存，避免老设备被卡死。
    const current = db.prepare("SELECT last_sequence lastSequence, applied_policy_hash appliedPolicyHash, drift_count driftCount, transport transport FROM devices WHERE id=? AND disabled_at IS NULL")
      .get(deviceId) as { lastSequence: number; appliedPolicyHash: string | null; driftCount: number; transport: string } | undefined;
    if (!current) throw createError({ statusCode: 401, message: "未知或已禁用的设备。" });
    const isNextSequence = sequence === current.lastSequence + 1;
    const isLegacyRetry = sequence === current.lastSequence;
    if (!isNextSequence && !isLegacyRetry)
      // 附带服务端权威序列：设备本地状态被清空（如重装/删文件）后可一次性对齐，
      // 而不必从 1 开始逐号追赶。
      throw createError({
        statusCode: 409,
        message: "设备请求序列必须严格递增；同序列重放需命中已缓存响应。",
        data: { lastSequence: current.lastSequence },
      });
    db.prepare(`UPDATE devices SET last_seen_at=?,last_sequence=?,last_request_hash=?,plugin_version=?,app_version=?,platform=?,capability_digest=?,policy_revision=?,policy_epoch=?,applied_policy_hash=?,applied_policy_sections=?,drift_count=?
      WHERE id=? AND disabled_at IS NULL AND (last_sequence<? OR (last_sequence=? AND last_request_hash=?))`)
      .run(seenAt, sequence, requestHash, input.pluginVersion, input.appVersion, input.platform, input.capabilityDigest, input.policyRevision, input.policyEpoch, input.policyHash, JSON.stringify(input.appliedSections ?? {}), input.driftCount, deviceId, sequence, sequence, requestHash);
    if (input.capabilities) {
      db.prepare(`INSERT INTO capability_snapshots (device_id,digest,capabilities,updated_at) VALUES (?,?,?,?)
        ON CONFLICT(device_id) DO UPDATE SET digest=excluded.digest,capabilities=excluded.capabilities,updated_at=excluded.updated_at`)
        .run(deviceId, input.capabilityDigest, JSON.stringify(input.capabilities), seenAt);
    }

    const readCommand = db.prepare("SELECT state,result,device_id,task_id,capability_id FROM commands WHERE id=?");
    const acknowledge = db.prepare(`UPDATE commands SET state=?,result=?,acknowledged_at=?,last_error=?,lease_until=NULL,next_attempt_at=?
      WHERE id=? AND device_id=? AND state IN (${acknowledgePlaceholders})`);
    const receipts: AcknowledgementReceipt[] = [];
    for (const ack of input.acknowledgements) {
      const existing = readCommand.get(ack.commandId) as { state: string; result: string | null; device_id: string; task_id: string; capability_id: string } | undefined;
      if (!existing || existing.device_id !== deviceId) {
        receipts.push({ commandId: ack.commandId, status: "rejected", reason: existing ? "device-mismatch" : "unknown-command" });
        continue;
      }
      const row = db.prepare("SELECT max_attempts maxAttempts, attempt_count attemptCount FROM commands WHERE id=?").get(ack.commandId) as { maxAttempts: number; attemptCount: number };
      const willRetry = ack.state === "failed" && row.attemptCount < row.maxAttempts;
      const retryAt = willRetry ? new Date(Date.now() + 30_000).toISOString() : null;
      const errorText = willRetry ? ((ack.result as { error?: string } | null)?.error ?? null) : null;
      const info = acknowledge.run(willRetry ? "failed" : ack.state, JSON.stringify(ack.result ?? {}), seenAt, errorText, retryAt, ack.commandId, deviceId, ...ACKNOWLEDGEABLE_STATES);
      if (info.changes === 1) {
        receipts.push({ commandId: ack.commandId, status: "accepted" });
        // 终态结果形成审计事件，满足“设备实际结果可追溯”要求。
        if (terminalCommandStates.includes(ack.state))
          appendAuditWithin(db, {
            actorType: "device", actorId: deviceId, action: "command.ack", targetType: "command", targetId: ack.commandId,
            summary: `设备回报命令 ${existing.capability_id} 为 ${ack.state}`,
            details: { taskId: existing.task_id, state: ack.state, retried: willRetry },
          });
      } else if (existing.state === ack.state) {
        receipts.push({ commandId: ack.commandId, status: "already-recorded", state: existing.state });
      } else if (terminalCommandStates.includes(existing.state)) {
        // 命令已终态且与本次回报冲突：保留原结果并告警，避免“取消后成功”被静默丢弃。
        receipts.push({ commandId: ack.commandId, status: "rejected", reason: "terminal-conflict", state: existing.state });
        appendAuditWithin(db, {
          actorType: "device", actorId: deviceId, action: "command.ack.conflict", targetType: "command", targetId: ack.commandId,
          summary: `命令 ${ack.commandId} 已为 ${existing.state}，拒绝覆盖为 ${ack.state}`,
          details: { taskId: existing.task_id, reportedState: ack.state, currentState: existing.state },
        });
      } else {
        receipts.push({ commandId: ack.commandId, status: "already-recorded", state: existing.state });
      }
    }

    // 统一推进器：scheduled 到期、取消传播、expired、租约回收、重试、失败阈值、批次与聚合。
    advanceTaskState(db, seenAt);
    const commands = claimCommandsForDevice(db, deviceId, 20, seenAt, { advance: false });

    // 点名名单：与策略同源地在事务内解析，保证响应正文与缓存重放逐字节一致。
    const rollCall = resolveRollCallForDevice(db, deviceId);
    const policy = resolvePolicyForDeviceFromDb(db, deviceId);
    policy.document = materializeConfigReferences(policy.document) as Record<string, unknown>;
    const policyDocument = canonicalJson(policy.document);
    const policyHash = sha256(policyDocument);
    // desired(epoch/revision/hash) 与客户端 applied(epoch/revision/hash) 不一致时重下发；
    // epoch 单调递增，因此“有效修订回退”（如去标签 R10 → R1）也能被识别。
    // 用 !== 而非 >：数据集恢复可能让服务端 epoch 低于设备已应用值，此时同样必须重同步。
    const policyChanged = policy.epoch !== input.policyEpoch
      || policy.revision > input.policyRevision
      || policyHash !== input.policyHash;
    const reportedEpoch = input.policyEpoch ?? 0;
    const reportedRevision = input.policyRevision ?? 0;
    const reportedHash = input.policyHash ?? "";
    const reportedDrift = input.driftCount ?? 0;
    // 设备回报的已应用策略与期望完全一致且无漂移：记录一次收敛事件（同一哈希只记一次）。
    const converged = reportedEpoch === policy.epoch && reportedRevision === policy.revision && reportedHash === policyHash && reportedDrift === 0;
    if (converged && current.appliedPolicyHash !== policyHash)
      appendAuditWithin(db, {
        actorType: "device", actorId: deviceId, action: "policy.applied", targetType: "device", targetId: deviceId,
        summary: `设备已应用策略 R${policy.revision}`,
        details: { epoch: policy.epoch, revision: policy.revision, documentHash: policyHash },
      });
    // 未收敛且设备的已应用状态发生变化时记录漂移，避免每轮轮询重复刷屏。
    else if (!converged && (reportedHash !== (current.appliedPolicyHash ?? "") || reportedDrift > current.driftCount))
      appendAuditWithin(db, {
        actorType: "device", actorId: deviceId, action: "policy.drift", targetType: "device", targetId: deviceId,
        summary: `设备策略未收敛（已应用 R${reportedRevision}，期望 R${policy.revision}）`,
        details: { reportedEpoch, reportedRevision, reportedHash, reportedDrift, desiredEpoch: policy.epoch, desiredRevision: policy.revision, desiredHash: policyHash },
      });
    // 课表上传：携带全量快照时覆盖写入存档（摘要不符直接拒绝）；
    // 仅报摘要时检查服务端是否已对齐，未对齐则要求设备重传全量。
    let timetableRequired = false;
    if (input.timetable !== undefined) {
      upsertDeviceTimetable(db, deviceId, { digest: input.timetableDigest, timetable: input.timetable }, seenAt);
    } else if (input.timetableDigest !== undefined) {
      timetableRequired = !timetableDigestMatches(db, deviceId, input.timetableDigest);
    }
    const responseBody = JSON.stringify({
      serverTimeUtc: seenAt,
      // 连接模式随每次响应回带：管理端改动后，设备在下一轮就自动切换传输。
      transport: current.transport,
      nextPollSeconds: commands.length ? 5 : input.driftCount ? 15 : 30,
      // 课表重传要求：客户端据此决定下一轮是否携带全量快照。
      timetableRequired,
      // 逐条回执：设备只删除被明确接受的 ACK，冲突结果保留并告警。
      acknowledgements: receipts,
      // 点名名单：仅在设备手上的修订过期时回带整份名单，避免每轮重复下发。
      rollcall: rollCall.revision === (input.rollCallRevision ?? 0)
        ? null
        : { revision: rollCall.revision, names: rollCall.names },
      policy: policyChanged
        ? { revision: policy.revision, epoch: policy.epoch, document: policy.document, locks: policy.locks, documentHash: policyHash }
        : null,
      commands: commands.map((command: { id: string; capability_id: string; payload: string; not_before: string; expires_at: string; max_attempts: number }) => ({
        commandId: command.id, capabilityId: command.capability_id, payload: JSON.parse(command.payload),
        notBeforeUtc: command.not_before, expiresAtUtc: command.expires_at, schemaVersion: 1, maxAttempts: command.max_attempts,
      })),
    });
    const signed = sign(responseBody);
    db.prepare(`INSERT INTO device_responses (device_id,sequence,request_hash,response_body,response_key_id,response_signature,created_at)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(device_id,sequence) DO UPDATE SET request_hash=excluded.request_hash,response_body=excluded.response_body,response_key_id=excluded.response_key_id,response_signature=excluded.response_signature,created_at=excluded.created_at`)
      .run(deviceId, sequence, requestHash, responseBody, signed.keyId, signed.signature, seenAt);
    // 只保留最近若干条，避免序列无限增长撑大响应缓存。
    db.prepare("DELETE FROM device_responses WHERE device_id=? AND sequence<?").run(deviceId, sequence - (RESPONSE_RETENTION - 1));
    return { body: responseBody, keyId: signed.keyId, signature: signed.signature, replayed: false };
  });
  return transaction.immediate();
}