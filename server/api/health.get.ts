export default defineEventHandler((event) => {
  const probe = probeDatabase();
  if (!probe.ok) {
    throw createError({ statusCode: 503, message: `数据库不可用：${probe.reason}` });
  }
  return { status: "ok", version: useRuntimeConfig(event).appVersion, database: "sqlite-wal", schemaVersion: probe.schemaVersion };
});