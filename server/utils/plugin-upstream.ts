import type Database from "better-sqlite3";
import {
  CONTROL_PLUGIN_ID,
  MAX_PLUGIN_RELEASE_BYTES,
  PLUGIN_UPSTREAM_DEFAULT_PROXIES,
  PLUGIN_UPSTREAM_DEFAULT_REPO,
  normalizePluginProxyPrefix,
  pluginProxyPrefixError,
  type PluginUpstreamConfigInput,
} from "../../shared/schemas";
import { CipxError, readCipxManifest } from "./cipx";
import { nowIso } from "./database";
import { PLUGIN_RELEASE_VERSION_PATTERN, pluginReleaseExists, writePluginRelease } from "./plugin-release-store";
import { comparePluginVersions } from "./plugin-updates";
import { appendAuditWithin, sha256 } from "./security";

/**
 * 通过镜像站检测 GitHub 上已发布的插件版本。
 *
 * 这一层只回答「上游现在是哪一版、包在哪」，不动任何设备的目标版本：
 * 拉取入库是管理员在界面上点出来的，点完也只是多出一个可选的发布版本，
 * 不会自动成为当前版本——静默升级全校的开关必须一直留在人手里。
 */
export type PluginUpstreamConfig = { enabled: boolean; repo: string; proxies: string[]; intervalMinutes: number };
export type PluginUpstreamState = {
  checkedAt: string;
  ok: boolean;
  version: string | null;
  tagName: string | null;
  assetName: string | null;
  assetUrl: string | null;
  sha256: string | null;
  sizeBytes: number | null;
  via: "proxy" | "direct" | null;
  error: string | null;
};

const CONFIG_KEY = "plugin.upstream.config";
const STATE_KEY = "plugin.upstream.state";
const DEFAULT_CONFIG: PluginUpstreamConfig = { enabled: true, repo: PLUGIN_UPSTREAM_DEFAULT_REPO, proxies: [...PLUGIN_UPSTREAM_DEFAULT_PROXIES], intervalMinutes: 30 };
const API_BASE = "https://api.github.com/repos/";
/** 上游附件名由发布流程决定，写死在这里：换名等于换约定，不该由网络那侧说了算。 */
const PLUGIN_RELEASE_ASSET_NAME = "ClassIsland.Control.Plugin.cipx";
/** 只认 github 自己的域：直连时它会把下载重定向到签名过的对象存储，别的落点一律不收。 */
const TRUSTED_DOWNLOAD_HOST_SUFFIXES = ["github.com", "githubusercontent.com"];
/** 检查一次最多占 12 秒；下载一份包最多占 90 秒。超了就当这次没成功，留给下一轮。 */
const CHECK_TIMEOUT_MS = 12_000;
/** 预置镜像里总有一两家是死的，走镜像的检查只给它 6 秒，别让手点「立即检查」的人陪着等满 12 秒。 */
const MIRROR_CHECK_TIMEOUT_MS = 6_000;
const DOWNLOAD_TIMEOUT_MS = 90_000;
/** 出站失败的常见错误码翻成人话：这句会直接显示在管理页上，不能是 undici 的内部黑话。 */
const NETWORK_ERROR_LABELS: Record<string, string> = {
  UND_ERR_CONNECT_TIMEOUT: "连接超时",
  ETIMEDOUT: "连接超时",
  ECONNREFUSED: "对方拒绝连接",
  ECONNRESET: "连接被中断",
  ECONNABORTED: "连接被中断",
  UND_ERR_SOCKET: "连接被中断",
  EPIPE: "连接被中断",
  ENOTFOUND: "域名解析不到",
  EAI_AGAIN: "域名解析失败",
  UND_ERR_INVALID_ARG: "地址不合规则",
  ERR_TLS_CERT_ALTNAME_INVALID: "证书与域名对不上",
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: "证书链校验不过",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "证书链校验不过",
  DEPTH_ZERO_SELF_SIGNED_CERT: "对方用的是自签证书",
  CERT_HAS_EXPIRED: "对方证书已过期",
};

function readStateValue(db: Database.Database, key: string) {
  return (db.prepare("SELECT value FROM system_state WHERE key=?").get(key) as { value: string } | undefined)?.value;
}

