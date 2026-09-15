/**
 * 课表快装：把从 Excel / CSV 粘贴进来的表格文本解析成 ClassIsland 档案里的科目、
 * 时间点与整周课表。解析、预览与写入都是纯函数，方便单测覆盖。
 */
import {
  WEEKDAYS,
  ensureClassPlan,
  findClassPlan,
  newSubject,
  toClock,
  type CiProfile,
  type CiSubject,
  type CiTimeLayout,
  type CiTimeLayoutItem,
} from "./classisland-profile";

export type QuickSetupMode = "overwrite" | "fill";

export type QuickPeriodRef =
  | { kind: "index"; index: number }
  | { kind: "time"; start: string; end: string };

export type QuickSetupInput = {
  text: string;
  layoutId: string;
  groupId: string;
  mode?: QuickSetupMode;
  /** 预览里手动改过的列 → 星期映射（按表格列下标，null 表示忽略该列）。 */
  weekDayByColumn?: Record<number, number | null>;
};

export type QuickSetupColumn = { column: number; weekDay: number | null; label: string };
export type QuickSetupRow = { row: number; label: string; index: number | null };

export type QuickSetupPreview = {
  grid: string[][];
  columns: QuickSetupColumn[];
  rows: QuickSetupRow[];
  subjects: { name: string; isNew: boolean }[];
  cells: number;
  skipped: number;
  newPeriods: number;
  messages: string[];
};

export type QuickSetupResult = {
  createdSubjects: number;
  createdPeriods: number;
  writtenCells: number;
  skippedCells: number;
};

const EMPTY_TOKENS = new Set(["", "-", "--", "—", "–", "/", "\\", "无", "空", "休", "n/a"]);

const CHINESE_DIGITS = ["日", "一", "二", "三", "四", "五", "六"];
const ENGLISH_WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

const WEEKDAY_ALIASES = new Map<string, number>();
for (const day of WEEKDAYS) {
  const digit = CHINESE_DIGITS[day.value] ?? "";
  const numeric = day.value === 0 ? "7" : String(day.value);
  const names = [`周${digit}`, `星期${digit}`, `礼拜${digit}`, `周${numeric}`, `星期${numeric}`, digit];
  if (day.value === 0) names.push("周天", "星期天", "礼拜天");
  for (const name of names) if (name) WEEKDAY_ALIASES.set(name, day.value);
  const english = ENGLISH_WEEKDAYS[day.value] ?? "";
  if (english) {
    WEEKDAY_ALIASES.set(english, day.value);
    WEEKDAY_ALIASES.set(english.slice(0, 3), day.value);
  }
}

const CN_DIGITS: Record<string, number> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};

