import { pollSchema } from "../../../../shared/schemas";
import { processDevicePoll } from "../../../utils/device-poll";

export default defineEventHandler(async (event) => {
  const authenticated = await readAuthenticatedDeviceRequest(event);
  let body: unknown;
  try { body = JSON.parse(authenticated.rawBody); }
  catch { throw createError({ statusCode: 400, message: "轮询正文不是有效 JSON。" }); }
  const input = pollSchema.safeParse(body);
  if (!input.success) throw createError({ statusCode: 400, message: input.error.issues[0]?.message || "轮询信息无效" });
  if (input.data.deviceId !== authenticated.deviceId || input.data.sequence !== authenticated.sequence || input.data.timestampUtc !== authenticated.timestampUtc)
    throw createError({ statusCode: 401, message: "签名头与轮询正文不一致。" });
  // 序列消费、ACK、命令 offer、策略解析、响应签名与响应缓存同事务完成；同序列重放返回原签名字节。
  const outcome = processDevicePoll(useDatabase(), authenticated, input.data, nowIso());
  setHeader(event, "x-server-key-id", outcome.keyId);
  setHeader(event, "x-server-signature", outcome.signature);
  return send(event, outcome.body, "application/json");
});