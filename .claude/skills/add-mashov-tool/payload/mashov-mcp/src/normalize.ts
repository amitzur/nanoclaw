/**
 * Compact, whitelisted views of Mashov payloads. Only the listed fields are
 * passed through, long strings are truncated, and lists are capped, so an
 * unexpected field (an id, an e-mail address, a mailbox body) never leaks into
 * a tool result just because Mashov started returning it.
 */
import type { Child } from './mashov-client.js';

export const MAX_ITEMS = 100;
export const MAX_TEXT = 500;

type Rec = Record<string, unknown>;

export function text(v: unknown, max = MAX_TEXT): string | undefined {
  if (v === undefined || v === null) return undefined;
  let s = typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : undefined;
  if (s === undefined) return undefined;
  s = s
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return undefined;
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** First non-empty of several candidate keys. */
function pick(r: Rec, keys: string[], max = MAX_TEXT): string | undefined {
  for (const k of keys) {
    const v = text(r[k], max);
    if (v !== undefined) return v;
  }
  return undefined;
}

/** "2025-11-03T00:00:00" -> "2025-11-03"; keeps a time when it is meaningful. */
export function day(v: unknown): string | undefined {
  const s = text(v, 40);
  if (!s) return undefined;
  const m = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?/.exec(s);
  if (!m) return s;
  return m[2] && m[2] !== '00:00' ? `${m[1]} ${m[2]}` : m[1];
}

function compact<T extends Rec>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === undefined || o[k] === '') delete o[k];
  return o;
}

function records(raw: unknown): Rec[] {
  if (Array.isArray(raw)) return raw.filter((x): x is Rec => !!x && typeof x === 'object');
  if (raw && typeof raw === 'object') {
    const r = raw as Rec;
    for (const k of ['items', 'data', 'results']) if (Array.isArray(r[k])) return records(r[k]);
  }
  return [];
}

export interface Listed<T> {
  items: T[];
  total: number;
  truncated?: true;
}

function cap<T>(items: T[], max = MAX_ITEMS): Listed<T> {
  return items.length > max
    ? { items: items.slice(0, max), total: items.length, truncated: true }
    : { items, total: items.length };
}

// ── children ────────────────────────────────────────────────────────────────

export function childLabel(c: Child): string {
  const cls = c.classCode ? `${c.classCode}${c.classNum}` : '';
  return cls ? `${c.firstName} (${cls})` : c.firstName;
}

export function childView(c: Child): { name: string; class?: string } {
  return compact({ name: c.firstName, class: c.classCode ? `${c.classCode}${c.classNum}` : undefined });
}

export class ChildSelectionError extends Error {}

/**
 * Resolve the optional `child` argument. Omitted -> every child. Otherwise the
 * first name (case-insensitive, whitespace-trimmed); a class suffix like
 * "Noa (ה2)" or "Noa ה2" disambiguates siblings with the same first name.
 */
export function resolveChildren(children: Child[], query?: string): Child[] {
  if (query === undefined || query.trim() === '' || query.trim().toLowerCase() === 'all') return children;
  const norm = (s: string) => s.normalize('NFC').toLowerCase().replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();
  const q = norm(query);
  const full = (c: Child) => norm(`${c.firstName} ${c.classCode}${c.classNum}`);
  const byFull = children.filter((c) => full(c) === q);
  if (byFull.length === 1) return byFull;
  const byFirst = children.filter((c) => norm(c.firstName) === q);
  if (byFirst.length === 1) return byFirst;
  const byFamily = children.filter((c) => norm(`${c.firstName} ${c.familyName}`) === q);
  if (byFamily.length === 1) return byFamily;
  const names = children.map(childLabel).join(', ');
  if (byFirst.length > 1) throw new ChildSelectionError(`More than one child matches "${query}". Use one of: ${names}`);
  const byPrefix = children.filter((c) => norm(c.firstName).startsWith(q));
  if (byPrefix.length === 1) return byPrefix;
  throw new ChildSelectionError(`No child matches "${query}". Children: ${names}`);
}

// ── resources ───────────────────────────────────────────────────────────────

export interface HomeworkItem {
  date?: string;
  lesson?: string;
  subject?: string;
  homework?: string;
  remark?: string;
}

export function normalizeHomework(raw: unknown): Listed<HomeworkItem> {
  const items = records(raw)
    .map((r) =>
      compact({
        date: day(r.lessonDate),
        lesson: text(r.lesson, 10),
        subject: pick(r, ['subjectName', 'groupName'], 80),
        homework: text(r.homework),
        remark: text(r.remark),
      }),
    )
    .filter((h) => h.homework || h.remark)
    .sort((a, b) => (a.date ?? '').localeCompare(b.date ?? '') || Number(a.lesson ?? 0) - Number(b.lesson ?? 0));
  return cap(items);
}

