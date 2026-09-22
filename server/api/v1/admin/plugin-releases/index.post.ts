import { CONTROL_PLUGIN_ID, MAX_PLUGIN_RELEASE_BYTES, pluginReleaseUploadSchema } from "../../../../../shared/schemas";
import { CipxError, readCipxManifest } from "../../../../utils/cipx";
import { writePluginRelease } from "../../../../utils/plugin-release-store";

export default defineEventHandler(async (event) => {
  const user = event.context.user as { id: string; role: string; scopeOrgNodeId?: string | null };
  requirePermission(user, "plugins.write");
  assertSchoolWideScope(user, "插件发布包");
  const parsed = pluginReleaseUploadSchema.safeParse(await readBody(event));
  if (!parsed.success) throw createError({ statusCode: 400, message: parsed.error.issues[0]?.message ?? "上传内容无效。" });
  const bytes = Buffer.from(parsed.data.contentBase64, "base64");
  // base64 长度是粗筛，解码后再量一次：上传里塞的填充字节不该算进体积。
  if (bytes.length === 0 || bytes.length > MAX_PLUGIN_RELEASE_BYTES)
    throw createError({ statusCode: 413, message: "插件包大小需在 1 字节至 25 MiB 之间。" });

  let manifest: { id: string; version: string; name: string | null };
  try {
    manifest = readCipxManifest(bytes);
  } catch (error) {
    throw createError({ statusCode: 400, message: error instanceof CipxError ? error.message : "无法读取插件包清单。" });
  }
  // 版本以清单为准，不认表单里另填的值：文件名、库里的主键、设备比对的目标必须同源。
  if (manifest.id !== CONTROL_PLUGIN_ID)
    throw createError({ statusCode: 400, message: `这不是本集控插件的包（清单里的插件标识为 ${manifest.id}）。` });

  const stored = writePluginRelease(manifest.version, bytes);
  const createdAt = nowIso();
  withAuditedTransaction(
    (db) => {
      // 新上传即成为当前版本：没有单独设过目标的设备默认跟着它走，这就是「发一版、全校升」的默认路径。
      db.prepare("UPDATE plugin_releases SET is_current=0 WHERE is_current=1").run();
      db.prepare(`INSERT INTO plugin_releases (version,file_name,size_bytes,sha256,is_current,created_by,created_at)
        VALUES (?,?,?,?,1,?,?)
        ON CONFLICT(version) DO UPDATE SET file_name=excluded.file_name,size_bytes=excluded.size_bytes,
          sha256=excluded.sha256,is_current=1`).run(
        manifest.version, stored.fileName, stored.sizeBytes, stored.sha256, user.id, createdAt);
      return manifest.version;
    },
    () => ({
      actorType: "user", actorId: user.id, action: "plugin.release_upload", targetType: "plugin_release",
      targetId: manifest.version,
      summary: `上传插件包 ${manifest.version}${manifest.name ? `（${manifest.name}）` : ""}`,
      details: { version: manifest.version, fileName: parsed.data.fileName, sizeBytes: stored.sizeBytes, sha256: stored.sha256 },
    }),
  );
  return { version: manifest.version, name: manifest.name, sizeBytes: stored.sizeBytes, sha256: stored.sha256, isCurrent: true };
});
