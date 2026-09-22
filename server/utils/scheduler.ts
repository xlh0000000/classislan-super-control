import { advanceTaskState } from "./tasks";
import { advanceSchedules } from "./auto-tasks";
import { advanceTriggers } from "./auto-triggers";
import { writeAuditCheckpoint } from "./audit-checkpoint";
import { pruneCrashReports } from "./crash-reports";
import { advancePluginUpstream } from "./plugin-upstream";

let timer: ReturnType<typeof setInterval> | null = null;
let checkpointTimer: ReturnType<typeof setInterval> | null = null;
let pruneTimer: ReturnType<typeof setInterval> | null = null;
let upstreamTimer: ReturnType<typeof setInterval> | null = null;
let upstreamBusy = false;
let started = false;

/**
 * 上游版本巡检单独跑在事务外：抓取要等网络，一旦落进 IMMEDIATE 事务，
 * 一个慢镜像就能把整台服务端的写锁按住。到达间隔与否由 advancePluginUpstream 自己判断。
 */
async function runUpstreamCheck() {
  if (upstreamBusy) return;
  upstreamBusy = true;
  try {
    await advancePluginUpstream(useDatabase());
  } catch (error) {
    console.error("[scheduler] upstream check failed", error);
  } finally {
    upstreamBusy = false;
  }
}

export function startTaskScheduler() {
  if (started) return;
  started = true;
  // 每 10 秒推进一次：scheduled 到期、租约回收、重试、失败阈值、批次激活、聚合；周期调度到期派生任务。
  timer = setInterval(() => {
    // 必须包在 IMMEDIATE 事务里：推进器现在会在任务收敛时追加审计事件，
    // 而审计序列号依赖串行写入，脱离事务与并发写请求竞争会产生序列冲突。
    try {
      const db = useDatabase();
      db.transaction(() => {
        advanceTriggers(db);
        advanceSchedules(db);
        advanceTaskState(db);
      }).immediate();
    } catch (error) { console.error("[scheduler] task advance failed", error); }
  }, 10_000);
  timer.unref();
  // 每 60 秒把审计链头签名成外部检查点，使历史被重写时可被离线发现。
  checkpointTimer = setInterval(() => {
    // 读链头与写检查点放进同一事务，避免与并发业务写入交错得到错位检查点。
    try {
      const db = useDatabase();
      db.transaction(() => writeAuditCheckpoint(db)).immediate();
    } catch (error) { console.error("[scheduler] audit checkpoint failed", error); }
  }, 60_000);
  checkpointTimer.unref();
  // 每 10 分钟清理一次过期崩溃记录，避免长期运行把库撑大。
  pruneTimer = setInterval(() => {
    try {
      const db = useDatabase();
      db.transaction(() => pruneCrashReports(db)).immediate();
    } catch (error) { console.error("[scheduler] crash prune failed", error); }
  }, 600_000);
  pruneTimer.unref();
  // 每 60 秒看一眼是否到了上游版本检查的间隔；启动后第一分钟就会做第一次检查。
  upstreamTimer = setInterval(() => { void runUpstreamCheck(); }, 60_000);
  upstreamTimer.unref();
}

export function stopTaskScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
  if (checkpointTimer) { clearInterval(checkpointTimer); checkpointTimer = null; }
  if (pruneTimer) { clearInterval(pruneTimer); pruneTimer = null; }
  if (upstreamTimer) { clearInterval(upstreamTimer); upstreamTimer = null; }
  started = false;
}