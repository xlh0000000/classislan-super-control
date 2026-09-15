import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../server/migrations";
import { advanceTaskState, batchSizes, claimCommandsForDevice, evaluateIdempotency, findIdempotentTask, isUniqueConstraintError } from "../server/utils/tasks";

const NOW = "2026-09-11T00:00:00.000Z";
const FUTURE = "2026-09-11T01:00:00.000Z";
const PAST = "2026-09-10T23:00:00.000Z";

function createDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function seedDevice(db: Database.Database, id: string) {
  db.prepare("INSERT INTO devices (id,name,public_key_jwk,key_thumbprint,created_at) VALUES (?,?,?,?,?)")
    .run(id, `设备 ${id}`, "{}", `thumb-${id}`, NOW);
}

function seedTask(db: Database.Database, overrides: Partial<{ id: string; state: string; mode: string; scheduledAt: string | null; expiresAt: string; failureThreshold: number; maxConcurrency: number; cancelRequested: number }> = {}) {
  const id = overrides.id ?? "task-1";
  db.prepare(`INSERT INTO tasks
    (id,name,capability_id,state,payload,scheduled_at,expires_at,created_by,created_at,updated_at,
     mode,batch_size,percent,failure_threshold,max_concurrency,cancel_requested,idempotency_key,target_snapshot)
    VALUES (?,?,?,?,?,?,?,NULL,?,?,?,NULL,NULL,?,?,?,NULL,'[]')`)
    .run(id, "测试任务", "profile.apply.v1", overrides.state ?? "running", "{}",
      overrides.scheduledAt === undefined ? null : overrides.scheduledAt, overrides.expiresAt ?? FUTURE,
      NOW, NOW, overrides.mode ?? "all", overrides.failureThreshold ?? 0, overrides.maxConcurrency ?? 0, overrides.cancelRequested ?? 0);
  return id;
}

