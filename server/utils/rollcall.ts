import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { nowIso } from "./database";
import { appendAuditWithin } from "./security";
import { assertDeviceInScope, assertOrgNodeInScope, deviceScopeFilter, hasSchoolWideScope, type ScopeUser } from "./scope";

export type RollCallScopeType = "school" | "organization" | "device";

/** 点名设置的五个可选项；null 表示这一层不表态，继续向外继承。 */
export type RollCallSettings = {
  enabled: boolean | null;
  multiEnabled: boolean | null;
  notify: boolean | null;
  singleSeconds: number | null;
  multiSeconds: number | null;
};

/** 某个字段最终由哪一层决定：local 表示没有任何作用域表过态，设备本机设置说了算。 */
export type RollCallSettingSource = RollCallScopeType | "local";

export type RollCallSettingsRow = RollCallSettings & {
  scopeType: RollCallScopeType;
  scopeId: string | null;
  revision: number;
  updatedAt: string;
};

/** 某台设备当前生效的名单，含命中层级：教师据此知道这份名单是不是自己改得动的。 */
export type DeviceRollCallState = {
  revision: number;
  names: string[];
  scopeType: RollCallScopeType | "none";
  rosterId: string | null;
  /** 逐字段继承后的生效设置；某项为 null 表示交给设备本机。 */
  settings: RollCallSettings;
  /** 每个生效字段命中的层级，界面据此标注“来自全校 / 来自本机覆盖 / 本机设置”。 */
  settingSources: Record<keyof RollCallSettings, RollCallSettingSource>;
  /** 这台设备自己那一行覆盖值；没有覆盖行时为 null，表单据此回显三态控件。 */
  deviceOverride: RollCallSettings | null;
};

export type RollCallRoster = {
  id: string;
  name: string;
  scopeType: RollCallScopeType;
  scopeId: string | null;
  names: string[];
  revision: number;
  updatedAt: string;
};

type RosterRow = {
  id: string;
  name: string;
  scopeType: RollCallScopeType;
  scopeId: string | null;
  names: string;
  revision: number;
  updatedAt: string;
};

/** 名单正文以 JSON 数组存储；解析失败按空名单处理，脏数据不能打挂每一次轮询。 */
function parseNames(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

/** 覆盖式写入前去掉空行与重复姓名，保证同一份名单的下发内容稳定。 */
export function normalizeRollCallNames(names: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of names) {
    const name = raw.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    result.push(name);
  }
  return result;
}

function mapRoster(row: RosterRow): RollCallRoster {
  return { ...row, names: parseNames(row.names) };
}

function findRoster(db: Database.Database, scopeType: RollCallScopeType, scopeId: string | null) {
  const row = (scopeId === null
    ? db.prepare("SELECT id,name,scope_type scopeType,scope_id scopeId,names,revision,updated_at updatedAt FROM rollcall_rosters WHERE scope_type=? AND scope_id IS NULL")
      .get(scopeType)
    : db.prepare("SELECT id,name,scope_type scopeType,scope_id scopeId,names,revision,updated_at updatedAt FROM rollcall_rosters WHERE scope_type=? AND scope_id=?")
      .get(scopeType, scopeId)) as RosterRow | undefined;
  return row ? mapRoster(row) : null;
}

export function listRollCallRosters(db: Database.Database): RollCallRoster[] {
  const rows = db.prepare(`SELECT id,name,scope_type scopeType,scope_id scopeId,names,revision,updated_at updatedAt
    FROM rollcall_rosters ORDER BY scope_type, name`).all() as RosterRow[];
  return rows.map(mapRoster);
}

/**
 * 全局单调修订号：任何一次名单写入或删除都会 +1，
 * 因此设备只要比较修订是否相等，就能判断自己手上的名单是否过期。
 */
