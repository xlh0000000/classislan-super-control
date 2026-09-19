<script setup lang="ts">
type BackupRow = { name: string; ok: boolean; createdAt: string | null; sizeBytes: number };
type SystemData = { initialized: boolean; database: string; version: string; lastBackupAt: string | null; backups: BackupRow[] };
const { data, refresh } = await useFetch<SystemData>("/api/v1/admin/system", {
  default: () => ({ initialized: false, database: "SQLite WAL", version: "—", lastBackupAt: null, backups: [] }),
});
const busy = ref(false); const toast = useToast();
function formatSize(bytes: number) { return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`; }
async function createBackup() {
  busy.value = true;
  try {
    await $fetch("/api/v1/admin/system/backups", { method: "POST", headers: { origin: location.origin } });
    toast.ok("备份已生成。"); await refresh();
  } catch (err) { toast.err((err as { data?: { message?: string } })?.data?.message ?? "备份失败。"); }
  finally { busy.value = false; }
}
</script>

<template>
  <PageHeading kicker="服务状态与备份" title="系统">
    <button type="button" class="solid" :disabled="busy" @click="createBackup">{{ busy ? "备份中…" : "创建备份" }}</button>
  </PageHeading>

  <section class="facts">
    <article class="fact rise"><span>数据库</span><strong>{{ data.database }}</strong><small>一个数据目录只能跑一个进程</small></article>
    <article class="fact rise" style="--i: 1"><span>服务版本</span><strong>{{ data.version }}</strong><small>新旧版本能互通</small></article>
    <article class="fact rise" style="--i: 2"><span>初始化</span><strong>{{ data.initialized ? "已完成" : "待首设" }}</strong><small>建好管理员后入口就关</small></article>
  </section>

  <section class="panel backups">
    <header class="panel-head">
      <h2>备份</h2>
      <small class="micro">最近一次：{{ data.lastBackupAt || "尚无" }}</small>
    </header>
    <p class="hint">恢复前先停服务，再执行 <code>node scripts/restore.mjs &lt;备份目录&gt;</code>。</p>
    <ul v-if="data.backups.length" class="list">
      <li v-for="backup in data.backups" :key="backup.name">
        <div class="row-main"><strong>{{ backup.name }}</strong><small>{{ backup.createdAt }} · {{ formatSize(backup.sizeBytes) }}</small></div>
        <span class="state" :data-ok="backup.ok">{{ backup.ok ? "校验通过" : "校验失败" }}</span>
      </li>
    </ul>
    <p v-else class="hint">还没有备份。</p>
  </section>
</template>

<style scoped>
.facts { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; }
.fact { display: flex; flex-direction: column; min-height: 180px; padding: 22px 24px; border: 1px solid var(--line-soft); background: var(--surface-1); }
.fact span { color: var(--ink-muted); font-size: 10px; letter-spacing: 1.2px; }
.fact strong { margin-top: auto; font-size: 26px; font-weight: 600; letter-spacing: -0.7px; }
.fact small { margin-top: 10px; color: var(--ink-faint); font-size: 10px; }
.backups { margin-top: 14px; }
.hint { margin: 16px 0; color: var(--ink-soft); font-size: 12px; line-height: 1.8; }
.hint code { font-family: ui-monospace, monospace; color: var(--ink); }
.list { border-top: 0; }
.state { display: inline-flex; align-items: center; gap: 8px; flex: none; color: var(--ink-soft); font-size: 11px; }
.state::before { content: ""; width: 7px; height: 7px; background: var(--bad); }
.state[data-ok="true"]::before { background: var(--good); }
@media (max-width: 900px) { .facts { grid-template-columns: 1fr; } }
</style>