import { createPrivateKey, createPublicKey, randomUUID, sign, verify } from "node:crypto";
import type Database from "better-sqlite3";
import { nowIso } from "./database";
import { canonicalJson, sha256 } from "./security";
import { getServerSigningIdentity } from "./server-signing";

export type AuditCheckpoint = {
  id: string;
  sequence: number;
  eventHash: string;
  checkpointHash: string;
  keyId: string;
  signature: string;
  createdAt: string;
};

export type CheckpointSigner = (payload: string) => { keyId: string; signature: string };

function defaultSigner(payload: string): { keyId: string; signature: string } {
  const identity = getServerSigningIdentity();
  const signature = sign("sha256", Buffer.from(payload), {
    key: createPrivateKey(identity.privateKeyPem),
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return { keyId: identity.keyId, signature };
}

/** 检查点哈希绑定链头序列号与事件哈希，签名覆盖该哈希即可锚定整条链。 */
export function checkpointHash(sequence: number, eventHash: string): string {
  return sha256(canonicalJson({ sequence, eventHash }));
}

/** 用设备响应同一把服务端签名私钥为检查点签名，便于离线用已下发公钥校验。 */
export function signAuditCheckpoint(sequence: number, eventHash: string, signer: CheckpointSigner = defaultSigner) {
  const hash = checkpointHash(sequence, eventHash);
  const { keyId, signature } = signer(hash);
  return { checkpointHash: hash, keyId, signature };
}

/**
 * 链头相对已记录检查点前进时，签名写入一条新检查点；否则返回 null。
 * 检查点表只增不改，任何对历史事件的改写都会与既有检查点签名矛盾。
 */
export function writeAuditCheckpoint(
  db: Database.Database,
  now = nowIso(),
  signer: CheckpointSigner = defaultSigner,
): AuditCheckpoint | null {
  const head = db.prepare("SELECT sequence, event_hash eventHash FROM audit_events ORDER BY sequence DESC LIMIT 1")
    .get() as { sequence: number; eventHash: string } | undefined;
  if (!head) return null;
  const last = db.prepare("SELECT sequence FROM audit_checkpoints ORDER BY sequence DESC LIMIT 1").get() as { sequence: number } | undefined;
  if (last && head.sequence <= last.sequence) return null;
  const { checkpointHash: hash, keyId, signature } = signAuditCheckpoint(head.sequence, head.eventHash, signer);
  const row: AuditCheckpoint = {
    id: randomUUID(), sequence: head.sequence, eventHash: head.eventHash, checkpointHash: hash, keyId, signature, createdAt: now,
  };
  db.prepare(`INSERT INTO audit_checkpoints (id,sequence,event_hash,checkpoint_hash,key_id,signature,created_at)
    VALUES (@id,@sequence,@eventHash,@checkpointHash,@keyId,@signature,@createdAt)`).run(row);
  return row;
}

export function latestAuditCheckpoint(db: Database.Database): AuditCheckpoint | null {
  const row = db.prepare(`SELECT id,sequence,event_hash eventHash,checkpoint_hash checkpointHash,key_id keyId,signature,created_at createdAt
    FROM audit_checkpoints ORDER BY sequence DESC LIMIT 1`).get() as AuditCheckpoint | undefined;
  return row ?? null;
}

/** 用 base64(SPKI DER) 公钥校验检查点签名；行内容被改写时返回 false。 */
export function verifyAuditCheckpointSignature(checkpoint: AuditCheckpoint, publicKeyDerBase64: string): boolean {
  try {
    if (checkpointHash(checkpoint.sequence, checkpoint.eventHash) !== checkpoint.checkpointHash) return false;
    const publicKey = createPublicKey({ key: Buffer.from(publicKeyDerBase64, "base64"), format: "der", type: "spki" });
    return verify("sha256", Buffer.from(checkpoint.checkpointHash), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(checkpoint.signature, "base64url"));
  } catch {
    return false;
  }
}