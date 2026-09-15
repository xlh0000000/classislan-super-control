import { createPublicKey, verify as verifySignature } from "node:crypto";
import type Database from "better-sqlite3";
import type { H3Event } from "h3";
import { getHeader, readRawBody } from "h3";
import { canonicalJson, sha256 } from "./security";
import { useDatabase } from "./database";

export type AuthenticatedDeviceRequest = {
  rawBody: string;
  deviceId: string;
  sequence: number;
  timestampUtc: string;
  requestHash: string;
  /** 服务端当前已提交的序列，用于判定严格 last+1 或同序列重放。 */
  deviceLastSequence: number;
};

/**
 * 设备签名信封覆盖的请求行。HTTP 轮询与 WebSocket 长连接携带完全相同的信封，
 * 因此两种传输共用同一套序列、重放与响应缓存保护，服务端只需维护一份实现。
 */
export const DEVICE_POLL_METHOD = "POST";
export const DEVICE_POLL_PATH = "/api/v1/agent/poll";

function signaturePayload(
  method: string,
  path: string,
  deviceId: string,
  sequence: number,
  timestampUtc: string,
  bodyHash: string,
) {
  return [method.toUpperCase(), path, deviceId, sequence, timestampUtc, bodyHash].join("\n");
}

export async function readAuthenticatedDeviceRequest(
  event: H3Event,
): Promise<AuthenticatedDeviceRequest> {
  const rawBody = (await readRawBody(event, "utf8")) || "";
  return verifyDeviceRequestEnvelope(useDatabase(), {
    deviceId: getHeader(event, "x-device-id") || "",
    sequence: Number(getHeader(event, "x-device-sequence") || ""),
    timestampUtc: getHeader(event, "x-device-timestamp") || "",
    signature: getHeader(event, "x-device-signature") || "",
    rawBody,
  });
}

/**
 * 校验一份设备签名信封。
 *
 * 长连接不在消息头部承载身份，因此这里把头部与正文里的同等字段收敛成一个入口：
 * 两种传输都提交相同的签名负载（POST /api/v1/agent/poll），签名与摘要一致才放行。
 * 重放与序列窗口在这里只做前置检查，最终判定仍由同一事务内的 processDevicePoll 完成。
 */
export function verifyDeviceRequestEnvelope(
  db: Database.Database,
  input: {
    deviceId: string;
    sequence: number;
    timestampUtc: string;
    signature: string;
    rawBody: string;
  },
): AuthenticatedDeviceRequest {
  const { deviceId, sequence, timestampUtc, signature, rawBody } = input;
  if (!deviceId || !Number.isSafeInteger(sequence) || sequence <= 0 || !timestampUtc || !signature)
    throw createError({ statusCode: 401, message: "缺少设备请求签名。" });

  const timestamp = Date.parse(timestampUtc);
  if (!Number.isFinite(timestamp) || Math.abs(Date.now() - timestamp) > 5 * 60_000)
    throw createError({ statusCode: 401, message: "设备请求时间超出允许范围。" });

  const device = db
    .prepare("SELECT public_key_jwk publicKeyJwk, last_sequence lastSequence, last_request_hash lastRequestHash FROM devices WHERE id=? AND disabled_at IS NULL")
    .get(deviceId) as { publicKeyJwk: string; lastSequence: number; lastRequestHash: string | null } | undefined;
  if (!device) throw createError({ statusCode: 401, message: "未知或已禁用的设备。" });
  // 只允许 (last_sequence, last_sequence+1] 窗口：同序列按摘要重放，新请求严格 last+1，
  // 超出该窗口的跳号一律拒绝，避免命令/响应缓存出现空洞。
  if (sequence > device.lastSequence + 1)
    throw createError({ statusCode: 409, message: "设备请求序列超出允许窗口。" });

  if (Buffer.byteLength(rawBody) > 256 * 1024)
    throw createError({ statusCode: 413, message: "设备请求超过大小限制。" });
  const bodyForSignature = JSON.parse(rawBody) as Record<string, unknown>;
  const signedBodyHash = bodyForSignature.signedBodyHash;
  const embeddedSignature = bodyForSignature.signature;
  delete bodyForSignature.signedBodyHash;
  delete bodyForSignature.signature;
  if (typeof signedBodyHash !== "string" || typeof embeddedSignature !== "string" || embeddedSignature !== signature)
    throw createError({ statusCode: 401, message: "轮询正文缺少签名。" });
  const canonicalBody = canonicalJson(bodyForSignature);
  const bodyHash = sha256(canonicalBody);
  if (bodyHash !== signedBodyHash)
    throw createError({ statusCode: 401, message: "轮询正文摘要不匹配。" });
  if (sequence === device.lastSequence && device.lastRequestHash !== bodyHash)
    throw createError({ statusCode: 409, message: "设备请求序列已绑定其他正文。" });
  let publicKey;
  try {
    publicKey = createPublicKey({ key: JSON.parse(device.publicKeyJwk), format: "jwk" });
  } catch {
    throw createError({ statusCode: 401, message: "设备公钥无效。" });
  }
  const valid = verifySignature(
    "sha256",
    Buffer.from(signaturePayload(DEVICE_POLL_METHOD, DEVICE_POLL_PATH, deviceId, sequence, timestampUtc, bodyHash)),
    { key: publicKey, dsaEncoding: "ieee-p1363" },
    Buffer.from(signature, "base64url"),
  );
  if (!valid) throw createError({ statusCode: 401, message: "设备请求签名无效。" });
  return { rawBody: canonicalBody, deviceId, sequence, timestampUtc, requestHash: bodyHash, deviceLastSequence: device.lastSequence };
}

export function calculateJwkThumbprint(jwk: import("node:crypto").JsonWebKey) {
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y || jwk.d)
    throw createError({ statusCode: 400, message: "仅接受不含私钥的 P-256 公钥。" });
  try {
    createPublicKey({ key: jwk, format: "jwk" });
  } catch {
    throw createError({ statusCode: 400, message: "设备公钥格式或曲线点无效。" });
  }
  const canonical = JSON.stringify({ crv: "P-256", kty: "EC", x: jwk.x, y: jwk.y });
  return Buffer.from(sha256(canonical), "hex").toString("base64url");
}