function seedCommand(db: Database.Database, overrides: { id: string; taskId: string; deviceId: string; state: string; notBefore?: string; expiresAt?: string; leaseUntil?: string | null; attemptCount?: number; maxAttempts?: number; nextAttemptAt?: string | null }) {
  db.prepare(`INSERT INTO commands
    (id,task_id,device_id,capability_id,payload,not_before,expires_at,state,attempt_count,lease_until,max_attempts,next_attempt_at,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(overrides.id, overrides.taskId, overrides.deviceId, "profile.apply.v1", "{}",
      overrides.notBefore ?? PAST, overrides.expiresAt ?? FUTURE, overrides.state, overrides.attemptCount ?? 0, overrides.leaseUntil ?? null,
      overrides.maxAttempts ?? 1, overrides.nextAttemptAt ?? null, NOW);
}

function commandState(db: Database.Database, id: string) {
  return (db.prepare("SELECT state FROM commands WHERE id=?").get(id) as { state: string }).state;
}

function taskState(db: Database.Database, id: string) {
  return (db.prepare("SELECT state, cancel_requested, last_error FROM tasks WHERE id=?").get(id) as { state: string; cancel_requested: number; last_error: string | null });
}

describe("batchSizes", () => {
  it("returns a single batch for all-mode", () => {
    expect(batchSizes(120, "all", null, null)).toEqual([120]);
    expect(batchSizes(0, "all", null, null)).toEqual([0]);
  });

  it("splits into fixed-size batches with a remainder", () => {
    expect(batchSizes(100, "fixed", 30, null)).toEqual([30, 30, 30, 10]);
  });

  it("splits by percentage into ceil-sized batches", () => {
    expect(batchSizes(100, "percent", null, 25)).toEqual([25, 25, 25, 25]);
    expect(batchSizes(10, "percent", null, 30)).toEqual([3, 3, 3, 1]);
  });
});

describe("advanceTaskState", () => {
  it("promotes a due scheduled task to running", () => {
    const db = createDb();
    seedTask(db, { state: "scheduled", scheduledAt: PAST });
    advanceTaskState(db, NOW);
    expect(taskState(db, "task-1").state).toBe("running");
  });

  it("expires commands past their ttl", () => {
    const db = createDb();
    seedDevice(db, "d1");
    seedTask(db);
    seedCommand(db, { id: "c1", taskId: "task-1", deviceId: "d1", state: "pending", expiresAt: PAST });
    advanceTaskState(db, NOW);
    expect((db.prepare("SELECT state FROM commands WHERE id='c1'").get() as { state: string }).state).toBe("expired");
  });

  it("recycles an offered command whose lease has lapsed", () => {
    const db = createDb();
    seedDevice(db, "d1");
    seedTask(db);
    seedCommand(db, { id: "c1", taskId: "task-1", deviceId: "d1", state: "offered", leaseUntil: PAST });
    advanceTaskState(db, NOW);
    const row = db.prepare("SELECT state, lease_until FROM commands WHERE id='c1'").get() as { state: string; lease_until: string | null };
    expect(row.state).toBe("pending");
    expect(row.lease_until).toBeNull();
  });

  it("completes a task once every command succeeded", () => {
    const db = createDb();
    seedDevice(db, "d1");
    seedTask(db);
    seedCommand(db, { id: "c1", taskId: "task-1", deviceId: "d1", state: "succeeded" });
    advanceTaskState(db, NOW);
    expect(taskState(db, "task-1").state).toBe("completed");
  });

  it("marks a task partially failed when some commands failed", () => {
    const db = createDb();
    seedDevice(db, "d1");
    seedDevice(db, "d2");
    seedTask(db);
    seedCommand(db, { id: "c1", taskId: "task-1", deviceId: "d1", state: "succeeded" });
    seedCommand(db, { id: "c2", taskId: "task-1", deviceId: "d2", state: "failed" });
    advanceTaskState(db, NOW);
    expect(taskState(db, "task-1").state).toBe("partial_failure");
  });

  it("cancels remaining commands once the failure threshold is reached", () => {
    const db = createDb();
    seedDevice(db, "d1");
    seedDevice(db, "d2");
    seedDevice(db, "d3");
    seedTask(db, { failureThreshold: 50 });
    seedCommand(db, { id: "c1", taskId: "task-1", deviceId: "d1", state: "succeeded" });
    seedCommand(db, { id: "c2", taskId: "task-1", deviceId: "d2", state: "failed" });
    seedCommand(db, { id: "c3", taskId: "task-1", deviceId: "d3", state: "pending" });
    advanceTaskState(db, NOW);
    const task = taskState(db, "task-1");
    expect(task.cancel_requested).toBe(1);
    expect(task.last_error).toContain("阈值");
    expect((db.prepare("SELECT state FROM commands WHERE id='c3'").get() as { state: string }).state).toBe("cancelled");
  });

  it("freezes command ttl while the task is paused", () => {
    const db = createDb();
    seedDevice(db, "d1");
    seedTask(db, { state: "paused" });
    seedCommand(db, { id: "c1", taskId: "task-1", deviceId: "d1", state: "pending", expiresAt: PAST });
    advanceTaskState(db, NOW);
    expect(commandState(db, "c1")).toBe("pending");
  });

  it("retries a failed command only after its backoff elapses", () => {
    const db = createDb();
    seedDevice(db, "d1");
    seedTask(db);
    seedCommand(db, { id: "c1", taskId: "task-1", deviceId: "d1", state: "failed", attemptCount: 1, maxAttempts: 2, nextAttemptAt: FUTURE });
    advanceTaskState(db, NOW);
    expect(commandState(db, "c1")).toBe("failed");
    db.prepare("UPDATE commands SET next_attempt_at=? WHERE id='c1'").run(PAST);
    advanceTaskState(db, NOW);
    expect(commandState(db, "c1")).toBe("pending");
  });

  it("does not retry a failed command beyond max attempts", () => {
    const db = createDb();
    seedDevice(db, "d1");
    seedTask(db);
    seedCommand(db, { id: "c1", taskId: "task-1", deviceId: "d1", state: "failed", attemptCount: 2, maxAttempts: 2, nextAttemptAt: PAST });
    advanceTaskState(db, NOW);
    expect(commandState(db, "c1")).toBe("failed");
  });

  it("terminates cancelling commands once their lease lapses", () => {
    const db = createDb();
    seedDevice(db, "d1");
    seedTask(db, { state: "cancelling", cancelRequested: 1 });
    seedCommand(db, { id: "c1", taskId: "task-1", deviceId: "d1", state: "cancelling", leaseUntil: PAST });
    advanceTaskState(db, NOW);
    expect(commandState(db, "c1")).toBe("cancelled");
  });
});

describe("claimCommandsForDevice", () => {
  it("offers pending commands, increments attempts and sets a lease", () => {
    const db = createDb();
    seedDevice(db, "d1");
    seedTask(db);
    seedCommand(db, { id: "c1", taskId: "task-1", deviceId: "d1", state: "pending" });
    const claimed = claimCommandsForDevice(db, "d1", 20, NOW);
    expect(claimed).toHaveLength(1);
    const row = db.prepare("SELECT state, attempt_count, lease_until FROM commands WHERE id='c1'").get() as { state: string; attempt_count: number; lease_until: string | null };
    expect(row.state).toBe("offered");
    expect(row.attempt_count).toBe(1);
    expect(row.lease_until).not.toBeNull();
  });

  it("does not claim commands scheduled for the future", () => {
    const db = createDb();
    seedDevice(db, "d1");
    seedTask(db);
    seedCommand(db, { id: "c1", taskId: "task-1", deviceId: "d1", state: "pending", notBefore: FUTURE });
    expect(claimCommandsForDevice(db, "d1", 20, NOW)).toEqual([]);
  });

  it("respects max concurrency for the task", () => {
    const db = createDb();
    seedDevice(db, "d1");
    seedDevice(db, "d2");
    seedTask(db, { maxConcurrency: 1 });
    seedCommand(db, { id: "c1", taskId: "task-1", deviceId: "d1", state: "running" });
    seedCommand(db, { id: "c2", taskId: "task-1", deviceId: "d2", state: "pending" });
    expect(claimCommandsForDevice(db, "d2", 20, NOW)).toEqual([]);
  });

  it("activates the next batch after the active one succeeds", () => {
    const db = createDb();
    seedDevice(db, "d1");
    seedDevice(db, "d2");
    seedTask(db, { mode: "fixed" });
    db.prepare("INSERT INTO task_batches (id,task_id,batch_index,device_ids,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
      .run("b0", "task-1", 0, JSON.stringify(["d1"]), "succeeded", NOW, NOW);
    db.prepare("INSERT INTO task_batches (id,task_id,batch_index,device_ids,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
      .run("b1", "task-1", 1, JSON.stringify(["d2"]), "pending", NOW, NOW);
    advanceTaskState(db, NOW);
    expect((db.prepare("SELECT state FROM task_batches WHERE id='b1'").get() as { state: string }).state).toBe("active");
    const created = db.prepare("SELECT COUNT(*) count FROM commands WHERE task_id='task-1'").get() as { count: number };
    expect(created.count).toBe(1);
  });

  it("never offers commands for a cancelled task", () => {
    const db = createDb();
    seedDevice(db, "d1");
    seedTask(db, { state: "cancelled", cancelRequested: 1 });
    seedCommand(db, { id: "c1", taskId: "task-1", deviceId: "d1", state: "pending" });
    expect(claimCommandsForDevice(db, "d1", 20, NOW)).toEqual([]);
    expect(commandState(db, "c1")).toBe("cancelled");
  });

  it("does not re-offer a command after a concurrent cancel even without re-advancing", () => {
    const db = createDb();
    seedDevice(db, "d1");
    seedTask(db, { state: "cancelling", cancelRequested: 1 });
    seedCommand(db, { id: "c1", taskId: "task-1", deviceId: "d1", state: "pending" });
    // poll 路径：ACK + 推进已在同一事务内完成，claim 只做条件领取。
    expect(claimCommandsForDevice(db, "d1", 20, NOW, { advance: false })).toEqual([]);
    expect(commandState(db, "c1")).toBe("pending");
  });
});
describe("task idempotency scoping", () => {
  function seedUser(db: Database.Database, id: string) {
    db.prepare("INSERT INTO users (id,username,password_hash,display_name,role,created_at) VALUES (?,?,?,?,?,?)")
      .run(id, `user-${id}`, "hash", id, "operator", NOW);
  }

  function seedIdempotentTask(db: Database.Database, overrides: { id: string; actorId: string | null; key: string; hash: string }) {
    db.prepare(`INSERT INTO tasks
      (id,name,capability_id,state,payload,scheduled_at,expires_at,created_by,created_at,updated_at,
       mode,failure_threshold,max_concurrency,cancel_requested,idempotency_key,idempotency_actor_id,idempotency_request_hash,target_snapshot)
      VALUES (?,?,?,?,?,NULL,?,NULL,?,?,?,0,0,0,?,?,?,'[]')`)
      .run(overrides.id, "幂等任务", "profile.apply.v1", "running", "{}", FUTURE, NOW, NOW, "all",
        overrides.key, overrides.actorId, overrides.hash);
  }

  it("replays only when the same key maps to the same request hash", () => {
    expect(evaluateIdempotency(undefined, "h1")).toEqual({ kind: "none" });
    const record = { id: "t1", state: "running", requestHash: "h1" };
    expect(evaluateIdempotency(record, "h1")).toEqual({ kind: "replay", task: record });
    expect(evaluateIdempotency(record, "h2")).toEqual({ kind: "conflict" });
  });

  it("treats legacy rows without a stored hash as replayable", () => {
    const legacy = { id: "t1", state: "running", requestHash: null };
    expect(evaluateIdempotency(legacy, "h1")).toEqual({ kind: "replay", task: legacy });
  });

  it("scopes idempotency keys per actor and rejects a duplicate key for the same actor", () => {
    const db = createDb();
    seedUser(db, "u1");
    seedUser(db, "u2");
    seedIdempotentTask(db, { id: "t1", actorId: "u1", key: "k1", hash: "h1" });
    try {
      seedIdempotentTask(db, { id: "t2", actorId: "u1", key: "k1", hash: "h1" });
      throw new Error("expected duplicate idempotency key to be rejected");
    } catch (error) {
      expect(isUniqueConstraintError(error)).toBe(true);
    }
    // 另一个调用者复用同一字符串键互不影响。
    seedIdempotentTask(db, { id: "t3", actorId: "u2", key: "k1", hash: "h9" });
    expect(findIdempotentTask(db, "u1", "k1")).toEqual({ id: "t1", state: "running", requestHash: "h1" });
    expect(findIdempotentTask(db, "u1", "missing")).toBeUndefined();
    expect(findIdempotentTask(db, "u3", "k1")).toBeUndefined();
  });

  it("rejects a duplicate command for the same task and device", () => {
    const db = createDb();
    seedDevice(db, "d1");
    seedTask(db);
    seedCommand(db, { id: "c1", taskId: "task-1", deviceId: "d1", state: "pending" });
    try {
      seedCommand(db, { id: "c2", taskId: "task-1", deviceId: "d1", state: "pending" });
      throw new Error("expected duplicate command to be rejected");
    } catch (error) {
      expect(isUniqueConstraintError(error)).toBe(true);
    }
    // 同一设备在另一个任务中仍可创建命令。
    seedTask(db, { id: "task-2" });
    seedCommand(db, { id: "c3", taskId: "task-2", deviceId: "d1", state: "pending" });
    expect((db.prepare("SELECT COUNT(*) count FROM commands").get() as { count: number }).count).toBe(2);
  });
});