/**
 * 科目快捷键：常驻科目墙上「数字直选 / 首字符直选」的匹配规则。
 * 数字 0 是「清空」，1-9 对应前 9 个科目；其余单字符按简称（缺省用名称）首字符匹配。
 */
export type ShortcutSubject = { id: string; name: string; initial: string };

export type SubjectShortcut = { clear: true } | { clear: false; id: string };

export function resolveSubjectShortcut(subjects: ShortcutSubject[], key: string): SubjectShortcut | null {
  if (key.length !== 1) return null;
  if (/^[0-9]$/.test(key)) {
    const index = Number(key);
    if (index === 0) return { clear: true };
    const subject = subjects[index - 1];
    return subject ? { clear: false, id: subject.id } : null;
  }
  const needle = key.toLowerCase();
  const subject = subjects.find((item) => (item.initial || item.name.slice(0, 1)).toLowerCase().startsWith(needle));
  return subject ? { clear: false, id: subject.id } : null;
}