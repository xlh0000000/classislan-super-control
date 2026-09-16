import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";

type HttpError = Error & { statusCode?: number; data?: unknown };
(globalThis as unknown as { createError: (opts: { statusCode: number; message: string; data?: unknown }) => HttpError }).createError =
  (opts) => Object.assign(new Error(opts.message), { statusCode: opts.statusCode, data: opts.data });

import { migrate } from "../server/migrations";
import { processDevicePoll, type DevicePollInput } from "../server/utils/device-poll";
import { canonicalJson, sha256 } from "../server/utils/security";
import type { AuthenticatedDeviceRequest } from "../server/utils/device-auth";

const NOW = "2026-09-11T00:00:00.000Z";
const DEVICE_ID = "2e64dbad-e2f3-49f3-9629-1bb4681fffb6";

function createDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function seedDevice(db: Database.Database, lastSequence = 0, lastRequestHash: string | null = null) {
  db.prepare("INSERT INTO devices (id,name,public_key_jwk,key_thumbprint,last_sequence,last_request_hash,created_at) VALUES (?,?,?,?,?,?,?)")
    .run(DEVICE_ID, "设备", "{}", "thumb-1", lastSequence, lastRequestHash, NOW);
}

function auth(sequence: number, requestHash: string, lastSequence: number): AuthenticatedDeviceRequest {
  return { rawBody: "{}", deviceId: DEVICE_ID, sequence, timestampUtc: NOW, requestHash, deviceLastSequence: lastSequence };
}

function input(sequence: number): DevicePollInput {
  return {
    deviceId: DEVICE_ID, sequence, timestampUtc: NOW, pluginVersion: "0.1.0", appVersion: "2.1.1.1",
    platform: "Windows/x64", capabilityDigest: "cap-1", policyRevision: 0, policyEpoch: 0, policyHash: "",
    driftCount: 0, acknowledgements: [], crashes: [],
  };
}

function countingSigner() {
  let calls = 0;
  return {
    signer: (body: string) => ({ keyId: "test-key", signature: `sig-${++calls}-${body.length}` }),
    calls: () => calls,
  };
}

function expectStatus(run: () => unknown, statusCode: number) {
  try {
    run();
    throw new Error("expected poll to fail");
  } catch (error) {
    expect((error as HttpError).statusCode).toBe(statusCode);
  }
}

function responseCount(db: Database.Database) {
  return (db.prepare("SELECT COUNT(*) count FROM device_responses").get() as { count: number }).count;
}

function policyAuditActions(db: Database.Database) {
  return (db.prepare("SELECT action FROM audit_events WHERE action LIKE 'policy.%' ORDER BY sequence").all() as { action: string }[]).map((row) => row.action);
}