export interface BehaviorItem {
  date?: string;
  lesson?: string;
  subject?: string;
  event?: string;
  justified?: boolean;
  justification?: string;
  reporter?: string;
}

export function normalizeBehavior(raw: unknown): Listed<BehaviorItem> {
  const items = records(raw)
    .map((r) => {
      const j = r.justified;
      // Mashov uses -1 / 0 for "not justified" and a positive code for justified.
      const justified = typeof j === 'boolean' ? j : typeof j === 'number' ? j > 0 : undefined;
      return compact({
        date: day(r.lessonDate ?? r.timestamp),
        lesson: text(r.lesson, 10),
        subject: pick(r, ['subject', 'subjectName', 'groupName'], 80),
        event: pick(r, ['achvaName'], 120),
        justified,
        justification: text(r.justification, 120),
        reporter: pick(r, ['reporter', 'lessonReporter'], 80),
      }) as BehaviorItem;
    })
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
  return cap(items);
}

export interface GradeItem {
  date?: string;
  subject?: string;
  event?: string;
  grade?: string;
  type?: string;
  teacher?: string;
}

export function normalizeGrades(raw: unknown, since?: string): Listed<GradeItem> {
  const items = records(raw)
    .map(
      (r) =>
        compact({
          date: day(r.eventDate ?? r.gradingEventDate ?? r.timestamp),
          subject: pick(r, ['subjectName', 'groupName'], 80),
          event: pick(r, ['gradingEvent', 'gradingEventName'], 120),
          grade: pick(r, ['grade', 'textualGrade', 'rangeGrade'], 40),
          type: pick(r, ['gradeType', 'gradingPeriod'], 40),
          teacher: pick(r, ['teacherName'], 80),
        }) as GradeItem,
    )
    .filter((g) => g.grade !== undefined)
    .filter((g) => !since || (g.date ?? '') >= since)
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
  return cap(items);
}

export interface TimetableItem {
  day: number;
  lesson: number;
  subject?: string;
  teacher?: string;
  room?: string;
}

export function normalizeTimetable(raw: unknown): Listed<TimetableItem> {
  const items: TimetableItem[] = [];
  for (const r of records(raw)) {
    const tt = (r.timeTable ?? {}) as Rec;
    const gd = (r.groupDetails ?? {}) as Rec;
    const dayNum = Number(tt.day);
    const lesson = Number(tt.lesson);
    if (!Number.isFinite(dayNum) || !Number.isFinite(lesson)) continue;
    const teachers = Array.isArray(gd.groupTeachers)
      ? (gd.groupTeachers as Rec[])
          .map((t) => text(t?.teacherName, 60))
          .filter(Boolean)
          .join(', ')
      : undefined;
    items.push(
      compact({
        day: dayNum,
        lesson,
        subject: pick(gd, ['subjectName', 'groupName'], 80),
        teacher: teachers || undefined,
        room: text(tt.roomNum, 20),
      }) as TimetableItem,
    );
  }
  items.sort((a, b) => a.day - b.day || a.lesson - b.lesson);
  return cap(items, 200);
}

export interface NoticeItem {
  date?: string;
  title?: string;
  text?: string;
  from?: string;
}

/**
 * The message board's field names are undocumented, so this accepts a few
 * likely spellings and drops everything else.
 */
export function normalizeNotices(raw: unknown): Listed<NoticeItem> {
  const items = records(raw)
    .map((r0) => {
      const r = (r0.message && typeof r0.message === 'object' ? r0.message : r0) as Rec;
      return compact({
        date: day(r.startDate ?? r.publishDate ?? r.creationDate ?? r.date ?? r.timestamp),
        title: pick(r, ['title', 'subject', 'header', 'messageTitle'], 160),
        text: pick(r, ['body', 'text', 'content', 'messageText', 'message'], MAX_TEXT),
        from: pick(r, ['senderName', 'author', 'teacherName', 'sender'], 80),
      }) as NoticeItem;
    })
    .filter((n) => n.title || n.text)
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
  return cap(items, 30);
}

export interface HolidayItem {
  name?: string;
  start?: string;
  end?: string;
}

export function normalizeHolidays(raw: unknown, fromDay?: string): Listed<HolidayItem> {
  const items = records(raw)
    .map(
      (r) =>
        compact({
          name: pick(r, ['hollyDayName', 'holidayName', 'name'], 120),
          start: day(r.startDate),
          end: day(r.endDate ?? r.startDate),
        }) as HolidayItem,
    )
    .filter((h) => !fromDay || (h.end ?? h.start ?? '') >= fromDay)
    .sort((a, b) => (a.start ?? '').localeCompare(b.start ?? ''));
  return cap(items);
}

/** Only the two counters; never subjects, senders, or bodies. */
export function normalizeMailCounts(raw: unknown): { unread?: number; inbox?: number } {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Rec;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  return compact({ unread: n(r.unreadConversations), inbox: n(r.inboxConversations) });
}
