import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalJson, sha256 } from "./security";

let identity: { privateKeyPem: string; publicKeyDer: string; keyId: string } | undefined;

export function getServerSigningIdentity() {
  if (identity) return identity;
  const config = useRuntimeConfig();
  const dataDir = resolve(process.env.CLASSISLAND_CONTROL_DATA_DIR || config.dataDir);
  mkdirSync(dataDir, { recursive: true });
  const privatePath = resolve(dataDir, "server-signing-private.pem");
  const publicPath = resolve(dataDir, "server-signing-public.der");

  const hasPrivateKey = existsSync(privatePath);
  const hasPublicKey = existsSync(publicPath);
  if (!hasPrivateKey) {
    if (hasPublicKey) {
      throw new Error(
        "检测到服务端签名公钥但私钥缺失。重新生成密钥会使全部已接入设备拒连，因此拒绝启动；请从备份恢复 server-signing-private.pem。",
      );
    }
    const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    writeFileSync(privatePath, pair.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    writeFileSync(publicPath, pair.publicKey.export({ type: "spki", format: "der" }), { mode: 0o644 });
    try { chmodSync(privatePath, 0o600); } catch { /* Windows ACLs are managed by the data-directory owner. */ }
  }

  const privateKeyPem = readFileSync(privatePath, "utf8");
  let privateKey;
  try {
    privateKey = createPrivateKey(privateKeyPem);
  } catch {
    throw new Error("服务端签名私钥无法解析，请从备份恢复 server-signing-private.pem。");
  }
  const publicKeyDer = createPublicKey(privateKey).export({ type: "spki", format: "der" }).toString("base64");
  const storedPublicKeyDer = hasPublicKey ? readFileSync(publicPath).toString("base64") : "";
  if (!hasPublicKey || storedPublicKeyDer !== publicKeyDer) {
    writeFileSync(publicPath, Buffer.from(publicKeyDer, "base64"), { mode: 0o644 });
  }

  identity = { privateKeyPem, publicKeyDer, keyId: sha256(Buffer.from(publicKeyDer, "base64")) };
  return identity;
}

export function signEnvelope<T extends Record<string, unknown>>(value: T) {
  const signing = getServerSigningIdentity();
  const canonical = canonicalJson(value);
  const signature = sign("sha256", Buffer.from(canonical), { key: createPrivateKey(signing.privateKeyPem), dsaEncoding: "ieee-p1363" }).toString("base64url");
  return { ...value, keyId: signing.keyId, signature };
}

export function signResponseBody(body: string) {
  const signing = getServerSigningIdentity();
  return {
    keyId: signing.keyId,
    signature: sign("sha256", Buffer.from(body), { key: createPrivateKey(signing.privateKeyPem), dsaEncoding: "ieee-p1363" }).toString("base64url"),
  };
}

export function serverSigningMetadata() {
  const signing = getServerSigningIdentity();
  return { serverSigningPublicKey: signing.publicKeyDer, serverSigningKeyId: signing.keyId, registrationId: randomUUID() };
}