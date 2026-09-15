import { enrollSchema } from "../../../../shared/schemas";
import { EnrollmentError, enrollDevice, type EnrollmentOutcome } from "../../../utils/enrollment";

export default defineEventHandler(async (event) => {
  const input = enrollSchema.safeParse(await readBody(event));
  if (!input.success) throw createError({ statusCode: 400, message: input.error.issues[0]?.message || "注册信息无效" });
  let outcome: EnrollmentOutcome;
  try {
    outcome = enrollDevice(useDatabase(), {
      token: input.data.token,
      name: input.data.name,
      publicKeyJwk: input.data.publicKeyJwk as import("node:crypto").JsonWebKey,
      keyThumbprint: input.data.keyThumbprint,
      pluginVersion: input.data.pluginVersion,
      appVersion: input.data.appVersion,
      platform: input.data.platform,
    });
  } catch (error) {
    if (error instanceof EnrollmentError) throw createError({ statusCode: error.statusCode, message: error.message });
    throw error;
  }
  return { deviceId: outcome.deviceId, pollIntervalSeconds: 5, serverTimeUtc: nowIso(), ...serverSigningMetadata() };
});