function writeStateValue(db: Database.Database, key: string, value: string, at = nowIso()) {
  db.prepare(`INSERT INTO system_state (key,value,updated_at) VALUES (?,?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).run(key, value, at);
}

/** 配置坏了也不能让页面打不开：逐字段回落到默认值，只认合规则的镜像前缀。 */
export function readPluginUpstreamConfig(db: Database.Database): PluginUpstreamConfig {
  const raw = readStateValue(db, CONFIG_KEY);
  if (!raw) return { ...DEFAULT_CONFIG, proxies: [...PLUGIN_UPSTREAM_DEFAULT_PROXIES] };
  let parsed: Partial<PluginUpstreamConfigInput> | null = null;
  try {
    parsed = JSON.parse(raw) as Partial<PluginUpstreamConfigInput>;
  } catch {
    parsed = null;
  }
  if (!parsed) return { ...DEFAULT_CONFIG, proxies: [...PLUGIN_UPSTREAM_DEFAULT_PROXIES] };
  const interval = Number(parsed.intervalMinutes);
  return {
    enabled: parsed.enabled === true,
    repo: typeof parsed.repo === "string" && parsed.repo.trim() ? parsed.repo.trim() : DEFAULT_CONFIG.repo,
    proxies: (Array.isArray(parsed.proxies) ? parsed.proxies : [])
      .filter((item): item is string => typeof item === "string" && pluginProxyPrefixError(item) === null)
      .map((item) => normalizePluginProxyPrefix(item)),
    intervalMinutes: Number.isInteger(interval) && interval >= 10 && interval <= 1440 ? interval : DEFAULT_CONFIG.intervalMinutes,
  };
}

export function writePluginUpstreamConfig(db: Database.Database, input: PluginUpstreamConfigInput): PluginUpstreamConfig {
  const config: PluginUpstreamConfig = {
    enabled: input.enabled,
    repo: input.repo.trim(),
    proxies: [...new Set(input.proxies.map((item) => normalizePluginProxyPrefix(item)))],
    intervalMinutes: input.intervalMinutes,
  };
  writeStateValue(db, CONFIG_KEY, JSON.stringify(config));
  // 关掉检测就撤掉上一次的结果：留着它，界面会一直举着一个再没人确认过的「新版本」。
  if (!config.enabled) db.prepare("DELETE FROM system_state WHERE key=?").run(STATE_KEY);
  return config;
}

export function readPluginUpstreamState(db: Database.Database): PluginUpstreamState | null {
  const raw = readStateValue(db, STATE_KEY);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as PluginUpstreamState;
    return typeof value.checkedAt === "string" ? value : null;
  } catch {
    return null;
  }
}

export function writePluginUpstreamState(db: Database.Database, state: PluginUpstreamState) {
  writeStateValue(db, STATE_KEY, JSON.stringify(state));
}

/**
 * GitHub 的标签是 `v0.1.7`，清单里的版本是 `0.1.7.0`。
 * CI 里比较两者时也是补成四段，这里同一套规则：只接受纯数字段，带 `-beta` 之类后缀的一律不认，
 * 因为那种标签对应的包不会出现在正式升级路径里。
 */
export function normalizeUpstreamVersion(tag: string | null | undefined): string | null {
  const match = /^v?(\d{1,4})\.(\d{1,4})\.(\d{1,4})(?:\.(\d{1,4}))?$/.exec((tag ?? "").trim());
  if (!match) return null;
  return [match[1], match[2], match[3], match[4] ?? "0"].join(".");
}

/** 依次回退的候选地址：先按填的顺序走镜像，最后才直连 api.github.com。 */
export function pluginUpstreamCandidates(config: PluginUpstreamConfig): { url: string; via: "proxy" | "direct" }[] {
  const target = `${API_BASE}${config.repo}/releases/latest`;
  const throughProxy = config.proxies
    .filter((prefix) => pluginProxyPrefixError(prefix) === null)
    .map((prefix) => ({ url: `${normalizePluginProxyPrefix(prefix)}${target}`, via: "proxy" as const }));
  return [...throughProxy, { url: target, via: "direct" as const }];
}

export type UpstreamFetch = (url: string, init: RequestInit) => Promise<Response>;
type UpstreamRedirect = "error" | "follow";

function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  if (/abort/i.test(error.name) || /abort/i.test(error.message)) return "等得太久，已取消";
  const code = (error as { code?: unknown }).code ?? (error.cause as { code?: unknown } | undefined)?.code;
  if (typeof code === "string" && NETWORK_ERROR_LABELS[code]) return NETWORK_ERROR_LABELS[code]!;
  // node 的出站失败一律包成 "fetch failed"，真正的原因在 cause 里；只把这一层挖出来，其余照原样报。
  if (error.message === "fetch failed")
    return error.cause instanceof Error ? errorText(error.cause) : "连不上对方站点";
  return error.message;
}

/** 同一句失败原因在镜像和直连上会各出现一次，报一遍就够。 */
function summarizeFailures(failures: string[]) {
  return [...new Set(failures)].slice(-3).join("；");
}

function pickAsset(assets: unknown): { name: string; url: string; sha256: string | null; sizeBytes: number | null } | null {
  const rows = (Array.isArray(assets) ? assets : []).filter((item): item is Record<string, unknown> => !!item && typeof item === "object");
  // 一个 release 里可能同时有 .cipx 与校验文件，只认 .cipx；命名精确的那个优先，其余只作兜底。
  const cipx = rows
    .map((row) => ({
      name: typeof row.name === "string" ? row.name : "",
      url: typeof row.browser_download_url === "string" ? row.browser_download_url : "",
      digest: typeof row.digest === "string" ? row.digest : "",
      size: typeof row.size === "number" ? row.size : null,
    }))
    .filter((row) => row.name.toLowerCase().endsWith(".cipx") && /^https:\/\//.test(row.url));
  const asset = cipx.find((row) => row.name === PLUGIN_RELEASE_ASSET_NAME) ?? cipx[0];
  if (!asset) return null;
  const digest = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest);
  return {
    name: asset.name,
    url: asset.url,
    sha256: digest ? digest[1]!.toLowerCase() : null,
    sizeBytes: asset.size !== null && Number.isInteger(asset.size) && asset.size > 0 ? asset.size : null,
  };
}

/** 只认 GitHub releases 里那两个必需字段，镜像返回别的东西（登录页、错误页）就当失败。 */
function parseReleaseDoc(value: unknown): { tagName: string; asset: ReturnType<typeof pickAsset> } | null {
  if (!value || typeof value !== "object") return null;
  const doc = value as Record<string, unknown>;
  if (typeof doc.tag_name !== "string") return null;
  return { tagName: doc.tag_name, asset: pickAsset(doc.assets) };
}

/**
 * 取上游最新 release：网络失败或格式不对都不会抛，而是带着一句人话回来，
 * 因为这条结果要直接显示在管理页上，「检查失败：xxx」比一个红色 toast 更有用。
 */
export async function fetchPluginUpstreamRelease(
  config: PluginUpstreamConfig,
  options: { fetchImpl?: UpstreamFetch; now?: () => string } = {},
): Promise<PluginUpstreamState> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const checkedAt = options.now?.() ?? nowIso();
  const failures: string[] = [];
  for (const candidate of pluginUpstreamCandidates(config)) {
    try {
      const response = await fetchImpl(candidate.url, {
        headers: { accept: "application/vnd.github+json", "user-agent": "classisland-control-server" },
        signal: AbortSignal.timeout(candidate.via === "proxy" ? MIRROR_CHECK_TIMEOUT_MS : CHECK_TIMEOUT_MS),
        redirect: "error",
      });
      if (!response.ok) {
        failures.push(`${candidate.via === "proxy" ? "镜像" : "直连"}返回 ${response.status}`);
        continue;
      }
      const doc = parseReleaseDoc(await response.json());
      if (!doc) {
        failures.push(`${candidate.via === "proxy" ? "镜像" : "直连"}返回的内容不是发布版本信息`);
        continue;
      }
      const version = normalizeUpstreamVersion(doc.tagName);
      if (!version) {
        // 取到的是最新 release 但标签读不懂：这是上游发版习惯变了，重试别处也没用，直接停下。
        return failedState(checkedAt, `上游最新发布标签 ${doc.tagName} 不是可用的版本号。`);
      }
      if (!doc.asset) {
        return failedState(checkedAt, `上游 ${doc.tagName} 里没有 .cipx 插件包。`);
      }
      return {
        checkedAt, ok: true, version, tagName: doc.tagName, assetName: doc.asset.name, assetUrl: doc.asset.url,
        sha256: doc.asset.sha256, sizeBytes: doc.asset.sizeBytes, via: candidate.via, error: null,
      };
    } catch (error) {
      failures.push(`${candidate.via === "proxy" ? "镜像" : "直连"}：${errorText(error)}`);
    }
  }
  return failedState(checkedAt, `镜像与直连都没取到上游版本（${summarizeFailures(failures)}）`);
}

function failedState(checkedAt: string, error: string): PluginUpstreamState {
  return {
    checkedAt, ok: false, version: null, tagName: null, assetName: null, assetUrl: null,
    sha256: null, sizeBytes: null, via: null, error,
  };
}

/** 到点没有：没开检测、从没查过、或距上次检查还不够一个间隔。 */
export function pluginUpstreamDue(db: Database.Database, now = nowIso()) {
  const config = readPluginUpstreamConfig(db);
  if (!config.enabled) return false;
  const state = readPluginUpstreamState(db);
  if (!state) return true;
  const last = Date.parse(state.checkedAt);
  if (!Number.isFinite(last)) return true;
  return Date.parse(now) - last >= config.intervalMinutes * 60_000;
}

/**
 * 出门抓一次并记下结果，不做任何到期判断：界面按下「立即检查」走的就是这条。
 *
 * 抓取一定跑在事务外——它要等网络，一旦落进 IMMEDIATE 事务，一个慢镜像就会把整台服务端的写锁按住。
 */
export async function runPluginUpstreamCheck(
  db: Database.Database,
  options: { fetchImpl?: UpstreamFetch; now?: () => string } = {},
): Promise<PluginUpstreamState> {
  const state = await fetchPluginUpstreamRelease(readPluginUpstreamConfig(db), options);
  db.transaction(() => writePluginUpstreamState(db, state)).immediate();
  return state;
}

/** 定时巡检入口：没到间隔就什么都不做，到了才出门。 */
export async function advancePluginUpstream(db: Database.Database, options: { fetchImpl?: UpstreamFetch; now?: () => string } = {}) {
  if (!pluginUpstreamDue(db)) return readPluginUpstreamState(db);
  return runPluginUpstreamCheck(db, options);
}

/** 界面要的那份视图：配置、最近一次结果、以及「比库里最新的还新吗」。 */
export function pluginUpstreamView(db: Database.Database) {
  const config = readPluginUpstreamConfig(db);
  const state = readPluginUpstreamState(db);
  const releases = db.prepare("SELECT version,is_current isCurrent FROM plugin_releases").all() as { version: string; isCurrent: number }[];
  const newest = releases.map((row) => row.version).sort((a, b) => comparePluginVersions(b, a))[0] ?? null;
  const current = releases.find((row) => row.isCurrent === 1)?.version ?? null;
  const upstream = state?.ok ? state.version : null;
  // 「已在库中」要连文件一起看：只有行的（包被清掉了）仍该给出拉取入口。
  const imported = !!upstream && releases.some((row) => row.version === upstream) && pluginReleaseExists(upstream);
  return {
    config,
    state,
    newestInstalled: newest,
    currentVersion: current,
    // 「有新版本」只对库里的最新版本而言：撤回过的旧版重新出现在上游不算新。
    hasUpdate: !!upstream && (newest === null || comparePluginVersions(upstream, newest) > 0),
    imported,
  };
}

export type PluginUpstreamIngest = { version: string; fileName: string; sizeBytes: number; sha256: string; isCurrent: boolean };

/**
 * 把检测结果里那一版取回来入库。
 *
 * 取回后按上传路径同一套标准验收：大小、清单、插件标识、清单里的版本必须就是我们要的那一版，
 * 上游给了摘要就再比一次 sha256。任何一条不过都不落库，也不会留下半截文件。
 */
export async function importPluginUpstreamRelease(
  db: Database.Database,
  actorId: string,
  options: { version: string; fetchImpl?: UpstreamFetch; now?: () => string },
): Promise<PluginUpstreamIngest> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const state = readPluginUpstreamState(db);
  if (!state?.ok || !state.version || !state.assetUrl)
    throw createError({ statusCode: 409, message: "还没有可用的上游版本信息，先检查一次。" });
  if (state.version !== options.version)
    throw createError({ statusCode: 409, message: `检测结果已经变成 ${state.version}，请看清界面后再拉取。` });
  if (state.sizeBytes !== null && (state.sizeBytes === 0 || state.sizeBytes > MAX_PLUGIN_RELEASE_BYTES))
    throw createError({ statusCode: 413, message: "上游包的体积超出可接收范围。" });

  const config = readPluginUpstreamConfig(db);
  const bytes = await downloadUpstreamAsset(state.assetUrl, config, fetchImpl);
  let manifest: { id: string; version: string; name: string | null };
  try {
    manifest = readCipxManifest(bytes);
  } catch (error) {
    throw createError({ statusCode: 400, message: error instanceof CipxError ? `上游包读不出清单：${error.message}` : "上游包读不出清单。" });
  }
  if (manifest.id !== CONTROL_PLUGIN_ID)
    throw createError({ statusCode: 400, message: `上游包不是本集控插件的包（清单里的插件标识为 ${manifest.id}）。` });
  if (manifest.version !== options.version || !PLUGIN_RELEASE_VERSION_PATTERN.test(manifest.version))
    throw createError({ statusCode: 400, message: `上游包清单里的版本是 ${manifest.version}，与检测到的 ${options.version} 不一致。` });
  const digest = sha256(bytes);
  if (state.sha256 && state.sha256 !== digest)
    throw createError({ statusCode: 400, message: "上游包与它自己公布的摘要不一致，已拒收。" });

  const stored = writePluginRelease(manifest.version, bytes);
  const createdAt = options.now?.() ?? nowIso();
  return db.transaction(() => {
    const existing = db.prepare("SELECT is_current isCurrent FROM plugin_releases WHERE version=?").get(manifest.version) as { isCurrent: number } | undefined;
    // 拉进来只多一个可选版本；当前版本没被单独设过目标时全校跟着它走，所以绝不动 is_current。
    const isCurrent = existing?.isCurrent === 1;
    db.prepare(`INSERT INTO plugin_releases (version,file_name,size_bytes,sha256,is_current,created_by,created_at)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(version) DO UPDATE SET file_name=excluded.file_name,size_bytes=excluded.size_bytes,sha256=excluded.sha256`)
      .run(manifest.version, stored.fileName, stored.sizeBytes, stored.sha256, isCurrent ? 1 : 0, actorId, createdAt);
    const result: PluginUpstreamIngest = { version: manifest.version, fileName: stored.fileName, sizeBytes: stored.sizeBytes, sha256: stored.sha256, isCurrent };
    appendAuditWithin(db, {
      actorType: "user", actorId, action: "plugin.release_import", targetType: "plugin_release", targetId: manifest.version,
      summary: `从上游拉取插件包 ${manifest.version}${manifest.name ? `（${manifest.name}）` : ""}`,
      details: { version: manifest.version, source: state.tagName, assetName: state.assetName, via: state.via, sizeBytes: stored.sizeBytes, sha256: stored.sha256 },
    });
    return result;
  })();
}

async function downloadUpstreamAsset(assetUrl: string, config: PluginUpstreamConfig, fetchImpl: UpstreamFetch) {
  const proxied = config.proxies
    .filter((prefix) => pluginProxyPrefixError(prefix) === null)
    .map((prefix) => `${normalizePluginProxyPrefix(prefix)}${assetUrl}`);
  const failures: string[] = [];
  // 镜像不需要重定向，给了就不收：管理员挑的镜像是可信第三方，但不是可以替 github 把我们领到内网的第三方。
  // 直连则由 github 自己重定向到对象存储，落点必须仍在 github 的域里。
  const attempts: { url: string; redirect: UpstreamRedirect }[] = [
    ...proxied.map((url) => ({ url, redirect: "error" as UpstreamRedirect })),
    { url: assetUrl, redirect: "follow" as UpstreamRedirect },
  ];
  for (const attempt of attempts) {
    try {
      const response = await fetchImpl(attempt.url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS), redirect: attempt.redirect });
      if (!response.ok) {
        failures.push(`返回 ${response.status}`);
        continue;
      }
      if (attempt.redirect === "follow" && !isTrustedDownloadUrl(response.url || attempt.url)) {
        failures.push("落点不是 github 的下载地址");
        continue;
      }
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > MAX_PLUGIN_RELEASE_BYTES)
        throw createError({ statusCode: 413, message: "上游包的体积超出可接收范围。" });
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length === 0 || bytes.length > MAX_PLUGIN_RELEASE_BYTES)
        throw createError({ statusCode: 413, message: "上游包大小需在 1 字节至 25 MiB 之间。" });
      return bytes;
    } catch (error) {
      // 体积超限这类结论换个地址也不会变，直接报出去；网络错才继续回退。
      if ((error as { statusCode?: number }).statusCode) throw error;
      failures.push(errorText(error));
    }
  }
  throw createError({ statusCode: 502, message: `镜像与直连都没取到上游包（${summarizeFailures(failures)}）` });
}

function isTrustedDownloadUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    return TRUSTED_DOWNLOAD_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  } catch {
    return false;
  }
}