function allocateRevision(db: Database.Database): number {
  const row = db.prepare("SELECT value FROM system_state WHERE key=?").get("rollcall.revision") as { value: string } | undefined;
  const next = (Number.parseInt(row?.value ?? "0", 10) || 0) + 1;
  db.prepare(`INSERT INTO system_state (key,value,updated_at) VALUES (?,?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
    .run("rollcall.revision", String(next), nowIso());
  return next;
}

/**
 * 当前交付用的修订号：名单与设置的每次写入都会推进它，设备只需比较手上的编号。
 * 行内 revision 只记录该行最后一次写入，单独改设置不会动到名单行，
 * 因此下发判定必须用这个全局计数，不能用名单行的 revision。
 */
export function rollCallDeliveryRevision(db: Database.Database): number {
  const row = db.prepare("SELECT value FROM system_state WHERE key=?").get("rollcall.revision") as { value: string } | undefined;
  return Number.parseInt(row?.value ?? "0", 10) || 0;
}

/** 作用域目标必须真实存在且落在写入者的可见范围内。 */
function assertScopeTarget(db: Database.Database, user: ScopeUser, scopeType: RollCallScopeType, scopeId: string | null) {
  if (scopeType === "school") {
    // 全校名单会命中所有设备：教师（靠绑定）与组织范围账号（靠子树）都没有这一层的授权。
    if (!hasSchoolWideScope(user))
      throw createError({ statusCode: 403, message: "当前账号的范围不足以保存全校点名名单。" });
    return;
  }
  if (!scopeId) throw createError({ statusCode: 400, message: "该作用域必须指定目标。" });
  if (scopeType === "organization") {
    if (!db.prepare("SELECT 1 FROM org_nodes WHERE id=?").get(scopeId))
      throw createError({ statusCode: 404, message: "目标组织不存在。" });
    assertOrgNodeInScope(db, user, scopeId);
    return;
  }
  if (!db.prepare("SELECT 1 FROM devices WHERE id=? AND disabled_at IS NULL").get(scopeId))
    throw createError({ statusCode: 404, message: "目标设备不存在。" });
  assertDeviceInScope(db, user, scopeId);
}

/** 每个作用域最多一份名单：同一目标再次保存即为覆盖。 */
export function upsertRollCallRoster(
  db: Database.Database,
  user: ScopeUser,
  input: { name: string; scopeType: RollCallScopeType; scopeId: string | null; names: string[] },
): RollCallRoster {
  const scopeId = input.scopeType === "school" ? null : input.scopeId;
  const names = normalizeRollCallNames(input.names);
  return db.transaction(() => {
    assertScopeTarget(db, user, input.scopeType, scopeId);
    const existing = findRoster(db, input.scopeType, scopeId);
    const id = existing?.id ?? randomUUID();
    const revision = allocateRevision(db);
    const timestamp = nowIso();
    db.prepare(`INSERT INTO rollcall_rosters (id,name,scope_type,scope_id,names,revision,updated_at)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,scope_type=excluded.scope_type,scope_id=excluded.scope_id,names=excluded.names,revision=excluded.revision,updated_at=excluded.updated_at`)
      .run(id, input.name, input.scopeType, scopeId, JSON.stringify(names), revision, timestamp);
    appendAuditWithin(db, {
      actorType: "user", actorId: user.id, action: "rollcall.roster.save", targetType: "rollcall_roster", targetId: id,
      summary: `点名名单「${input.name}」已保存（${names.length} 人）`,
      details: { scopeType: input.scopeType, scopeId, revision, count: names.length },
    });
    return { id, name: input.name, scopeType: input.scopeType, scopeId, names, revision, updatedAt: timestamp };
  }).immediate();
}

export function deleteRollCallRoster(db: Database.Database, user: ScopeUser, id: string): boolean {
  return db.transaction(() => {
    const existing = db.prepare("SELECT id,name,scope_type scopeType,scope_id scopeId,names,revision,updated_at updatedAt FROM rollcall_rosters WHERE id=?")
      .get(id) as RosterRow | undefined;
    if (!existing) return false;
    // 删除同样推进修订号：设备下次轮询会发现解析结果变了，从而清空本地名单。
    allocateRevision(db);
    db.prepare("DELETE FROM rollcall_rosters WHERE id=?").run(id);
    appendAuditWithin(db, {
      actorType: "user", actorId: user.id, action: "rollcall.roster.delete", targetType: "rollcall_roster", targetId: id,
      summary: `点名名单「${existing.name}」已删除`,
      details: { scopeType: existing.scopeType, scopeId: existing.scopeId },
    });
    return true;
  }).immediate();
}

/** 布尔在 STRICT 表里按 0/1 存储，读回时再还原为可空布尔。 */
function toIntFlag(value: boolean | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return value ? 1 : 0;
}

const SETTINGS_COLUMNS = `id,scope_type scopeType,scope_id scopeId,enabled,multi_enabled multiEnabled,notify,
  single_seconds singleSeconds,multi_seconds multiSeconds,revision,updated_at updatedAt`;

type SettingsRow = {
  id: string;
  scopeType: RollCallScopeType;
  scopeId: string | null;
  enabled: number | null;
  multiEnabled: number | null;
  notify: number | null;
  singleSeconds: number | null;
  multiSeconds: number | null;
  revision: number;
  updatedAt: string;
};

function mapSettings(row: SettingsRow): RollCallSettingsRow {
  return {
    scopeType: row.scopeType,
    scopeId: row.scopeId,
    enabled: row.enabled === null ? null : row.enabled === 1,
    multiEnabled: row.multiEnabled === null ? null : row.multiEnabled === 1,
    notify: row.notify === null ? null : row.notify === 1,
    singleSeconds: row.singleSeconds,
    multiSeconds: row.multiSeconds,
    revision: row.revision,
    updatedAt: row.updatedAt,
  };
}

function findSettings(db: Database.Database, scopeType: RollCallScopeType, scopeId: string | null): SettingsRow | undefined {
  return (scopeId === null
    ? db.prepare(`SELECT ${SETTINGS_COLUMNS} FROM rollcall_settings WHERE scope_type=? AND scope_id IS NULL`).get(scopeType)
    : db.prepare(`SELECT ${SETTINGS_COLUMNS} FROM rollcall_settings WHERE scope_type=? AND scope_id=?`).get(scopeType, scopeId)) as SettingsRow | undefined;
}

export function listRollCallSettings(db: Database.Database): RollCallSettingsRow[] {
  const rows = db.prepare(`SELECT ${SETTINGS_COLUMNS} FROM rollcall_settings ORDER BY scope_type, scope_id`).all() as SettingsRow[];
  return rows.map(mapSettings);
}

/** 设置行没有名字可引用，审计摘要只能拿作用域指向的对象说事。 */
function scopeTargetName(db: Database.Database, scopeType: RollCallScopeType, scopeId: string | null): string {
  if (scopeType === "school") return "全校";
  if (scopeType === "organization")
    return (db.prepare("SELECT name FROM org_nodes WHERE id=?").get(scopeId ?? "") as { name: string } | undefined)?.name ?? "组织";
  return (db.prepare("SELECT name FROM devices WHERE id=?").get(scopeId ?? "") as { name: string } | undefined)?.name ?? "设备";
}

function settingsSummary(settings: RollCallSettings): string[] {
  const parts: string[] = [];
  if (settings.enabled !== null) parts.push(`悬浮窗${settings.enabled ? "开启" : "关闭"}`);
  if (settings.multiEnabled !== null) parts.push(`多人按钮${settings.multiEnabled ? "显示" : "隐藏"}`);
  if (settings.notify !== null) parts.push(`提醒${settings.notify ? "开" : "关"}`);
  if (settings.singleSeconds !== null) parts.push(`单人 ${settings.singleSeconds} 秒`);
  if (settings.multiSeconds !== null) parts.push(`多人 ${settings.multiSeconds} 秒`);
  return parts;
}

/**
 * 按作用域覆盖式写入点名设置：一次提交代表这一行的全部内容，
 * 缺省或 null 的字段即“不表态”，向外层继续继承。五项全不表态时删除该行，
 * 留下一行空记录只会让“这一层存在但什么都不管”变得难以判断。
 */
export function upsertRollCallSettings(
  db: Database.Database,
  user: ScopeUser,
  input: { scopeType: RollCallScopeType; scopeId: string | null; enabled?: boolean | null; multiEnabled?: boolean | null; notify?: boolean | null; singleSeconds?: number | null; multiSeconds?: number | null },
): RollCallSettingsRow | null {
  const scopeId = input.scopeType === "school" ? null : input.scopeId;
  const settings: RollCallSettings = {
    enabled: input.enabled ?? null,
    multiEnabled: input.multiEnabled ?? null,
    notify: input.notify ?? null,
    singleSeconds: input.singleSeconds ?? null,
    multiSeconds: input.multiSeconds ?? null,
  };
  const isClear = settings.enabled === null && settings.multiEnabled === null && settings.notify === null
    && settings.singleSeconds === null && settings.multiSeconds === null;
  return db.transaction(() => {
    assertScopeTarget(db, user, input.scopeType, scopeId);
    const existing = findSettings(db, input.scopeType, scopeId);
    const target = scopeTargetName(db, input.scopeType, scopeId);
    if (isClear) {
      if (!existing) return null;
      // 清除同样推进交付修订号：设备下次轮询要把本机设置交还给继承链。
      const revision = allocateRevision(db);
      db.prepare("DELETE FROM rollcall_settings WHERE id=?").run(existing.id);
      appendAuditWithin(db, {
        actorType: "user", actorId: user.id, action: "rollcall.settings.clear", targetType: "rollcall_settings", targetId: existing.id,
        summary: `已清除${target}的点名设置覆盖`,
        details: { scopeType: input.scopeType, scopeId, revision },
      });
      return null;
    }
    const id = existing?.id ?? randomUUID();
    const revision = allocateRevision(db);
    const timestamp = nowIso();
    db.prepare(`INSERT INTO rollcall_settings (id,scope_type,scope_id,enabled,multi_enabled,notify,single_seconds,multi_seconds,revision,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET scope_type=excluded.scope_type,scope_id=excluded.scope_id,enabled=excluded.enabled,
        multi_enabled=excluded.multi_enabled,notify=excluded.notify,single_seconds=excluded.single_seconds,multi_seconds=excluded.multi_seconds,
        revision=excluded.revision,updated_at=excluded.updated_at`)
      .run(id, input.scopeType, scopeId, toIntFlag(settings.enabled), toIntFlag(settings.multiEnabled), toIntFlag(settings.notify), settings.singleSeconds, settings.multiSeconds, revision, timestamp);
    appendAuditWithin(db, {
      actorType: "user", actorId: user.id, action: "rollcall.settings.save", targetType: "rollcall_settings", targetId: id,
      summary: `${target}的点名设置已保存（${settingsSummary(settings).join("、")}）`,
      details: { scopeType: input.scopeType, scopeId, revision, ...settings },
    });
    return { ...settings, scopeType: input.scopeType, scopeId, revision, updatedAt: timestamp };
  }).immediate();
}

/** 设备出发由近及远的作用域链：本机 → 各级组织祖先（最深优先）→ 全校。 */
function deviceRollCallChain(db: Database.Database, deviceId: string): { scopeType: RollCallScopeType; scopeId: string | null }[] {
  const device = db.prepare("SELECT org_node_id orgNodeId FROM devices WHERE id=?").get(deviceId) as { orgNodeId: string | null } | undefined;
  if (!device) return [];
  const chain: { scopeType: RollCallScopeType; scopeId: string | null }[] = [{ scopeType: "device", scopeId: deviceId }];
  // seen 防御组织树意外成环，避免轮询死循环。
  const seen = new Set<string>();
  let nodeId = device.orgNodeId;
  while (nodeId && !seen.has(nodeId)) {
    seen.add(nodeId);
    chain.push({ scopeType: "organization", scopeId: nodeId });
    nodeId = (db.prepare("SELECT parent_id parentId FROM org_nodes WHERE id=?").get(nodeId) as { parentId: string | null } | undefined)?.parentId ?? null;
  }
  chain.push({ scopeType: "school", scopeId: null });
  return chain;
}

/** 沿作用域链逐字段就近取点名设置：某一层没表态的字段继续向外层找。 */
function resolveSettingsAlongChain(db: Database.Database, chain: { scopeType: RollCallScopeType; scopeId: string | null }[]) {
  const settings: RollCallSettings = { enabled: null, multiEnabled: null, notify: null, singleSeconds: null, multiSeconds: null };
  const sources: Record<keyof RollCallSettings, RollCallSettingSource> = {
    enabled: "local", multiEnabled: "local", notify: "local", singleSeconds: "local", multiSeconds: "local",
  };
  let deviceOverride: RollCallSettings | null = null;
  for (const scope of chain) {
    const row = findSettings(db, scope.scopeType, scope.scopeId);
    if (!row) continue;
    const current = mapSettings(row);
    if (scope.scopeType === "device")
      deviceOverride = {
        enabled: current.enabled, multiEnabled: current.multiEnabled, notify: current.notify,
        singleSeconds: current.singleSeconds, multiSeconds: current.multiSeconds,
      };
    if (settings.enabled === null && current.enabled !== null) { settings.enabled = current.enabled; sources.enabled = scope.scopeType; }
    if (settings.multiEnabled === null && current.multiEnabled !== null) { settings.multiEnabled = current.multiEnabled; sources.multiEnabled = scope.scopeType; }
    if (settings.notify === null && current.notify !== null) { settings.notify = current.notify; sources.notify = scope.scopeType; }
    if (settings.singleSeconds === null && current.singleSeconds !== null) { settings.singleSeconds = current.singleSeconds; sources.singleSeconds = scope.scopeType; }
    if (settings.multiSeconds === null && current.multiSeconds !== null) { settings.multiSeconds = current.multiSeconds; sources.multiSeconds = scope.scopeType; }
  }
  return { settings, sources, deviceOverride };
}

/**
 * 设备实际生效的点名内容：设备级 > 最近的祖先组织级 > 全校级。
 * 名单整份按就近一层取，设置按字段各自就近取；都没命中时返回空名单，
 * 设备据此清空本地缓存。命中层级一并返回，供受限账号判断能不能改。
 */
export function resolveRollCallForDevice(db: Database.Database, deviceId: string): DeviceRollCallState {
  const chain = deviceRollCallChain(db, deviceId);
  const resolved = resolveSettingsAlongChain(db, chain);
  const fallback: DeviceRollCallState = {
    revision: 0, names: [], scopeType: "none", rosterId: null,
    settings: resolved.settings, settingSources: resolved.sources, deviceOverride: resolved.deviceOverride,
  };
  for (const scope of chain) {
    const roster = findRoster(db, scope.scopeType, scope.scopeId);
    if (roster)
      return { ...mapState(roster, scope.scopeType), settings: resolved.settings, settingSources: resolved.sources, deviceOverride: resolved.deviceOverride };
  }
  return fallback;
}

function mapState(roster: RollCallRoster, scopeType: RollCallScopeType): Pick<DeviceRollCallState, "revision" | "names" | "scopeType" | "rosterId"> {
  return { revision: roster.revision, names: roster.names, scopeType, rosterId: roster.id };
}

/** 调用者可见设备逐台的生效名单；教师据此只看到自己绑定的设备。 */
export function listEffectiveRollCall(db: Database.Database, user: ScopeUser) {
  const scope = deviceScopeFilter(db, user);
  const devices = db.prepare(`SELECT d.id deviceId,d.name deviceName FROM devices d WHERE ${scope.sql} AND d.disabled_at IS NULL ORDER BY d.name`)
    .all(...scope.params) as { deviceId: string; deviceName: string }[];
  return devices.map((device) => ({ ...device, ...resolveRollCallForDevice(db, device.deviceId) }));
}