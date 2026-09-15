import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { migrate } from "../server/migrations";
import { appendAuditWithin } from "../server/utils/security";
import { latestAuditCheckpoint, verifyAuditCheckpointSignature, writeAuditCheckpoint } from "../server/utils/audit-checkpoint";

const NOW = "2026-09-11T00:00:00.000Z";

function createDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function seedAudit(db: Database.Database, action: string) {
  return appendAuditWithin(db, { actorType: "system", action, targetType: "system", targetId: "t", summary: action });
}

function keyPair() {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const privatePem = pair.privateKey.export({ type: "pkcs8", format: "pem" }) as unknown as string;
  const publicDer = pair.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const signer = (payload: string) => ({
    keyId: "checkpoint-key",
    signature: sign("sha256", Buffer.from(payload), { key: createPrivateKey(privatePem), dsaEncoding: "ieee-p1363" }).toString("base64url"),
  });
  return { signer, publicDer };
}

describe("signed audit checkpoints", () => {
  it("signs the chain head and verifies with the matching public key", () => {
    const db = createDb();
    seedAudit(db, "a1");
    seedAudit(db, "a2");
    const { signer, publicDer } = keyPair();
    const checkpoint = writeAuditCheckpoint(db, NOW, signer);
    expect(checkpoint).not.toBeNull();
    expect(checkpoint!.sequence).toBe(2);
    expect(checkpoint!.keyId).toBe("checkpoint-key");
    expect(verifyAuditCheckpointSignature(checkpoint!, publicDer)).toBe(true);
    db.close();
  });

  it("only writes a new checkpoint once the chain head advances", () => {
    const db = createDb();
    seedAudit(db, "a1");
    const { signer } = keyPair();
    expect(writeAuditCheckpoint(db, NOW, signer)).not.toBeNull();
    expect(writeAuditCheckpoint(db, NOW, signer)).toBeNull();
    seedAudit(db, "a2");
    expect(writeAuditCheckpoint(db, NOW, signer)?.sequence).toBe(2);
    expect(latestAuditCheckpoint(db)?.sequence).toBe(2);
    db.close();
  });

  it("returns null for an empty audit chain", () => {
    const db = createDb();
    const { signer } = keyPair();
    expect(writeAuditCheckpoint(db, NOW, signer)).toBeNull();
    expect(latestAuditCheckpoint(db)).toBeNull();
    db.close();
  });

  it("rejects a rewritten checkpoint body and a foreign public key", () => {
    const db = createDb();
    seedAudit(db, "a1");
    const { signer, publicDer } = keyPair();
    const checkpoint = writeAuditCheckpoint(db, NOW, signer)!;
    expect(verifyAuditCheckpointSignature({ ...checkpoint, eventHash: "00".repeat(32) }, publicDer)).toBe(false);
    expect(verifyAuditCheckpointSignature(checkpoint, keyPair().publicDer)).toBe(false);
    db.close();
  });
});