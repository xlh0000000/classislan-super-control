import { z } from "zod";
import { pollSchema } from "../../../../shared/schemas";
import { nowIso, useDatabase } from "../../../utils/database";
import { verifyDeviceRequestEnvelope } from "../../../utils/device-auth";
import { processDevicePoll } from "../../../utils/device-poll";
import {
  deviceIdOfPeer,
  registerDeviceConnection,
  touchDeviceConnection,
  unregisterByPeer,
  type DeviceWsPeer,
} from "../../../utils/device-ws-registry";

/**
 * WebSocket 实时连接端点（`POST /api/v1/agent/ws` 升级）。
 *
 * 承载与 HTTP 轮询**完全相同**的签名信封与响应正文，因此序列窗口、重放缓存、
 * 命令投递、策略下发与审计语义完全一致；实时状态额外提供：
 *   - 认证成功后登记连接，集控端可主动推送（notify），设备立即 poll，不再干等；
 *   - 空闲时服务端 20s 心跳（ping），设备回 pong 维持在线判定（刷新 last_seen_at）。
 *
 * 消息格式：
 *   设备 → 集控 {"type":"poll","envelope":{…签名轮询正文…}} | {"type":"pong"}
 *   集控 → 设备 {"type":"poll-result","keyId":…,"signature":…,"body":"…已签名响应正文…"}
 *   集控 → 设备 {"type":"notify","event":…,"serverTimeUtc":…} | {"type":"ping","serverTimeUtc":…}
 *   集控 → 设备 {"type":"error","statusCode":…,"message":…,"lastSequence"?…}
 */

const inboundSchema = z.object({
  type: z.enum(["poll", "pong"]),
  envelope: z.record(z.string(), z.unknown()).optional(),
});

/** 空闲心跳间隔：20 秒，设备回 pong 视为连接健康并刷新在线时间。 */
const HEARTBEAT_INTERVAL_MS = 20_000;

const heartbeatTimers = new WeakMap<DeviceWsPeer, ReturnType<typeof setInterval>>();

function errorPayload(error: unknown) {
  const failure = error as { statusCode?: number; statusMessage?: string; message?: string; data?: { lastSequence?: number } };
  return {
    type: "error" as const,
    statusCode: typeof failure?.statusCode === "number" ? failure.statusCode : 500,
    message: failure?.statusMessage || failure?.message || "长连接轮询失败。",
    ...(failure?.data?.lastSequence === undefined ? {} : { lastSequence: failure.data.lastSequence }),
  };
}

function send(peer: { send: (data: string) => unknown }, payload: unknown) {
  peer.send(JSON.stringify(payload));
}

export default defineWebSocketHandler({
  open(peer) {
    // 连接建立即开始空闲心跳；连接关闭时统一清理。
    const timer = setInterval(() => {
      try {
        send(peer, { type: "ping", serverTimeUtc: nowIso() });
      } catch {
        clearInterval(timer);
        heartbeatTimers.delete(peer);
      }
    }, HEARTBEAT_INTERVAL_MS);
    heartbeatTimers.set(peer, timer);
  },
  message(peer, raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.text());
    } catch {
      send(peer, { type: "error", statusCode: 400, message: "长连接消息不是有效 JSON。" });
      return;
    }
    const inbound = inboundSchema.safeParse(parsed);
    if (!inbound.success) {
      send(peer, { type: "error", statusCode: 400, message: "长连接消息缺少 poll 信封。" });
      return;
    }
    const db = useDatabase();
    // 心跳应答：已认证设备回 pong 维持在线判定。
    if (inbound.data.type === "pong") {
      const deviceId = deviceIdOfPeer(peer);
      if (deviceId) touchDeviceConnection(deviceId, db);
      return;
    }
    // 信封内部字段一律按未知值处理：先验签，再交给 schema 做形状校验。
    const envelope = inbound.data.envelope!;
    try {
      const authenticated = verifyDeviceRequestEnvelope(db, {
        deviceId: typeof envelope.deviceId === "string" ? envelope.deviceId : "",
        sequence: typeof envelope.sequence === "number" ? envelope.sequence : Number.NaN,
        timestampUtc: typeof envelope.timestampUtc === "string" ? envelope.timestampUtc : "",
        signature: typeof envelope.signature === "string" ? envelope.signature : "",
        rawBody: JSON.stringify(envelope),
      });
      const input = pollSchema.safeParse(envelope);
      if (!input.success) {
        send(peer, { type: "error", statusCode: 400, message: input.error.issues[0]?.message || "轮询信息无效。" });
        return;
      }
      if (input.data.deviceId !== authenticated.deviceId || input.data.sequence !== authenticated.sequence || input.data.timestampUtc !== authenticated.timestampUtc) {
        send(peer, { type: "error", statusCode: 401, message: "签名信封与轮询正文不一致。" });
        return;
      }
      // 认证成功：登记实时连接（替换旧连接），后续可主动推送。
      registerDeviceConnection(db, authenticated.deviceId, peer, {
        pluginVersion: input.data.pluginVersion,
        appVersion: input.data.appVersion,
      });
      const outcome = processDevicePoll(db, authenticated, input.data, nowIso());
      send(peer, { type: "poll-result", keyId: outcome.keyId, signature: outcome.signature, body: outcome.body });
    } catch (error) {
      send(peer, errorPayload(error));
      // 认证失败意味着这条连接不值得保留：断开并让设备重新走接入检查。
      const statusCode = (error as { statusCode?: number })?.statusCode;
      if (statusCode === 401) peer.close(1008, "unauthorized");
    }
  },
  close(peer) {
    const timer = heartbeatTimers.get(peer);
    if (timer) {
      clearInterval(timer);
      heartbeatTimers.delete(peer);
    }
    unregisterByPeer(peer);
  },
});
