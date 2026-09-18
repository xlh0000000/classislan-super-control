// 周期任务规则的下次触发时刻计算。时刻按“本地墙钟 + 固定时区偏移”求值，
// 结果一律以 UTC ISO 落库；纯函数便于单测覆盖跨月、闰年、错过窗口等边界。

export type ScheduleRepeat = "daily" | "weekly" | "monthly" | "interval";

export type ScheduleRule = {
  repeat: ScheduleRepeat;
  /** daily/weekly/monthly 的本地触发时刻 HH:mm。 */
  timeOfDay?: string | null;
  /** weekly 的星期集合：1=周一 … 7=周日。 */
  weekdays?: number[] | null;
  /** monthly 的几号；当月无该日（如 2 月 30）则跳过该月。 */
  dayOfMonth?: number | null;
  /** interval 的步长分钟。 */
  intervalMinutes?: number | null;
  /** 本地时区相对 UTC 的分钟偏移；中国大陆为 +480。 */
  tzOffsetMinutes: number;
  startAt: string;
  endAt?: string | null;
  /** interval 以上一次执行为锚点；其余规则忽略。 */
  lastRunAt?: string | null;
};

const MINUTE = 60_000;

function parseTimeOfDay(value: string | null | undefined): { hour: number; minute: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value ?? "");
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

/** 把本地墙钟分量折算成 UTC 毫秒。 */
function localToUtc(offsetMinutes: number, year: number, month: number, day: number, hour: number, minute: number) {
  return Date.UTC(year, month, day, hour, minute) - offsetMinutes * MINUTE;
}

/** 取某 UTC 时刻在本地时区的日历分量。 */
function utcToLocalParts(offsetMinutes: number, utcMs: number) {
  const local = new Date(utcMs + offsetMinutes * MINUTE);
  return { year: local.getUTCFullYear(), month: local.getUTCMonth(), day: local.getUTCDate(), hour: local.getUTCHours(), minute: local.getUTCMinutes() };
}

/**
 * fromIso（含）之后、规则允许的最早一次触发；超出 endAt 或未开始完的窗口返回 null。
 * 长期停机后只补触发一次：调用方总以“现在”为 from，下一次直接从未来算起。
 */
export function nextOccurrence(rule: ScheduleRule, fromIso: string): string | null {
  const from = Date.parse(fromIso);
  const start = Date.parse(rule.startAt);
  const end = rule.endAt ? Date.parse(rule.endAt) : Infinity;
  if (!Number.isFinite(from) || !Number.isFinite(start)) return null;
  let floor = Math.max(from, start);
  if (floor > end) return null;

  if (rule.repeat === "interval") {
    const step = Math.max(1, rule.intervalMinutes ?? 0) * MINUTE;
    if (step <= MINUTE) return null;
    const anchor = rule.lastRunAt ? Date.parse(rule.lastRunAt) : start;
    let next = Number.isFinite(anchor) ? anchor : start;
    // 从锚点滚动到 floor 之后；若 lastRunAt 与 floor 差距过大，用取模一步到位。
    if (next <= floor) {
      const skipped = Math.floor((floor - next) / step);
      next += skipped * step;
    }
    while (next <= floor) next += step;
    return next > end ? null : new Date(next).toISOString();
  }

  const time = parseTimeOfDay(rule.timeOfDay) ?? { hour: 0, minute: 0 };
  const offset = rule.tzOffsetMinutes;

  if (rule.repeat === "monthly") {
    const day = rule.dayOfMonth ?? 1;
    let { year, month } = utcToLocalParts(offset, floor);
    for (let i = 0; i < 25; i++) {
      // 当月无该日则跳过整月，而不是折算到月末，避免语义漂移成“每月最后一天”。
      const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
      if (day <= daysInMonth) {
        const candidate = localToUtc(offset, year, month, day, time.hour, time.minute);
        if (candidate >= floor) return candidate > end ? null : new Date(candidate).toISOString();
      }
      month += 1;
      if (month > 11) { month = 0; year += 1; }
    }
    return null;
  }

  let cursor = toLocalParts(offset, floor);
  let candidate = localToUtc(offset, cursor.year, cursor.month, cursor.day, time.hour, time.minute);
  if (candidate < floor) {
    cursor = advanceLocalDay(cursor);
    candidate = localToUtc(offset, cursor.year, cursor.month, cursor.day, time.hour, time.minute);
  }
  for (let i = 0; i < 400; i++) {
    if (candidate > end) return null;
    if (rule.repeat === "daily" || (rule.weekdays ?? []).includes(cursor.dayOfWeek))
      return new Date(candidate).toISOString();
    cursor = advanceLocalDay(cursor);
    candidate = localToUtc(offset, cursor.year, cursor.month, cursor.day, time.hour, time.minute);
  }
  return null;
}

type LocalParts = { year: number; month: number; day: number; dayOfWeek: number };

/** 取某 UTC 时刻在本地时区的日历分量（含星期，1=周一…7=周日）。 */
function toLocalParts(offsetMinutes: number, utcMs: number): LocalParts {
  const local = new Date(utcMs + offsetMinutes * MINUTE);
  return {
    year: local.getUTCFullYear(), month: local.getUTCMonth(), day: local.getUTCDate(),
    dayOfWeek: (local.getUTCDay() + 6) % 7 + 1,
  };
}

function advanceLocalDay(parts: LocalParts): LocalParts {
  // 本地日历直接加一天（用 UTC 日历运算，偏移恒定时无跨夏令时歧义）。
  const next = new Date(Date.UTC(parts.year, parts.month, parts.day + 1));
  return {
    year: next.getUTCFullYear(), month: next.getUTCMonth(), day: next.getUTCDate(),
    dayOfWeek: (next.getUTCDay() + 6) % 7 + 1,
  };
}

/** 校验规则本身是否自洽，供创建/更新入口复用。 */
export function validateScheduleRule(rule: ScheduleRule): string | null {
  if (rule.repeat !== "interval" && !parseTimeOfDay(rule.timeOfDay ?? null))
    return `${rule.repeat} 规则需要合法的 time_of_day（HH:mm）。`;
  if (rule.repeat === "weekly" && (!rule.weekdays?.length || rule.weekdays.some((d) => d < 1 || d > 7)))
    return "weekly 规则需要 weekdays（1-7 的星期集合）。";
  if (rule.repeat === "monthly" && (!rule.dayOfMonth || rule.dayOfMonth < 1 || rule.dayOfMonth > 31))
    return "monthly 规则需要 day_of_month（1-31）。";
  if (rule.repeat === "interval" && (!rule.intervalMinutes || rule.intervalMinutes < 5 || rule.intervalMinutes > 20160))
    return "interval 规则需要 5..20160 分钟步长。";
  if (Date.parse(rule.startAt) !== Date.parse(rule.startAt)) return "start_at 不是合法时间。";
  if (rule.endAt && Date.parse(rule.endAt) <= Date.parse(rule.startAt)) return "end_at 必须晚于 start_at。";
  return null;
}
