import type Database from "better-sqlite3";
import { nowIso } from "./database";

// 贡献者：威廉（WebSocket 实时连接注册表：在线管理 / 主动推送 / 心跳 last_seen_at）

export type DeviceWsPeer = { send: (data: string) => unknown; close?: (code?: number, reason?: string) => unknown };

export type DeviceWsConnection = {
  deviceId: string;
  peer: DeviceWsPeer;
  connectedAt: string;
  lastSeenAt: string;
  pluginVersion?: string;
  appVersion?: string;
};

/** 每台设备至多一条常驻连接；设备重连时旧连接会被替换并关闭。 */
const connections = new Map<string, DeviceWsConnection>();

/** 设备经签名信封认证成功后登记连接，同时刷新 last_seen_at（在线判定由心跳/poll 维持）。 */
export function registerDeviceConnection(
  db: Database.Database,
  deviceId: string,
  peer: DeviceWsPeer,
  info: { pluginVersion?: string; appVersion?: string } = {},
) {
  const previous = connections.get(deviceId);
  if (previous && previous.peer !== peer) {
    try { previous.peer.close?.(1000, "replaced-by-new-connection"); } catch { /* 旧连接已损坏 */ }
  }
  const seenAt = nowIso();
  db.prepare("UPDATE devices SET last_seen_at=? WHERE id=?").run(seenAt, deviceId);
  connections.set(deviceId, { deviceId, peer, connectedAt: seenAt, lastSeenAt: seenAt, ...info });
}

/** 关闭连接时按 peer 精确注销（防止旧连接关闭误删新连接）。 */
export function unregisterByPeer(peer: DeviceWsPeer) {
  for (const [deviceId, connection] of connections) {
    if (connection.peer === peer) {
      connections.delete(deviceId);
      return;
    }
  }
}

/** 心跳 pong 或连接上任何消息到达时刷新在线时间。 */
export function touchDeviceConnection(deviceId: string, db: Database.Database) {
  const connection = connections.get(deviceId);
  if (!connection) return;
  const seenAt = nowIso();
  connection.lastSeenAt = seenAt;
  db.prepare("UPDATE devices SET last_seen_at=? WHERE id=?").run(seenAt, deviceId);
}

export function deviceIdOfPeer(peer: DeviceWsPeer): string | undefined {
  for (const [deviceId, connection] of connections) if (connection.peer === peer) return deviceId;
  return undefined;
}

/** 向指定设备主动推送一条 JSON 消息（连接不在线时静默丢弃，返回是否送达）。 */
export function pushToDevice(deviceId: string, payload: unknown): boolean {
  const connection = connections.get(deviceId);
  if (!connection) return false;
  try {
    connection.peer.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

/**
 * 写路径广播钩子：策略发布 / 配置部署 / 任务投递等数据变化后调用，
 * 在线设备收到 notify 立即发起轮询，实时状态不再干等 30 秒。
 */
export function broadcastNotify(event: string, detail?: unknown): number {
  const now = nowIso();
  let sent = 0;
  for (const connection of connections.values()) {
    try {
      connection.peer.send(JSON.stringify({
        type: "notify",
        event,
        serverTimeUtc: now,
        ...(detail === undefined ? {} : { detail }),
      }));
      sent += 1;
    } catch {
      /* 连接已损坏，由 ws close 统一清理 */
    }
  }
  return sent;
}

export function onlineDeviceCount(): number {
  return connections.size;
}

export function onlineDeviceIds(): string[] {
  return [...connections.keys()];
}
