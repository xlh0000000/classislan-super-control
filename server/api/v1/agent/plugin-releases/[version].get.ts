import { PLUGIN_RELEASE_VERSION_PATTERN } from "../../../../../shared/schemas";
import { consumePluginDownloadToken } from "../../../../utils/plugin-release-delivery";

/**
 * 用轮询拿到的凭据兑换插件包。
 *
 * 这是整条设备链路上唯一不做请求签名的接口：下载动作发生在设备自己的 HTTP 客户端里，
 * 复用签名信封会把插件侧搞得很重，而凭据本身已是 256 位随机、绑定设备与版本、限时两次的凭据。
 * 拿不到凭据的人即使猜到路径，也只能得到一个 410。
 */
export default defineEventHandler(async (event) => {
  const version = getRouterParam(event, "version") ?? "";
  const token = getQuery(event).token;
  const ticket = PLUGIN_RELEASE_VERSION_PATTERN.test(version) && typeof token === "string"
    ? consumePluginDownloadToken(useDatabase(), version, token, nowIso())
    : null;
  if (!ticket) throw createError({ statusCode: 410, message: "下载凭据无效或已过期。" });
  setHeader(event, "content-type", "application/octet-stream");
  setHeader(event, "content-length", ticket.bytes.length);
  setHeader(event, "content-disposition", `attachment; filename="${ticket.fileName}"`);
  setHeader(event, "cache-control", "no-store");
  return send(event, ticket.bytes);
});
