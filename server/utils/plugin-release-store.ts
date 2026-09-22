import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MAX_PLUGIN_RELEASE_BYTES, PLUGIN_RELEASE_VERSION_PATTERN } from "../../shared/schemas";
import { databasePath } from "./database";
import { sha256 } from "./security";

// 版本规则与大小上限的唯一来源在共享 schema 里（界面也要用），这里只是转出去方便本模块调用。
export { MAX_PLUGIN_RELEASE_BYTES, PLUGIN_RELEASE_VERSION_PATTERN };

export function pluginReleaseDir() {
  return join(dirname(databasePath()), "plugin-releases");
}

export function pluginReleasePath(version: string) {
  // 版本号会进文件路径，这里拦住 `../`、空字节之类，宁可抛错也不能拼出目录外的路径。
  if (!PLUGIN_RELEASE_VERSION_PATTERN.test(version)) throw new Error(`非法的插件版本号：${version}`);
  return join(pluginReleaseDir(), `${version}.cipx`);
}

export function pluginReleaseExists(version: string) {
  return existsSync(pluginReleasePath(version));
}

export function readPluginRelease(version: string): Buffer | null {
  const path = pluginReleasePath(version);
  return existsSync(path) ? readFileSync(path) : null;
}

/**
 * 落盘一份发布物，返回真实大小与哈希（以收到的字节为准，不信任调用方声称的值）。
 * 先写临时文件再改名：并发上传同一版本时，读侧不会拿到半截文件。
 */
export function writePluginRelease(version: string, bytes: Buffer): { fileName: string; sizeBytes: number; sha256: string } {
  if (bytes.length === 0 || bytes.length > MAX_PLUGIN_RELEASE_BYTES)
    throw new Error(`插件包大小需在 1 字节至 ${Math.floor(MAX_PLUGIN_RELEASE_BYTES / (1024 * 1024))} MiB 之间。`);
  const path = pluginReleasePath(version);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, bytes, { mode: 0o640 });
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  return { fileName: `${version}.cipx`, sizeBytes: bytes.length, sha256: sha256(bytes) };
}

export function removePluginRelease(version: string) {
  rmSync(pluginReleasePath(version), { force: true });
}
