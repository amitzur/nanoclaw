import { describe, expect, it } from 'vitest';

import type { Child } from '../src/mashov-client.js';
import {
  ChildSelectionError,
  normalizeBehavior,
  normalizeGrades,
  normalizeHolidays,
  normalizeHomework,
  normalizeMailCounts,
  normalizeNotices,
  normalizeTimetable,
  resolveChildren,
  text,
} from '../src/normalize.js';
import { DATA } from './fake-mashov.js';

const kid = (firstName: string, classCode: string, classNum: string, guid = firstName): Child => ({
  guid,
  firstName,
  familyName: 'Testfamily',
  classCode,
  classNum,
});
const kids = [kid('Alef', 'ג', '2'), kid('Bet', 'ה', '1')];

describe('resolveChildren', () => {
  it('returns every child when omitted or "all"', () => {
    expect(resolveChildren(kids)).toHaveLength(2);
    expect(resolveChildren(kids, '  ')).toHaveLength(2);
    expect(resolveChildren(kids, 'ALL')).toHaveLength(2);
  });
  it('matches first name case-insensitively and by prefix', () => {
    expect(resolveChildren(kids, ' alef ')[0].firstName).toBe('Alef');
    expect(resolveChildren(kids, 'Be')[0].firstName).toBe('Bet');
    expect(resolveChildren(kids, 'Alef Testfamily')[0].firstName).toBe('Alef');
  });
  it('disambiguates same-name siblings by class', () => {
    const twins = [kid('Gimel', 'ב', '1', 'g1'), kid('Gimel', 'ב', '3', 'g2')];
    expect(() => resolveChildren(twins, 'gimel')).toThrow(ChildSelectionError);
    expect(resolveChildren(twins, 'Gimel (ב3)')[0].guid).toBe('g2');
  });
  it('errors on unknown names, listing labels but never guids', () => {
    const err = (() => {
      try {
        resolveChildren([kid('Alef', 'ג', '2', 'secret-guid')], 'Zayin');
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err).toBeInstanceOf(ChildSelectionError);
    expect(err!.message).toContain('Alef (ג2)');
    expect(err!.message).not.toContain('secret-guid');
  });
});

describe('normalizers', () => {
  it('text strips html and truncates', () => {
    expect(text('<b>hi</b>&nbsp;there')).toBe('hi there');
    expect(text('x'.repeat(600))!.length).toBe(500);
  });
  it('homework drops ids and empty rows, sorts by date', () => {
    const r = normalizeHomework(DATA.homework);
    expect(r.items).toEqual([
      { date: '2026-11-08', lesson: '1', subject: 'English', homework: 'Read chapter 3' },
      { date: '2026-11-09', lesson: '2', subject: 'Math', homework: 'Page 12, ex. 1-4' },
    ]);
    expect(JSON.stringify(r)).not.toMatch(/guid|groupId|lessonId/);
  });
  it('behavior maps justified codes', () => {
    expect(normalizeBehavior(DATA.behave).items[0]).toEqual({
      date: '2026-11-02',
      lesson: '1',
      subject: 'Math',
      event: 'Late',
      justified: false,
      reporter: 'T. Teacher',
    });
  });
  it('grades: newest first, ungraded dropped, since filter', () => {
    expect(normalizeGrades(DATA.grades).items.map((g) => g.grade)).toEqual(['92', '85']);
    expect(normalizeGrades(DATA.grades, '2026-10-01').items).toHaveLength(1);
  });
  it('timetable sorted by day then lesson', () => {
    expect(normalizeTimetable(DATA.timetable).items).toEqual([
      { day: 1, lesson: 2, subject: 'Math', teacher: 'T. Teacher', room: '7' },
      { day: 2, lesson: 1, subject: 'English', teacher: 'V. Teacher', room: '12' },
    ]);
  });
  it('notices keep only whitelisted fields', () => {
    const r = normalizeNotices(DATA.messageBoard);
    expect(r.items).toEqual([
      { date: '2026-11-05', title: 'Trip on Thursday', text: 'Bring water and a hat.', from: 'School office' },
    ]);
  });
  it('holidays: upcoming filter and name variants', () => {
    expect(normalizeHolidays(DATA.holidays, '2026-11-10').items).toEqual([
      { name: 'Hanukkah', start: '2026-12-06', end: '2026-12-13' },
    ]);
    expect(normalizeHolidays(DATA.holidays).items[0].name).toBe('Past break');
  });
  it('mail counts never include subjects or bodies', () => {
    const m = normalizeMailCounts(DATA['mail/counts']);
    expect(m).toEqual({ unread: 3, inbox: 40 });
    expect(JSON.stringify(m)).not.toContain('MAIL BODY');
  });
  it('caps long lists', () => {
    const many = Array.from({ length: 150 }, (_, i) => ({ lessonDate: '2026-11-01', lesson: i, homework: `hw ${i}` }));
    const r = normalizeHomework(many);
    expect(r.items).toHaveLength(100);
    expect(r).toMatchObject({ total: 150, truncated: true });
  });
});