/** 把「周一」「星期一」「Mon」之类的表头归一成 0-6 的星期值。 */
export function detectWeekday(value: string): number | null {
  const text = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[（(【[].*$/, "");
  if (!text) return null;
  return WEEKDAY_ALIASES.get(text) ?? null;
}

function chineseNumber(text: string): number | null {
  if (/^[一二三四五六七八九]$/.test(text)) return CN_DIGITS[text] ?? null;
  if (/^十[一二三四五六七八九]?$/.test(text)) return 10 + (CN_DIGITS[text.slice(1)] ?? 0);
  if (/^[一二三四五六七八九]十[一二三四五六七八九]?$/.test(text)) {
    const ones = text.length > 2 ? (CN_DIGITS[text[2]!] ?? 0) : 0;
    return (CN_DIGITS[text[0]!] ?? 0) * 10 + ones;
  }
  return null;
}

/** 识别「08:00-08:45」「第 3 节」「三」「3」这类节次。 */
export function detectPeriodRef(value: string): QuickPeriodRef | null {
  // 先去秒，ClassIsland 里常见「08:00:00-08:45:00」这类写法。
  const text = String(value ?? "")
    .trim()
    .replace(/(\d{1,2})\s*[:：]\s*(\d{2})\s*[:：]\s*\d{2}(?:\.\d+)?/g, "$1:$2");
  if (!text) return null;
  const range = /(\d{1,2})\s*[:：]\s*(\d{2})\s*(?:-|~|—|–|－|至|到)\s*(\d{1,2})\s*[:：]\s*(\d{2})/.exec(text);
  if (range) {
    return {
      kind: "time",
      start: toClock(`${range[1]}:${range[2]}`),
      end: toClock(`${range[3]}:${range[4]}`),
    };
  }
  const numbered = /^第?\s*(\d{1,2})\s*[节课时]?\s*$/.exec(text);
  if (numbered) {
    const index = Number(numbered[1]) - 1;
    return index >= 0 && index < 60 ? { kind: "index", index } : null;
  }
  const chinese = /^第?([一二三四五六七八九十]{1,3})[节课时]?$/.exec(text);
  if (chinese) {
    const index = chineseNumber(chinese[1]!) ?? 0;
    return index >= 1 && index <= 60 ? { kind: "index", index: index - 1 } : null;
  }
  return null;
}

/** 「语文(张三)」→ 科目名 + 任课教师。 */
export function parseSubjectCell(value: string): { name: string; teacherName: string } | null {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (EMPTY_TOKENS.has(text.toLowerCase())) return null;
  const matched = /^(.*?)\s*[（(]([^（()）]*)[)）]$/.exec(text);
  if (matched && matched[1]?.trim()) {
    return { name: matched[1].trim(), teacherName: (matched[2] ?? "").trim() };
  }
  return { name: text, teacherName: "" };
}

function detectDelimiter(lines: string[]): string {
  let best = "\t";
  let bestScore = 0;
  for (const candidate of ["\t", ",", "，", ";", "；"]) {
    let score = 0;
    for (const line of lines) for (const char of line) if (char === candidate) score += 1;
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}

function splitLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index]!;
    if (quoted) {
      if (char !== '"') current += char;
      else if (line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else quoted = false;
    } else if (char === '"' && !current.trim()) {
      quoted = true;
      current = "";
    } else if (char === delimiter) {
      cells.push(current);
      current = "";
    } else current += char;
  }
  cells.push(current);
  return cells.map((cell) => cell.trim());
}

