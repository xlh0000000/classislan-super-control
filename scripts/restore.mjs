import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const bundleArg = args.find((arg) => !arg.startsWith("--"));
const force = args.includes("--force");
const dataDir = resolve(process.env.CLASSISLAND_CONTROL_DATA_DIR || "./data");
if (!bundleArg) {
  console.error("用法：node scripts/restore.mjs <备份目录> [--force]");
  console.error("请在控制平面进程停止、数据库连接关闭后执行。");
  process.exit(1);
}
const directory = resolve(bundleArg);
const manifestPath = resolve(directory, "manifest.json");
if (!existsSync(manifestPath)) {
  console.error(`缺少清单：${manifestPath}`);
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (manifest.formatVersion !== 1) {
  console.error(`不支持的备份格式版本：${manifest.formatVersion}`);
  process.exit(1);
}
const reasons = [];
const sha256File = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
for (const file of manifest.files) {
  const path = resolve(directory, file.name);
  if (!existsSync(path)) { reasons.push(`缺少文件 ${file.name}`); continue; }
  if (statSync(path).size !== file.sizeBytes) reasons.push(`文件 ${file.name} 长度不符`);
  if (sha256File(path) !== file.sha256) reasons.push(`文件 ${file.name} 哈希不符`);
}
const dbPath = resolve(directory, "classisland-control.db");
if (!existsSync(dbPath)) reasons.push("缺少数据库文件");
else {
  try {
    const probe = new Database(dbPath, { readonly: true, fileMustExist: true });
    const check = probe.prepare("PRAGMA quick_check").get();
    if (check?.quick_check !== "ok") reasons.push("数据库完整性检查失败");
    const applied = probe.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get();
    if (!applied || applied.count !== manifest.schemaVersion) reasons.push("迁移版本与清单不一致");
    probe.close();
  } catch {
    reasons.push("数据库无法打开");
  }
}
const currentDb = resolve(dataDir, "classisland-control.db");
if (existsSync(currentDb)) {
  const currentKeyPath = resolve(dataDir, "server-signing-public.der");
  if (existsSync(currentKeyPath)) {
    const currentKeyId = createHash("sha256").update(readFileSync(currentKeyPath)).digest("hex");
    if (manifest.signingKeyId && manifest.signingKeyId !== currentKeyId) {
      reasons.push("备份签名身份与当前数据目录不同；恢复后所有已接入设备需要重新信任");
    }
  }
}
if (reasons.length && !force) {
  console.error("备份校验失败：");
  for (const reason of reasons) console.error(`- ${reason}`);
  console.error("如确认风险，可加 --force 覆盖。");
  process.exit(1);
}
mkdirSync(dataDir, { recursive: true });
const stashDir = resolve(dataDir, `.restore-stash-${new Date().toISOString().replace(/[:.]/g, "-")}`);
mkdirSync(stashDir, { recursive: true });
for (const file of manifest.files) {
  const source = resolve(directory, file.name);
  const target = resolve(dataDir, file.name);
  if (existsSync(target)) renameSync(target, resolve(stashDir, file.name));
  copyFileSync(source, target);
  console.log(`已恢复 ${file.name}`);
}
// 恢复会产生一次新的数据集代次：强制推进期望状态 epoch，
// 使所有设备在该恢复点之后重新同步，而不是沿用恢复前的 applied 状态。
try {
  const restored = new Database(resolve(dataDir, "classisland-control.db"));
  restored.pragma("journal_mode = WAL");
  const now = new Date().toISOString();
  restored.prepare(`INSERT INTO policy_state (id,desired_epoch,restore_generation,updated_at) VALUES (1,1,1,?)
    ON CONFLICT(id) DO UPDATE SET desired_epoch=desired_epoch+1, restore_generation=restore_generation+1, updated_at=excluded.updated_at`).run(now);
  const row = restored.prepare("SELECT desired_epoch epoch, restore_generation generation FROM policy_state WHERE id=1").get();
  restored.close();
  console.log(`恢复代次已推进：desiredEpoch=${row.epoch} restoreGeneration=${row.generation}`);
} catch (error) {
  console.error(`警告：无法推进恢复 epoch（${error.message}），请在启动前人工校验策略状态。`);
  process.exitCode = 1;
}
console.log(`原文件已暂存于：${stashDir}`);
console.log("现在可以重新启动控制平面（node .output/server/index.mjs）。");