import type Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { comparePluginVersions, resolvePluginUpdateTarget } from "./plugin-updates";
import { pluginReleaseExists, readPluginRelease } from "./plugin-release-store";
import { nowIso } from "./database";
import { sha256 } from "./security";

/** 下载凭据活 30 分钟、可用 2 次：够一次断线重传，又不至于让链接长期有效。 */
export const PLUGIN_DOWNLOAD_TTL_MS = 30 * 60_000;
export const PLUGIN_DOWNLOAD_MAX_USES = 2;

export type PluginDownloadOffer = {
  version: string;
  sha256: string;
  sizeBytes: number;
  /** 相对路径：设备端用它拼自己已配置的控制服务地址，服务端不必知道自己的公网域名。 */
  path: string;
  /** 空串表示「目标没变，不必重新下载」：设备手上那份暂存的包继续等空闲窗口。 */
  token: string;
  expiresAt: string;
};

/**
 * 该不该给这台设备一次升级机会。
 *
 * 三个条件缺一不可：目标版本与本机版本不一致（不一致就下发，回滚也走同一条路，
 * 否则管理员把目标调回旧版时设备会无动于衷）、发布记录还在且磁盘上的包也在。
 *
 * 设备已回报「包已暂存、等没课重启」且暂存的正是当前目标时，回同一版本但 token 留空：
 * 设备据此知道目标没变、不必重新下载。这与「管理员取消了目标」必须区分开——
 * 那才是彻底没有 pluginUpdate，设备会删掉自己暂存的包，免得某次重启把它装上。
 */
export function planPluginUpdateOffer(
  db: Database.Database,
  deviceId: string,
  currentVersion: string,
  reported: { state: string; version: string },
  now = nowIso(),
): PluginDownloadOffer | null {
  const target = resolvePluginUpdateTarget(db, deviceId);
  if (!target || comparePluginVersions(target.version, currentVersion) === 0) return null;
  const release = db.prepare("SELECT sha256,size_bytes sizeBytes FROM plugin_releases WHERE version=?").get(target.version) as
    { sha256: string; sizeBytes: number } | undefined;
  // 记录在而文件不在（备份只恢复了库、或包被手工挪走）时宁可不发，也不能让设备去下载一个 404。
  if (!release || !pluginReleaseExists(target.version)) return null;
  const offer = (token: string, expiresAt: string): PluginDownloadOffer =>
    ({ version: target.version, sha256: release.sha256, sizeBytes: release.sizeBytes, path: `/api/v1/agent/plugin-releases/${target.version}`, token, expiresAt });
  if (reported.state === "staged" && reported.version === target.version) return offer("", "");

  const token = randomBytes(32).toString("hex");
  const tokenHash = sha256(token);
  const expiresAt = new Date(Date.parse(now) + PLUGIN_DOWNLOAD_TTL_MS).toISOString();
  // 只清这台设备上过期或用尽的凭据：轮询每 30 秒一次，攒下来的死行必须有人收，但别在热路径上做全表扫描。
  db.prepare("DELETE FROM plugin_download_tokens WHERE device_id=? AND (expires_at<=? OR use_count>=max_uses)").run(deviceId, now);
  db.prepare("INSERT INTO plugin_download_tokens (token_hash,device_id,version,expires_at,max_uses,use_count,created_at) VALUES (?,?,?,?,?,0,?)")
    .run(tokenHash, deviceId, target.version, expiresAt, PLUGIN_DOWNLOAD_MAX_USES, now);
  return offer(token, expiresAt);
}

export type PluginDownloadTicket = { deviceId: string; version: string; fileName: string; bytes: Buffer };

/**
 * 凭据兑换下载内容：一次消费一个名额，过期或耗尽都不再给。
 * 用「条件更新成功」来占用名额，因此并发重放同一 token 最多拿到 PLUGIN_DOWNLOAD_MAX_USES 份。
 * 校验失败一律返回 null，由路由统一回同一个错误：既不区分「没有这条凭据」和「凭据不是这个版本」，
 * 也就让拿着链接的人无从试探还有谁的机器也在升级。
 */
export function consumePluginDownloadToken(db: Database.Database, version: string, token: string, now = nowIso()): PluginDownloadTicket | null {
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  const tokenHash = sha256(token);
  const claimed = db.prepare("UPDATE plugin_download_tokens SET use_count=use_count+1 WHERE token_hash=? AND version=? AND expires_at>? AND use_count<max_uses")
    .run(tokenHash, version, now);
  if (claimed.changes !== 1) return null;
  const row = db.prepare(`SELECT t.device_id deviceId,r.file_name fileName
    FROM plugin_download_tokens t JOIN plugin_releases r ON r.version=t.version
    WHERE t.token_hash=? AND t.version=?`).get(tokenHash, version) as { deviceId: string; fileName: string } | undefined;
  if (!row) return null;
  const bytes = readPluginRelease(version);
  if (!bytes) return null;
  return { deviceId: row.deviceId, version, fileName: row.fileName, bytes };
}
