import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 发布物落在数据目录里，而数据目录由 Nitro 运行时配置给出；测试用临时目录替身。
const hoisted = vi.hoisted(() => ({ dir: "" }));
vi.mock("../server/utils/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/utils/database")>();
  return { ...actual, databasePath: () => join(hoisted.dir, "classisland-control.db") };
});

import { sha256 } from "../server/utils/security";

const { MAX_PLUGIN_RELEASE_BYTES, pluginReleaseDir, pluginReleaseExists, pluginReleasePath, readPluginRelease, removePluginRelease, writePluginRelease } =
  await import("../server/utils/plugin-release-store");

const BYTE = (n: number) => Buffer.alloc(n, 0x61);

function tempDataDir() {
  const dir = mkdtempSync(join(tmpdir(), "cip-release-"));
  hoisted.dir = dir;
  return dir;
}

describe("plugin release 包存储", () => {
  it("以版本号命名落在数据目录旁，读写删除自成一套", () => {
    const dir = tempDataDir();
    try {
      const written = writePluginRelease("0.1.7.0", BYTE(2048));
      expect(written).toEqual({ fileName: "0.1.7.0.cipx", sizeBytes: 2048, sha256: sha256(BYTE(2048)) });
      expect(pluginReleasePath("0.1.7.0")).toBe(join(dir, "plugin-releases", "0.1.7.0.cipx"));
      expect(pluginReleaseExists("0.1.7.0")).toBe(true);
      expect(readPluginRelease("0.1.7.0")).toEqual(BYTE(2048));
      // 目录只应有改名后的正式文件，不留 .tmp。
      expect(readdirSync(pluginReleaseDir())).toEqual(["0.1.7.0.cipx"]);
      removePluginRelease("0.1.7.0");
      expect(pluginReleaseExists("0.1.7.0")).toBe(false);
      expect(readPluginRelease("0.1.7.0")).toBeNull();
      expect(() => removePluginRelease("0.1.7.0")).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("版本号不是四段数字就不碰文件系统", () => {
    const dir = tempDataDir();
    try {
      writePluginRelease("0.1.7.0", BYTE(16));
      const before = readdirSync(pluginReleaseDir());
      for (const bad of ["../evil", "0.1.7", "0.1.7.0.0", "0.1.7.0.cipx", "1..2.3.4", "", "0.1.7.0\u0000"]) {
        expect(() => pluginReleasePath(bad)).toThrow(/非法的插件版本号/);
        expect(() => writePluginRelease(bad, BYTE(16))).toThrow(/非法的插件版本号/);
      }
      expect(readdirSync(pluginReleaseDir())).toEqual(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("空包与超限包拒收，且不留临时文件", () => {
    const dir = tempDataDir();
    try {
      expect(() => writePluginRelease("0.1.7.0", Buffer.alloc(0))).toThrow(/插件包大小/);
      expect(() => writePluginRelease("0.1.7.0", BYTE(MAX_PLUGIN_RELEASE_BYTES + 1))).toThrow(/插件包大小/);
      // 目录只在首次成功写入时才建，拒收不该留下半个目录。
      expect(existsSync(pluginReleaseDir())).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("重传同一版本是覆盖，不是报错", () => {
    const dir = tempDataDir();
    try {
      writePluginRelease("0.1.7.0", BYTE(64));
      const again = writePluginRelease("0.1.7.0", BYTE(96));
      expect(again.sizeBytes).toBe(96);
      expect(readPluginRelease("0.1.7.0")).toEqual(BYTE(96));
      expect(readdirSync(pluginReleaseDir())).toEqual(["0.1.7.0.cipx"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
