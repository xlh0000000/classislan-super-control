import { z } from "zod";
import { pollSchema } from "../../../../shared/schemas";
import { nowIso, useDatabase } from "../../../utils/database";
import { verifyDeviceRequestEnvelope } from "../../../utils/device-auth";
import { processDevicePoll } from "../../../utils/device-poll";

/**
 * WebSocket 连接模式端点（`POST /api/v1/agent/ws` 升级）。
 *
 * 承载与 HTTP 轮询**完全相同**的签名信封与响应正文，因此序列窗口、重放缓存、
 * 命令投递、策略下发与审计语义完全一致，差别只是连接常驻：设备在同一连接上连续
 * 提交轮询，省掉每次的 TCP/TLS 握手。
 *
 * 消息格式：
 *   设备 → 集控 {"type":"poll","envelope":{…轮询正文，含 signedBodyHash 与 signature…}}
 *   集控 → 设备 {"type":"poll-result","keyId":…,"signature":…,"body":"…已签名响应正文…"}
 *   集控 → 设备 {"type":"error","statusCode":…,"message":…,"lastSequence"?…}
 *
 * 响应用嵌套字符串承载原始正文：客户端按字节校验服务端签名，任何重新序列化
 * 都可能改变正文形状而让签名失效。
 */

const inboundSchema = z.object({
  type: z.literal("poll"),
  envelope: z.record(z.string(), z.unknown()),
});

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
    // 信封内部字段一律按未知值处理：先验签，再交给 schema 做形状校验。
    const envelope = inbound.data.envelope;
    try {
      const db = useDatabase();
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
      const outcome = processDevicePoll(db, authenticated, input.data, nowIso());
      send(peer, { type: "poll-result", keyId: outcome.keyId, signature: outcome.signature, body: outcome.body });
    } catch (error) {
      send(peer, errorPayload(error));
      // 认证失败意味着这条连接不值得保留：断开并让设备重新走接入检查。
      const statusCode = (error as { statusCode?: number })?.statusCode;
      if (statusCode === 401) peer.close(1008, "unauthorized");
    }
  },
});