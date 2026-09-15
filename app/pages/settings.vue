<script setup lang="ts">
type BackupRow = { name: string; ok: boolean; createdAt: string | null; sizeBytes: number };
type SystemData = { initialized: boolean; database: string; version: string; lastBackupAt: string | null; backups: BackupRow[] };
const { data, refresh } = await useFetch<SystemData>("/api/v1/admin/system", { default: () => ({ initialized: false, database: "SQLite WAL", version: "0.1.0", lastBackupAt: null, backups: [] }) });
const busy = ref(false); const toast = useToast();
function formatSize(bytes: number) { return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`; }
async function createBackup() {
  busy.value = true;
  try {
    await $fetch("/api/v1/admin/system/backups", { method: "POST", headers: { origin: location.origin } });
    toast.ok("已生成一致性备份 bundle。"); await refresh();
  } catch (err) { toast.err((err as { data?: { message?: string } })?.data?.message ?? "创建备份失败。"); }
  finally { busy.value = false; }
}
</script>

<template>
  <PageHeading kicker="SYSTEM / 控制平面" title="系统" description="检查运行模式、数据库、签名密钥和备份状态。SQLite 版本只允许单进程写入同一数据目录。"><button type="button" :disabled="busy" @click="createBackup">{{ busy ? "备份中…" : "创建备份" }}</button></PageHeading>

  <section class="settings-grid"><article><span>DATABASE</span><strong>{{ data.database }}</strong><p>单实例、短事务、显式在线备份。</p></article><article><span>SERVER VERSION</span><strong>{{ data.version }}</strong><p>协议能力通过版本化 schema 协商。</p></article><article><span>INITIALIZATION</span><strong>{{ data.initialized ? "已完成" : "待首设" }}</strong><p>首位管理员创建后首设入口永久关闭。</p></article></section>
  <section class="backups"><header><div><span>BACKUP BUNDLES</span><h2>备份与恢复</h2></div><small>最近备份：{{ data.lastBackupAt || "尚无" }}</small></header>
    <p class="hint">备份包含 SQLite 一致性快照、服务端签名私钥与清单哈希。恢复需先停止服务，再执行 <code>node scripts/restore.mjs &lt;备份目录&gt;</code>。</p>
    <ul v-if="data.backups.length"><li v-for="backup in data.backups" :key="backup.name"><div><strong>{{ backup.name }}</strong><small>{{ backup.createdAt }} · {{ formatSize(backup.sizeBytes) }}</small></div><span class="state" :data-ok="backup.ok">{{ backup.ok ? "校验通过" : "校验失败" }}</span></li></ul>
    <p v-else class="hint">尚无备份。</p>
  </section>
</template>

<style scoped>

.settings-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; margin-top: 14px; }.settings-grid article { min-height: 190px; padding: 24px; border-radius: var(--radius-md); background: var(--surface-1); }.settings-grid span { color: var(--ink-muted); font-size: 9px; letter-spacing: .11em; }.settings-grid strong { display: block; margin: 40px 0 12px; font-size: 25px; }.settings-grid p { color: var(--ink-soft); font-size: 11px; line-height: 1.6; }
.backups { margin-top: 14px; padding: 24px; border-radius: var(--radius-md); background: var(--surface-1); }.backups header { display: flex; justify-content: space-between; align-items: end; }.backups header span { color: var(--ink-muted); font-size: 9px; letter-spacing: .12em; }.backups h2 { margin: 7px 0 0; font-size: 21px; }.backups header small { color: var(--ink-muted); font-size: 10px; }.hint { margin: 14px 0; color: var(--ink-soft); font-size: 11px; line-height: 1.7; }.hint code { font-family: ui-monospace, monospace; }.backups ul { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }.backups li { display: flex; justify-content: space-between; align-items: center; padding: 14px; border-radius: 14px; background: var(--surface-2); }.backups li div { display: grid; gap: 4px; }.backups li small { color: var(--ink-muted); font-size: 9px; }.state { display: inline-flex; align-items: center; gap: 7px; font-size: 11px; }.state::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--bad); }.state[data-ok="true"]::before { background: var(--good); }
@media (max-width: 750px) { .settings-grid { grid-template-columns: 1fr; }.backups header { flex-direction: column; align-items: start; gap: 8px; } }
</style>