/** 解析粘贴文本：自动嗅探制表符 / 半角逗号 / 全角逗号 / 分号，兼容 CSV 引号。 */
export function parseQuickTable(input: string): string[][] {
  const lines = String(input ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((line) => line.trim().length > 0);
  if (!lines.length) return [];
  const delimiter = detectDelimiter(lines);
  const grid = lines.map((line) => splitLine(line, delimiter));
  while (grid.length && grid[grid.length - 1]!.every((cell) => !cell)) grid.pop();
  return grid;
}

function transpose(grid: string[][]): string[][] {
  const width = grid.reduce((max, row) => Math.max(max, row.length), 0);
  return Array.from({ length: width }, (_, column) => grid.map((row) => row[column] ?? ""));
}

function countWeekdays(values: string[]): number {
  return values.filter((value) => detectWeekday(value) !== null).length;
}

export type QuickSetupAnalysis = {
  grid: string[][];
  transposed: boolean;
  headerRow: boolean;
  headerColumn: boolean;
};

/** 判断表格方向（星期在列还是行）、首行是否为星期表头、首列是否为节次。 */
export function analyzeQuickTable(grid: string[][]): QuickSetupAnalysis {
  if (!grid.length) return { grid: [], transposed: false, headerRow: false, headerColumn: false };
  const firstRow = grid[0] ?? [];
  const firstColumn = grid.map((row) => row[0] ?? "");
  const transposed = countWeekdays(firstColumn) >= 2 && countWeekdays(firstColumn) > countWeekdays(firstRow);
  const working = transposed ? transpose(grid) : grid;
  const headerRow = countWeekdays((working[0] ?? []).slice(1)) >= 1;
  const body = headerRow ? working.slice(1) : working;
  const periodCells = body.map((row) => row[0] ?? "");
  const recognized = periodCells.filter((value) => detectPeriodRef(value) !== null).length;
  const headerColumn = periodCells.length > 0 && recognized * 2 >= periodCells.length;
  return { grid: working, transposed, headerRow, headerColumn };
}

function headerText(analysis: QuickSetupAnalysis, column: number): string {
  return analysis.headerRow ? (analysis.grid[0]?.[column] ?? "").trim() : "";
}

function defaultEnd(start: string): string {
  const matched = /^(\d{1,2}):(\d{2})$/.exec(start);
  if (!matched) return start;
  const total = Math.min(23 * 60 + 59, Number(matched[1]) * 60 + Number(matched[2]) + 45);
  const clock = `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
  return clock;
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

function weekdayLabel(value: number): string {
  return WEEKDAYS.find((day) => day.value === value)?.label ?? "课表";
}

type ResolvedWrite = { weekDay: number; periodIndex: number; subjectKey: string };

type Resolved = {
  grid: string[][];
  columns: QuickSetupColumn[];
  rows: QuickSetupRow[];
  layout?: CiTimeLayout;
  newItems: CiTimeLayoutItem[];
  writes: ResolvedWrite[];
  skipped: number;
  newSubjects: { name: string; teacherName: string; initial: string }[];
  teacherFills: { name: string; teacherName: string }[];
  messages: string[];
};

/** 把表格解析成落库前的一套完整计划，预览与写入共用，保证两边口径一致。 */
function resolveQuickSetup(profile: CiProfile, input: QuickSetupInput): Resolved {
  const analysis = analyzeQuickTable(parseQuickTable(input.text));
  const grid = analysis.grid;
  const messages: string[] = [];
  const layout = profile.timeLayouts.find((item) => item.id === input.layoutId) ?? profile.timeLayouts[0];

  const columns: QuickSetupColumn[] = analysis.grid.length
    ? (analysis.grid[0] ?? []).map((_, column) => {
        if (column === 0 && analysis.headerColumn) return { column, weekDay: null, label: "节次" };
        const override = input.weekDayByColumn?.[column];
        const weekDay = override === undefined ? detectWeekday(headerText(analysis, column)) : override;
        return { column, weekDay: weekDay ?? null, label: headerText(analysis, column) };
      })
    : [];

  const body = analysis.headerRow ? grid.slice(1) : grid;
  const offset = analysis.headerRow ? 1 : 0;
  const refs: { ref: QuickPeriodRef | null; row: number }[] = body.map((row, index) => ({
    ref: analysis.headerColumn ? detectPeriodRef(row[0] ?? "") : { kind: "index", index },
    row: index + offset,
  }));

  // 先用「现有时间点 + 新增时间点」算出一份虚拟时间表，节次下标以它为准。
  const merged = layout ? [...layout.layouts] : [];
  const newItems: CiTimeLayoutItem[] = [];
  const timeItems = new Map<string, CiTimeLayoutItem>();
  for (const { ref } of refs) {
    if (!ref || ref.kind !== "time" || timeItems.has(ref.start)) continue;
    let item = merged.find((candidate) => candidate.timeType === 0 && toClock(candidate.startTime) === ref.start);
    if (!item) {
      item = {
        startTime: ref.start,
        endTime: ref.end || defaultEnd(ref.start),
        timeType: 0,
        breakName: "",
        isHideDefault: false,
        defaultClassId: "",
        extra: {},
      };
      merged.push(item);
      newItems.push(item);
    }
    timeItems.set(ref.start, item);
  }

  const ordinals = new Map<CiTimeLayoutItem, number>();
  const sorted = [...merged].sort((left, right) => toClock(left.startTime).localeCompare(toClock(right.startTime)));
  let ordinal = 0;
  for (const item of sorted) if (item.timeType === 0) ordinals.set(item, ordinal++);
  const periodCount = ordinals.size;

  const rows: QuickSetupRow[] = refs.map(({ ref, row }) => {
    if (!ref) return { row, label: "", index: null };
    if (ref.kind === "index") {
      return { row, label: `第 ${ref.index + 1} 节`, index: ref.index < periodCount ? ref.index : null };
    }
    const item = timeItems.get(ref.start);
    return { row, label: `${ref.start}–${ref.end}`, index: item ? (ordinals.get(item) ?? null) : null };
  });

  const byName = new Map<string, CiSubject>();
  for (const subject of profile.subjects) byName.set(normalizeName(subject.name), subject);
  const newSubjects: Resolved["newSubjects"] = [];
  const teacherFills: Resolved["teacherFills"] = [];
  const writes: ResolvedWrite[] = [];
  let skipped = 0;

  for (const row of rows) {
    if (row.index === null) continue;
    for (const column of columns) {
      if (column.weekDay === null) continue;
      const parsed = parseSubjectCell(grid[row.row]?.[column.column] ?? "");
      if (!parsed) continue;
      const key = normalizeName(parsed.name);
      const existing = byName.get(key);
      if (!existing) {
        byName.set(key, {
          id: "",
          name: parsed.name,
          initial: parsed.name.slice(0, 1),
          teacherName: parsed.teacherName,
          isOutDoor: false,
          extra: {},
        });
        newSubjects.push({ name: parsed.name, teacherName: parsed.teacherName, initial: parsed.name.slice(0, 1) });
      } else if (parsed.teacherName && !existing.teacherName) {
        teacherFills.push({ name: existing.name, teacherName: parsed.teacherName });
      }
      const plan = findClassPlan(profile, input.groupId, column.weekDay);
      const occupied = Boolean(plan?.classes[row.index]?.subjectId);
      if (input.mode === "fill" && occupied) {
        skipped += 1;
        continue;
      }
      writes.push({ weekDay: column.weekDay, periodIndex: row.index, subjectKey: key });
    }
  }

  if (!grid.length) messages.push("粘贴框里还没有内容。");
  else {
    if (!columns.some((column) => column.weekDay !== null)) messages.push("没认出星期表头，首行需要是「周一」～「周日」。");
    if (!rows.some((row) => row.index !== null)) messages.push("没认出节次，首列需要是「第1节」或「08:00-08:45」。");
    if (analysis.transposed) messages.push("已按「行=星期、列=节次」的方向识别。");
  }

  return { grid, columns, rows, layout, newItems, writes, skipped, newSubjects, teacherFills, messages };
}

/** 预览：不修改档案，只回报会写入多少格、哪些科目是新的。 */
export function previewQuickSetup(profile: CiProfile, input: QuickSetupInput): QuickSetupPreview {
  const resolved = resolveQuickSetup(profile, input);
  return {
    grid: resolved.grid,
    columns: resolved.columns,
    rows: resolved.rows,
    subjects: resolved.newSubjects.map((subject) => ({ name: subject.name, isNew: true })),
    cells: resolved.writes.length,
    skipped: resolved.skipped,
    newPeriods: resolved.newItems.length,
    messages: resolved.messages,
  };
}

/** 写入：补齐科目与时间点，然后按模式把课表格子填上。直接改动传入的档案对象。 */
export function applyQuickSetup(profile: CiProfile, input: QuickSetupInput): QuickSetupResult {
  const resolved = resolveQuickSetup(profile, input);
  const index = new Map<string, string>();
  for (const subject of profile.subjects) index.set(normalizeName(subject.name), subject.id);

  for (const entry of resolved.newSubjects) {
    const subject = newSubject(entry.name);
    subject.initial = entry.initial;
    subject.teacherName = entry.teacherName;
    profile.subjects.push(subject);
    index.set(normalizeName(entry.name), subject.id);
  }
  for (const entry of resolved.teacherFills) {
    const subject = profile.subjects.find((item) => normalizeName(item.name) === normalizeName(entry.name));
    if (subject && !subject.teacherName) subject.teacherName = entry.teacherName;
  }

  if (resolved.layout && resolved.newItems.length) {
    resolved.layout.layouts.push(...resolved.newItems);
    resolved.layout.layouts.sort((left, right) => toClock(left.startTime).localeCompare(toClock(right.startTime)));
  }

  let writtenCells = 0;
  for (const write of resolved.writes) {
    const plan = ensureClassPlan(
      profile,
      input.groupId,
      write.weekDay,
      input.layoutId,
      `${weekdayLabel(write.weekDay)}课表`,
    );
    const info = plan.classes[write.periodIndex];
    const subjectId = index.get(write.subjectKey);
    if (!info || !subjectId) continue;
    info.subjectId = subjectId;
    writtenCells += 1;
  }

  return {
    createdSubjects: resolved.newSubjects.length,
    createdPeriods: resolved.newItems.length,
    writtenCells,
    skippedCells: resolved.skipped,
  };
}