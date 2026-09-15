export default defineEventHandler(() => {
  const probe = probeDatabase();
  if (!probe.ok) {
    throw createError({ statusCode: 503, message: `数据库不可用：${probe.reason}` });
  }
  return { status: "ok", version: "0.1.0", database: "sqlite-wal", schemaVersion: probe.schemaVersion };
});