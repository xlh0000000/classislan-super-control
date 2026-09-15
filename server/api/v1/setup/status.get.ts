export default defineEventHandler(() => {
  // 只读探针：未迁移或库不存在时视为未初始化，避免状态轮询顺手建库。
  const probe = probeDatabase();
  const initialized = probe.ok
    ? (useDatabase().prepare("SELECT value FROM system_state WHERE key='initialized'").get() as { value: string } | undefined)?.value === "true"
    : false;
  const bootstrap = bootstrapTokenStatus();
  return {
    initialized,
    requiresBootstrapToken: bootstrap.required,
    bootstrapTokenConfigured: bootstrap.configured,
  };
});