describe("device poll response replay", () => {
  it("replays the exact cached signed response for the same sequence and body hash", () => {
    const db = createDb();
    seedDevice(db);
    const { signer, calls } = countingSigner();
    const first = processDevicePoll(db, auth(1, "hash-1", 0), input(1), NOW, signer);
    expect(first.replayed).toBe(false);
    expect(calls()).toBe(1);

    const replay = processDevicePoll(db, auth(1, "hash-1", 1), input(1), NOW, signer);
    expect(replay.replayed).toBe(true);
    expect(replay.body).toBe(first.body);
    expect(replay.signature).toBe(first.signature);
    // 重放不得重新执行/重新签名：签名器只应被调用一次。
    expect(calls()).toBe(1);
    expect(responseCount(db)).toBe(1);
  });

  it("rejects a different body hash for an already-issued sequence", () => {
    const db = createDb();
    seedDevice(db);
    const { signer } = countingSigner();
    processDevicePoll(db, auth(1, "hash-1", 0), input(1), NOW, signer);
    expectStatus(() => processDevicePoll(db, auth(1, "hash-2", 1), input(1), NOW, signer), 409);
  });

  it("序列落后时附带服务端权威序列，供设备本地状态被清空后一次性对齐", () => {
    const db = createDb();
    seedDevice(db, 41, "hash-41");
    const { signer } = countingSigner();
    try {
      processDevicePoll(db, auth(2, "hash-2", 0), input(2), NOW, signer);
      throw new Error("expected poll to fail");
    } catch (error) {
      expect((error as HttpError).statusCode).toBe(409);
      expect((error as HttpError).data).toEqual({ lastSequence: 41 });
    }
  });

  it("rejects sequence jumps instead of silently skipping numbers", () => {
    const db = createDb();
    seedDevice(db);
    const { signer } = countingSigner();
    expectStatus(() => processDevicePoll(db, auth(3, "hash-3", 0), input(3), NOW, signer), 409);
    expectStatus(() => processDevicePoll(db, auth(2, "hash-2", 0), input(2), NOW, signer), 409);
  });

  it("consumes strictly last+1 and advances the persisted sequence", () => {
    const db = createDb();
    seedDevice(db);
    const { signer } = countingSigner();
    processDevicePoll(db, auth(1, "hash-1", 0), input(1), NOW, signer);
    processDevicePoll(db, auth(2, "hash-2", 1), input(2), NOW, signer);
    const row = db.prepare("SELECT last_sequence lastSequence, last_request_hash lastRequestHash FROM devices WHERE id=?").get(DEVICE_ID) as { lastSequence: number; lastRequestHash: string };
    expect(row.lastSequence).toBe(2);
    expect(row.lastRequestHash).toBe("hash-2");
    expect(responseCount(db)).toBe(2);
  });

  it("prunes response rows beyond the retention window", () => {
    const db = createDb();
    seedDevice(db);
    const { signer } = countingSigner();
    for (let sequence = 1; sequence <= 40; sequence += 1)
      processDevicePoll(db, auth(sequence, `hash-${sequence}`, sequence - 1), input(sequence), NOW, signer);
    expect(responseCount(db)).toBe(16);
    expect(db.prepare("SELECT 1 FROM device_responses WHERE sequence=1").get()).toBeUndefined();
    expect(db.prepare("SELECT 1 FROM device_responses WHERE sequence=40").get()).toBeDefined();
  });

  it("audits policy convergence once and flags drift when the device reports it", () => {
    const db = createDb();
    seedDevice(db);
    const { signer } = countingSigner();
    const desiredHash = sha256(canonicalJson({}));
    // 首轮：设备报告与期望一致的已应用哈希，产生一条收敛事件。
    processDevicePoll(db, auth(1, "hash-1", 0), { ...input(1), policyHash: desiredHash }, NOW, signer);
    expect(policyAuditActions(db)).toEqual(["policy.applied"]);
    // 同一哈希重复上报不得刷屏。
    processDevicePoll(db, auth(2, "hash-2", 1), { ...input(2), policyHash: desiredHash }, NOW, signer);
    expect(policyAuditActions(db)).toEqual(["policy.applied"]);
    // 设备报告漂移计数上升时追加一条漂移事件。
    processDevicePoll(db, auth(3, "hash-3", 2), { ...input(3), policyHash: desiredHash, driftCount: 2 }, NOW, signer);
    expect(policyAuditActions(db)).toEqual(["policy.applied", "policy.drift"]);
    db.close();
  });
});

describe("task command end-to-end through device poll", () => {
  function seedTask(db: Database.Database) {
    db.prepare(`INSERT INTO tasks
      (id,name,capability_id,state,payload,scheduled_at,expires_at,created_by,created_at,updated_at,
       mode,batch_size,percent,failure_threshold,max_concurrency,cancel_requested,idempotency_key,target_snapshot)
      VALUES ('task-1','投递任务','profile.apply.v1','running','{}',NULL,'2026-09-11T02:00:00.000Z',NULL,?,?,?,NULL,NULL,0,0,0,NULL,'[]')`)
      .run(NOW, NOW, "all");
  }
  function seedCommand(db: Database.Database) {
    db.prepare(`INSERT INTO commands
      (id,task_id,device_id,capability_id,payload,not_before,expires_at,state,attempt_count,lease_until,max_attempts,next_attempt_at,created_at)
      VALUES ('cmd-1','task-1',?,?,?,?,?, 'pending',0,NULL,1,NULL,?)`)
      .run(DEVICE_ID, "profile.apply.v1", "{}", "2026-09-11T00:00:00.000Z", "2026-09-11T02:00:00.000Z", NOW);
  }
  function parse(result: { body: string }) {
    return JSON.parse(result.body) as {
      commands: { commandId: string }[];
      acknowledgements: { commandId: string; status: string }[];
    };
  }

  it("delivers a command, accepts the ACK, and aggregates the task to completed", () => {
    const db = createDb();
    seedDevice(db);
    seedTask(db);
    seedCommand(db);
    const { signer } = countingSigner();

    const delivered = processDevicePoll(db, auth(1, "hash-1", 0), input(1), NOW, signer);
    const firstBody = parse(delivered);
    expect(firstBody.commands.map((command) => command.commandId)).toEqual(["cmd-1"]);
    expect(firstBody.acknowledgements).toEqual([]);
    expect((db.prepare("SELECT state FROM commands WHERE id='cmd-1'").get() as { state: string }).state).toBe("offered");

    const acked = processDevicePoll(db, auth(2, "hash-2", 1), {
      ...input(2),
      acknowledgements: [{ commandId: "cmd-1", state: "succeeded", result: { ok: true } }],
    }, NOW, signer);
    expect(parse(acked).acknowledgements).toEqual([{ commandId: "cmd-1", status: "accepted" }]);
    expect((db.prepare("SELECT state FROM commands WHERE id='cmd-1'").get() as { state: string }).state).toBe("succeeded");
    expect((db.prepare("SELECT state FROM tasks WHERE id='task-1'").get() as { state: string }).state).toBe("completed");
    db.close();
  });
});