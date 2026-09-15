import { afterAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { migrations, schemaFingerprint } from "../server/migrations";

// 多进程并发迁移无法在同一线程内真实复现（better-sqlite3 是同步的），
// 因此用子进程同时抢同一个全新数据库文件，验证 BEGIN IMMEDIATE 串行化与锁内重读。
const workDir = mkdtempSync(join(tmpdir(), "cic-concurrent-migrate-"));
const dbPath = join(workDir, "control.db");
const workerPath = join(process.cwd(), "tests", "helpers", "migrate-worker.ts");
const workerCount = 8;

function runWorker() {
  return new Promise<number>((resolve) => {
    const child = spawn(process.execPath, [workerPath, dbPath], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("exit", (code) => {
      if (code !== 0) console.error(stderr.trim());
      resolve(code ?? -1);
    });
  });
}

afterAll(() => rmSync(workDir, { recursive: true, force: true }));

describe("concurrent migrations", () => {
  it("serializes many processes starting against the same fresh database", async () => {
    const codes = await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
    expect(codes).toEqual(Array(workerCount).fill(0));

    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const rows = db.prepare("SELECT id, checksum FROM schema_migrations ORDER BY id").all() as { id: string; checksum: string }[];
    const fingerprint = schemaFingerprint(db);
    db.close();

    // 每个迁移恰好记录一次，顺序与程序内清单一致。
    expect(rows.map((row) => row.id)).toEqual(migrations.map((migration) => migration.id));
    expect(new Set(rows.map((row) => row.id)).size).toBe(migrations.length);
    // 全部成功后最终 schema 必须与最后一条记录指纹一致（服务端启动时同样校验）。
    expect(rows.at(-1)?.checksum).toBe(fingerprint);
  }, 30000);
});