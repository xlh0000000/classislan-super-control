import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { migrate } from "../server/migrations";
import { createBackup, DATABASE_FILE_NAME, restoreBackup, verifyBackup } from "../server/utils/backup";

const dirs: string[] = [];
function tempDir(prefix: string) {
  const directory = mkdtempSync(resolve(tmpdir(), prefix));
  dirs.push(directory);
  return directory;
}
afterEach(() => {
  for (const directory of dirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function seedDataDir() {
  const dataDir = tempDir("cic-backup-");
  const db = new Database(resolve(dataDir, DATABASE_FILE_NAME));
  db.pragma("journal_mode = WAL");
  migrate(db);
  db.prepare("INSERT INTO system_state (key,value,updated_at) VALUES ('seed','1',?)").run("2026-09-11T00:00:00.000Z");
  writeFileSync(resolve(dataDir, "server-signing-private.pem"), "PRIVATE-KEY");
  writeFileSync(resolve(dataDir, "server-signing-public.der"), "PUBLIC-KEYS");
  return { dataDir, db };
}

describe("backup bundle", () => {
  it("creates a verifiable bundle containing database and signing identity", async () => {
    const { dataDir, db } = seedDataDir();
    const { directory, manifest } = await createBackup(db, { dataDir, signingKeyId: "key-1", now: "2026-09-11T00:00:00.000Z" });
    expect(manifest.schemaVersion).toBeGreaterThan(0);
    expect(manifest.signingKeyId).toBe("key-1");
    expect(manifest.files.map((file) => file.name)).toContain(DATABASE_FILE_NAME);
    expect(manifest.files.map((file) => file.name)).toContain("server-signing-private.pem");
    expect(verifyBackup(directory).ok).toBe(true);
    expect(verifyBackup(directory, "key-1").ok).toBe(true);
    expect(verifyBackup(directory, "other-key").ok).toBe(false);
    db.close();
  });

  it("detects tampered bundle content", async () => {
    const { dataDir, db } = seedDataDir();
    const { directory } = await createBackup(db, { dataDir, signingKeyId: "key-1" });
    writeFileSync(resolve(directory, "server-signing-public.der"), "HACKED-KEYS");
    const result = verifyBackup(directory);
    expect(result.ok).toBe(false);
    expect(result.reasons.join(" ")).toContain("哈希不符");
    db.close();
  });

  it("restores a verified bundle into a fresh data directory", async () => {
    const { dataDir, db } = seedDataDir();
    const { directory } = await createBackup(db, { dataDir, signingKeyId: "key-1" });
    db.close();
    const target = tempDir("cic-restore-");
    const { restored, stashDir } = restoreBackup(directory, { dataDir: target });
    expect(restored).toContain(DATABASE_FILE_NAME);
    const restoredDb = new Database(resolve(target, DATABASE_FILE_NAME), { readonly: true, fileMustExist: true });
    const row = restoredDb.prepare("SELECT value FROM system_state WHERE key='seed'").get() as { value: string };
    expect(row.value).toBe("1");
    restoredDb.close();
    expect(readFileSync(resolve(target, "server-signing-private.pem"), "utf8")).toBe("PRIVATE-KEY");
    expect(stashDir).toContain(".restore-stash-");
  });

  it("refuses to restore a tampered bundle", async () => {
    const { dataDir, db } = seedDataDir();
    const { directory } = await createBackup(db, { dataDir, signingKeyId: "key-1" });
    db.close();
    writeFileSync(resolve(directory, "server-signing-public.der"), "HACKED-KEYS");
    const target = tempDir("cic-restore-");
    expect(() => restoreBackup(directory, { dataDir: target })).toThrow(/备份校验失败/);
  });
});