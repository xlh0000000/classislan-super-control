/** 界面文案统一用中文标签，这里集中维护枚举值 → 中文的对照，模板里配 labelOf 使用。 */

export const TASK_STATE_LABELS: Record<string, string> = {
  scheduled: "待执行",
  running: "执行中",
  paused: "已暂停",
  cancelling: "撤回中",
  completed: "已完成",
  partial_failure: "部分失败",
  failed: "失败",
  expired: "已过期",
  cancelled: "已取消",
};

export const COMMAND_STATE_LABELS: Record<string, string> = {
  pending: "等待下发",
  offered: "已下发待确认",
  received: "设备已领取",
  running: "设备执行中",
  cancelling: "撤回中",
  succeeded: "成功",
  failed: "失败",
  conflict: "回执冲突",
  unsupported: "设备不支持",
  expired: "已过期",
  cancelled: "已取消",
};

export const BATCH_STATE_LABELS: Record<string, string> = {
  pending: "等待中",
  active: "下发中",
  succeeded: "已完成",
  failed: "有失败",
  cancelled: "已取消",
  expired: "已过期",
};

export const MODE_LABELS: Record<string, string> = {
  all: "一次全发",
  fixed: "固定批次",
  percent: "按比例分批",
};

export const REPEAT_LABELS: Record<string, string> = {
  daily: "每天",
  weekly: "按星期",
  monthly: "每月几号",
  interval: "固定间隔",
};

export const AUTO_TASK_STATE_LABELS: Record<string, string> = {
  active: "启用中",
  paused: "已暂停",
  finished: "已结束",
};

export const CAPABILITY_LABELS: Record<string, string> = {
  "notification.own-provider.send.v1": "远程提醒",
  "speech.queue.v1": "语音播报",
  "theme.app.transient.v1": "颜色主题",
  "weather.read-refresh.v1": "刷新天气",
  "exact-time.read-sync.v1": "同步网络时间",
  "time.offset.persist.v1": "时间偏移",
  "app.window.basic.volatile.v1": "显示 / 隐藏主窗口",
  "uri.navigate.v1": "打开 classisland 链接",
  "tutorial.control.v1": "教程控制",
  "app.lifecycle.v1": "重启 / 退出应用",
  "enrollment.release.v1": "解除集控",
};

export const ACTOR_TYPE_LABELS: Record<string, string> = {
  user: "管理员",
  device: "设备",
  system: "系统",
};

/** 策略文档顶层节名 → 中文，用于展示"这台设备合并了哪些配置内容"。 */
export const POLICY_SECTION_LABELS: Record<string, string> = {
  profile: "档案与课表",
  components: "组件布局",
  automation: "自动化工作流",
  plugin: "插件设置",
  settings: "设备设置",
  time: "时间偏移",
};

export const TARGET_TYPE_LABELS: Record<string, string> = {
  session: "登录会话",
  system: "系统",
  user: "用户",
  device: "设备",
  task: "任务",
  command: "命令",
  schedule: "周期调度",
  trigger: "事件触发",
  configuration: "配置",
  policy_revision: "策略",
  enrollment_token: "接入凭据",
  building: "楼栋",
  building_floor: "楼层",
  building_room: "教室",
  org_node: "组织节点",
  tag: "设备标签",
  rollcall_roster: "点名册",
  crash: "崩溃记录",
};

export const CRASH_KIND_LABELS: Record<string, string> = {
  "unhandled-exception": "未处理异常",
  "unobserved-task": "后台任务异常",
  "ui-thread": "界面线程异常",
  "host-exit": "程序退出",
};

export function labelOf(labels: Record<string, string>, value: string | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return labels[value] ?? value;
}

/** 修订号统一显示为“第 N 版”，不再用 R 前缀。 */
export function revisionLabel(revision: number | null | undefined): string {
  if (revision === null || revision === undefined) return "—";
  return `第 ${revision} 版`;
}
