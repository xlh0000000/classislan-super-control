import type { H3Event } from "h3";
import { getHeader } from "h3";
import { timingSafeEqualText } from "./security";

export const BOOTSTRAP_TOKEN_ENV = "CLASSISLAND_CONTROL_BOOTSTRAP_TOKEN";
const MINIMUM_PRODUCTION_TOKEN_LENGTH = 16;

function readConfiguredToken() {
  return (process.env[BOOTSTRAP_TOKEN_ENV] || "").trim();
}

export function isProductionRuntime() {
  return process.env.NODE_ENV === "production";
}

export function bootstrapTokenStatus() {
  const configured = readConfiguredToken().length > 0;
  return { configured, required: isProductionRuntime() || configured };
}

/**
 * 首设引导令牌校验（fail closed）：
 * - 生产环境必须配置足够长的令牌，否则直接拒绝初始化；
 * - 已配置令牌时，请求头必须恒定时间匹配；
 * - 仅非生产环境且未配置令牌时放行，便于本地开发。
 */
export function assertBootstrapToken(event: H3Event) {
  const expected = readConfiguredToken();
  if (isProductionRuntime() && expected.length < MINIMUM_PRODUCTION_TOKEN_LENGTH) {
    throw createError({
      statusCode: 503,
      message: `生产环境必须配置至少 ${MINIMUM_PRODUCTION_TOKEN_LENGTH} 位的 ${BOOTSTRAP_TOKEN_ENV} 后才能初始化。`,
    });
  }
  if (!expected) return;
  const provided = (getHeader(event, "x-bootstrap-token") || "").trim();
  if (!provided || !timingSafeEqualText(provided, expected)) {
    throw createError({ statusCode: 403, message: "部署引导令牌不正确。" });
  }
}