import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const dataDir = resolve(process.env.CLASSISLAND_CONTROL_DATA_DIR || "./data");
const dbPath = resolve(dataDir, "classisland-control.db");
if (!existsSync(dbPath)) {
  console.error(`数据库不存在：${dbPath}`);
  process.exit(1);
}
const now = new Date().toISOString();
const directory = resolve(dataDir, "backups", `backup-${now.replace(/[:.]/g, "-")}`);
mkdirSync(directory, { recursive: true });

const db = new Database(dbPath, { readonly: true, fileMustExist: true });
await db.backup(resolve(directory, "classisland-control.db"));
const schemaVersion = db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get().count;
db.close();

const sha256File = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const files = [];
for (const name of ["classisland-control.db", "server-signing-private.pem", "server-signing-public.der"]) {
  const source = resolve(dataDir, name);
  if (!existsSync(source)) continue;
  const target = resolve(directory, name);
  if (name !== "classisland-control.db") copyFileSync(source, target);
  files.push({ name, sha256: sha256File(target), sizeBytes: statSync(target).size });
}

let signingKeyId = "";
const publicKeyPath = resolve(directory, "server-signing-public.der");
if (existsSync(publicKeyPath)) signingKeyId = createHash("sha256").update(readFileSync(publicKeyPath)).digest("hex");

writeFileSync(
  resolve(directory, "manifest.json"),
  JSON.stringify({ formatVersion: 1, createdAt: now, schemaVersion, signingKeyId, files }, null, 2),
);
console.log(`已创建备份 bundle：${directory}`);