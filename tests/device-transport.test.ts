import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign as signData, type JsonWebKey } from "node:crypto";

type HttpError = Error & { statusCode?: number; data?: unknown };
(globalThis as unknown as { createError: (opts: { statusCode: number; message: string; data?: unknown }) => HttpError }).createError =
  (opts) => Object.assign(new Error(opts.message), { statusCode: opts.statusCode, data: opts.data });

import { migrate } from "../server/migrations";
import { processDevicePoll, type DevicePollInput } from "../server/utils/device-poll";
import { DEVICE_POLL_METHOD, DEVICE_POLL_PATH, verifyDeviceRequestEnvelope } from "../server/utils/device-auth";
import { canonicalJson, sha256 } from "../server/utils/security";
import { deviceTransportSchema, policyPublishSchema, pollSchema, timeSectionSchema } from "../shared/schemas";

const NOW = new Date().toISOString();
const DEVICE_ID = "2e64dbad-e2f3-49f3-9629-1bb4681fffb6";

function createDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

/** 与设备端 ControlPlaneClient.SignPoll 完全一致的签名：JCS 规范正文摘要 + ECDSA P-256。 */
function signedEnvelope(privateKeyPem: string, body: Record<string, unknown>, sequence = 1) {
  const canonical = canonicalJson(body);
  const bodyHash = sha256(canonical);
  const payload = [DEVICE_POLL_METHOD, DEVICE_POLL_PATH, DEVICE_ID, sequence, NOW, bodyHash].join("\n");
  const signature = signData("sha256", Buffer.from(payload), {
    key: createPrivateKey(privateKeyPem), dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return JSON.stringify({ ...JSON.parse(canonical), signedBodyHash: bodyHash, signature });
}

function seedDevice(db: Database.Database, publicKeyJwk: string, transport = "http") {
  db.prepare("INSERT INTO devices (id,name,public_key_jwk,key_thumbprint,last_sequence,created_at,transport) VALUES (?,?,?,?,?,?,?)")
    .run(DEVICE_ID, "设备", publicKeyJwk, "thumb-1", 0, NOW, transport);
}

function pollInput(sequence = 1): DevicePollInput {
  return {
    deviceId: DEVICE_ID, sequence, timestampUtc: NOW, pluginVersion: "0.1.0", appVersion: "2.1.1.1",
    platform: "Windows/x64", capabilityDigest: "cap-1", policyRevision: 0, policyEpoch: 0, policyHash: "",
    driftCount: 0, acknowledgements: [], crashes: [],
  };
}

function keyMaterial() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    jwk: publicKey.export({ format: "jwk" }) as JsonWebKey,
  };
}

describe("设备连接模式", () => {
  it("轮询响应回带设备当前的连接模式", () => {
    const db = createDb();
    const { jwk } = keyMaterial();
    seedDevice(db, JSON.stringify(jwk), "websocket");
    const outcome = processDevicePoll(db, {
      rawBody: "{}", deviceId: DEVICE_ID, sequence: 1, timestampUtc: NOW, requestHash: "hash-1", deviceLastSequence: 0,
    }, pollInput(), NOW, (body) => ({ keyId: "k", signature: `sig-${body.length}` }));
    expect(JSON.parse(outcome.body).transport).toBe("websocket");
  });

  it("管理端只接受 http / websocket 两种模式", () => {
    expect(deviceTransportSchema.safeParse("http").success).toBe(true);
    expect(deviceTransportSchema.safeParse("websocket").success).toBe(true);
    expect(deviceTransportSchema.safeParse("quic").success).toBe(false);
    expect(deviceTransportSchema.safeParse(null).success).toBe(false);
  });
});

describe("WebSocket 与 HTTP 共用同一签名信封", () => {
  it("长连接信封通过同一入口验签并被轮询 schema 接受", () => {
    const db = createDb();
    const { privateKeyPem, jwk } = keyMaterial();
    seedDevice(db, JSON.stringify(jwk));
    const envelope = signedEnvelope(privateKeyPem, {
      deviceId: DEVICE_ID, sequence: 1, timestampUtc: NOW, pluginVersion: "0.1.0", appVersion: "2.1.1.1",
      platform: "Windows/x64", capabilityDigest: "cap-1", policyRevision: 0, policyEpoch: 0, policyHash: "",
      driftCount: 0, acknowledgements: [], crashes: [],
    });
    const authenticated = verifyDeviceRequestEnvelope(db, {
      deviceId: DEVICE_ID, sequence: 1, timestampUtc: NOW,
      signature: JSON.parse(envelope).signature, rawBody: envelope,
    });
    expect(authenticated.deviceId).toBe(DEVICE_ID);
    expect(pollSchema.safeParse(JSON.parse(envelope)).success).toBe(true);
  });

  it("篡改后的长连接信封被拒绝", () => {
    const db = createDb();
    const { privateKeyPem, jwk } = keyMaterial();
    seedDevice(db, JSON.stringify(jwk));
    const envelope = JSON.parse(signedEnvelope(privateKeyPem, {
      deviceId: DEVICE_ID, sequence: 1, timestampUtc: NOW, pluginVersion: "0.1.0", appVersion: "2.1.1.1",
      platform: "Windows/x64", capabilityDigest: "cap-1", policyRevision: 0, policyEpoch: 0, policyHash: "",
      driftCount: 0, acknowledgements: [], crashes: [],
    })) as Record<string, unknown>;
    envelope.policyRevision = 99;
    let statusCode: number | undefined;
    try {
      verifyDeviceRequestEnvelope(db, {
        deviceId: DEVICE_ID, sequence: 1, timestampUtc: NOW,
        signature: envelope.signature as string, rawBody: JSON.stringify(envelope),
      });
    } catch (error) { statusCode = (error as HttpError).statusCode; }
    expect(statusCode).toBe(401);
  });
});

describe("时间偏移策略节", () => {
  it("只接受 offsetSeconds 与 auto", () => {
    expect(timeSectionSchema.safeParse({ offsetSeconds: 12.5 }).success).toBe(true);
    expect(timeSectionSchema.safeParse({ auto: true }).success).toBe(true);
    expect(timeSectionSchema.safeParse({}).success).toBe(true);
    expect(timeSectionSchema.safeParse({ offsetSeconds: 86401 }).success).toBe(false);
    expect(timeSectionSchema.safeParse({ auto: "yes" }).success).toBe(false);
    expect(timeSectionSchema.safeParse({ offset: 1 }).success).toBe(false);
  });

  it("策略发布接受 time 节并拒绝非法取值", () => {
    const publish = (document: Record<string, unknown>) => ({
      name: "时间偏移", scopeType: "school" as const, document,
    });
    expect(policyPublishSchema.safeParse(publish({ time: { offsetSeconds: -30, auto: false } })).success).toBe(true);
    expect(policyPublishSchema.safeParse(publish({ time: { offsetSeconds: 1e6 } })).success).toBe(false);
    expect(policyPublishSchema.safeParse(publish({ time: ["auto"] })).success).toBe(false);
  });

  it("非对象的 time 节被拒绝", () => {
    const publish = (document: Record<string, unknown>) => ({
      name: "时间偏移", scopeType: "school" as const, document,
    });
    expect(policyPublishSchema.safeParse(publish({ time: "auto" })).success).toBe(false);
  });
});